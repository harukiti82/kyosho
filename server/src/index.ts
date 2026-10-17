// Worker の入口: /api の下のルーティング・Origin の確認・部屋の作成。対局の処理は部屋ごとの Durable Object（room.ts）に渡す。
// 画面（静的アセット）は wrangler.jsonc の assets が Worker を通さずに返す。ここに来るのは /api と、アセットにないパスだけ。
// エンドポイントと通信仕様は .agent/online-protocol.md。

import {
  API_PATH,
  CLOSE,
  DEVICE_ID_PATTERN,
  DEVICE_LIMIT,
  DEVICE_WINDOW_MS,
  MATCH_LIMIT,
  MATCH_WINDOW_MS,
  MAX_CREATE_BYTES,
  ROOM_ID_PATTERN,
  type CreateRoomResponse,
  type DeviceResponse,
  type HealthResponse,
  type MatchResponse,
} from "../../web/src/net/protocol";
import { PHRASE_MAX } from "../../web/src/net/phrase";
import type { Endless } from "./endless";
import type { Lobby } from "./lobby";
import type { Ranking } from "./ranking";
import { httpError, json, randomId, rejectSocket, roomStub } from "./util";
import { parseCreate, parseMatch } from "./validate";

export { Endless } from "./endless";
export { Lobby } from "./lobby";
export { Ranking } from "./ranking";
export { Room } from "./room";

/** Origin が許可リスト（ALLOWED_ORIGINS）にあるか。"http://localhost:*" のように末尾 :* は任意のポート */
export function originAllowed(origin: string, list: string): boolean {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((allowed) => {
      if (!allowed.endsWith(":*")) return origin === allowed;
      const base = allowed.slice(0, -1);
      return origin.startsWith(base) && /^\d{1,5}$/.test(origin.slice(base.length));
    });
}

/** 本文を上限まで読む。超えたら null */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** 本文を上限まで読んで JSON にする。読めなければ HTTP のエラー応答 */
async function readBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  const text = await readCapped(req, MAX_CREATE_BYTES);
  if (text === null) return { ok: false, res: httpError(413, "too_large", `本文は ${MAX_CREATE_BYTES} バイトまでです`) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: httpError(400, "bad_request", "本文が JSON として読めません") };
  }
}

/**
 * e2e 用に追加で受ける制限時間（秒）。wrangler dev の --var TEST_TURN_SECONDS:2 のように渡したときだけ（本番の wrangler.jsonc にはない）。
 * 時間切れの自動の手を、待ち時間を長くせずに 2 つのブラウザで確かめるため
 */
function testTurnSeconds(env: Env): number | undefined {
  const n = Number((env as unknown as { TEST_TURN_SECONDS?: string }).TEST_TURN_SECONDS);
  return Number.isInteger(n) && n > 0 && n <= 90 ? n : undefined;
}

async function createRoom(req: Request, env: Env): Promise<Response> {
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const parsed = parseCreate(read.body, testTurnSeconds(env));
  if (!parsed) return httpError(400, "bad_rules", "rules（RuleSet）・preset・hostSeat・turnSeconds のどれかが不正です");
  // 部屋 ID は 128 ビットの乱数なので衝突はまず起きないが、起きたら作り直す
  for (let i = 0; i < 3; i++) {
    const roomId = randomId(16);
    const res: CreateRoomResponse | null = await roomStub(env, roomId).create(roomId, parsed.rules, parsed.hostSeat, parsed.turnSeconds);
    if (res) return json(res, 201);
  }
  return httpError(500, "internal", "部屋を作れませんでした");
}

/** 覚えておく接続元の数の上限（メモリを使いすぎない） */
const HITS_MAX = 10_000;

/**
 * 接続元ごとの回数の制限（window ミリ秒ごとに数え直す）。この Worker のインスタンスのメモリだけで数える軽い制限で、
 * インスタンスをまたいだ合計は数えない。ip が分からない（ローカル・テスト）なら数えない
 */
function limiter(window: number): (ip: string | null, now: number, limit: number) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (ip, now, limit) => {
    if (!ip) return true;
    const hit = hits.get(ip);
    if (hit && now < hit.resetAt) return ++hit.count <= limit;
    if (hits.size >= HITS_MAX) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      if (hits.size >= HITS_MAX) hits.clear();
    }
    hits.set(ip, { count: 1, resetAt: now + window });
    return true;
  };
}

/** POST /api/match（合言葉を次々に試す行為への制限。合言葉はここにも残さない） */
const matchHits = limiter(MATCH_WINDOW_MS);
/** POST /api/endless/devices（端末を作りまくってランキングを埋める行為への制限） */
const deviceHits = limiter(DEVICE_WINDOW_MS);

/** 接続元 ip の今回の POST /api/match を通すか。limit は MATCH_WINDOW_MS ごとの上限 */
export const allowMatch = (ip: string | null, now = Date.now(), limit = MATCH_LIMIT): boolean => matchHits(ip, now, limit);
/** 接続元 ip の今回の POST /api/endless/devices を通すか。limit は DEVICE_WINDOW_MS ごとの上限 */
export const allowDevice = (ip: string | null, now = Date.now(), limit = DEVICE_LIMIT): boolean => deviceHits(ip, now, limit);

/** 正規化した合言葉から受付の Durable Object の名前（SHA-256。合言葉そのものを名前にしない） */
export async function lobbyName(phrase: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kyosho:phrase:${phrase}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * e2e 用に POST /api/match の上限を上げる（wrangler dev の --var TEST_MATCH_LIMIT。本番の wrangler.jsonc にはない）。
 * wrangler dev ではどのブラウザも同じ接続元になり、e2e を続けて流すと 1 分の上限を超えるため
 */
function matchLimit(env: Env): number {
  const n = Number((env as unknown as { TEST_MATCH_LIMIT?: string }).TEST_MATCH_LIMIT);
  return Number.isInteger(n) && n > MATCH_LIMIT ? n : MATCH_LIMIT;
}

/** POST /api/match: 合言葉で待っている部屋を探し、なければ作る */
async function match(req: Request, env: Env): Promise<Response> {
  if (!allowMatch(req.headers.get("CF-Connecting-IP"), Date.now(), matchLimit(env))) {
    return httpError(429, "too_many_requests", "合言葉を続けて送りすぎです。少し待ってから試してください");
  }
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const parsed = parseMatch(read.body, testTurnSeconds(env));
  if (!parsed.ok) {
    return parsed.code === "bad_phrase"
      ? httpError(400, "bad_phrase", `合言葉は 1〜${PHRASE_MAX} 字で、制御文字などは使えません`)
      : httpError(400, "bad_rules", "rules（RuleSet）・preset・hostSeat・turnSeconds のどれかが不正です");
  }
  const lobbies = env.LOBBIES as DurableObjectNamespace<Lobby>;
  const lobby = lobbies.get(lobbies.idFromName(await lobbyName(parsed.phrase)));
  const res = (await lobby.match({ rules: parsed.rules, hostSeat: parsed.hostSeat, turnSeconds: parsed.turnSeconds })) as MatchResponse;
  return json(res, res.status === "wait" ? 201 : 200);
}

/** エンドレスマッチを使えるか（機能フラグ。var ENDLESS_ENABLED が "1"） */
export const endlessOn = (env: Env): boolean => (env as unknown as { ENDLESS_ENABLED?: string }).ENDLESS_ENABLED === "1";

const endlessStub = (env: Env, device: string) => {
  const ns = env.ENDLESS as DurableObjectNamespace<Endless>;
  return ns.get(ns.idFromName(device));
};
const rankingStub = (env: Env) => {
  const ns = env.RANKING as DurableObjectNamespace<Ranking>;
  return ns.get(ns.idFromName("global"));
};

/** e2e 用に端末の発行の上限を上げる（wrangler dev の --var TEST_DEVICE_LIMIT。本番の wrangler.jsonc にはない） */
function deviceLimit(env: Env): number {
  const n = Number((env as unknown as { TEST_DEVICE_LIMIT?: string }).TEST_DEVICE_LIMIT);
  return Number.isInteger(n) && n > DEVICE_LIMIT ? n : DEVICE_LIMIT;
}

/** 管理用のトークン（Secret ENDLESS_ADMIN_TOKEN）と Authorization: Bearer が一致するか。Secret がなければ常に false */
function adminAuthorized(req: Request, env: Env): boolean | null {
  const secret = (env as unknown as { ENDLESS_ADMIN_TOKEN?: string }).ENDLESS_ADMIN_TOKEN;
  if (!secret) return null;
  const got = req.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const enc = new TextEncoder();
  const a = enc.encode(got);
  const b = enc.encode(secret);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * /api/endless の下。parts は endless を除いたパスの区切り。
 * POST devices（端末の発行）/ GET devices/:id/ws（WebSocket）/ GET ranking（上位と自分の順位）/ admin/scores（管理用）
 */
async function endless(req: Request, env: Env, parts: string[]): Promise<Response> {
  const [head, id, tail] = parts;
  if (head === "devices" && parts.length === 1) {
    if (req.method !== "POST") return httpError(405, "method_not_allowed", "POST だけを受け付けます");
    if (!allowDevice(req.headers.get("CF-Connecting-IP"), Date.now(), deviceLimit(env))) {
      return httpError(429, "too_many_requests", "端末の登録が多すぎます。少し待ってから試してください");
    }
    for (let i = 0; i < 3; i++) {
      const device = randomId(16);
      const token = randomId(32);
      if (await endlessStub(env, device).register(device, token)) return json({ device, token } satisfies DeviceResponse, 201);
    }
    return httpError(500, "internal", "端末を登録できませんでした");
  }
  if (head === "devices" && parts.length === 3 && tail === "ws") {
    if (req.method !== "GET") return httpError(405, "method_not_allowed", "GET だけを受け付けます");
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return httpError(426, "upgrade_required", "WebSocket で接続してください");
    // 形式の違う ID では Durable Object を作らない。端末がないのとトークン違いは同じ答え
    if (!DEVICE_ID_PATTERN.test(id)) return rejectSocket("invalid_token", "端末のトークンが合いません", CLOSE.rejected);
    return endlessStub(env, id).fetch(req);
  }
  if (head === "ranking" && parts.length === 1) {
    if (req.method !== "GET") return httpError(405, "method_not_allowed", "GET だけを受け付けます");
    const device = new URL(req.url).searchParams.get("device");
    return json(await rankingStub(env).top(device !== null && DEVICE_ID_PATTERN.test(device) ? device : null));
  }
  if (head === "admin" && id === "scores" && parts.length <= 3) {
    const auth = adminAuthorized(req, env);
    if (auth === null) return httpError(404, "not_found", "そのパスはありません");
    if (!auth) return httpError(401, "unauthorized", "管理用のトークンが違います");
    if (parts.length === 2 && req.method === "GET") {
      return json(await rankingStub(env).adminList(new URL(req.url).searchParams.get("q") ?? ""));
    }
    if (parts.length === 3 && req.method === "DELETE" && DEVICE_ID_PATTERN.test(tail)) {
      const removed = await rankingStub(env).remove(tail, new URL(req.url).searchParams.get("block") === "1");
      return json({ removed });
    }
    if (parts.length === 3 && req.method === "POST" && DEVICE_ID_PATTERN.test(tail) && new URL(req.url).searchParams.get("unblock") === "1") {
      await rankingStub(env).unblock(tail);
      return json({ unblocked: true });
    }
    return httpError(405, "method_not_allowed", "GET（一覧）・DELETE（消す）だけを受け付けます");
  }
  return httpError(404, "not_found", "そのパスはありません");
}

/** /api の下のルーティング。parts は /api を除いたパスの区切り（末尾スラッシュの有無は同じ扱い） */
async function route(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts.length === 1 && parts[0] === "health") return json((endlessOn(env) ? { ok: true, endless: true } : { ok: true }) satisfies HealthResponse);
  // エンドレスマッチ。機能フラグが off なら、ほかの存在しないパスと同じ 404（Durable Object は起こさない）
  if (parts[0] === "endless") {
    if (!endlessOn(env)) return httpError(404, "not_found", "そのパスはありません");
    return endless(req, env, parts.slice(1));
  }
  // POST /api/match（合言葉）
  if (parts.length === 1 && parts[0] === "match") {
    if (req.method !== "POST") return httpError(405, "method_not_allowed", "POST だけを受け付けます");
    return match(req, env);
  }
  if (parts[0] !== "rooms" || parts.length > 3) return httpError(404, "not_found", "そのパスはありません");

  // POST /api/rooms
  if (parts.length === 1) {
    if (req.method !== "POST") return httpError(405, "method_not_allowed", "POST だけを受け付けます");
    return createRoom(req, env);
  }

  const roomId = parts[1];
  const valid = ROOM_ID_PATTERN.test(roomId);
  // GET /api/rooms/:id/ws（WebSocket）
  if (parts.length === 3) {
    if (parts[2] !== "ws") return httpError(404, "not_found", "そのパスはありません");
    if (req.method !== "GET") return httpError(405, "method_not_allowed", "GET だけを受け付けます");
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return httpError(426, "upgrade_required", "WebSocket で接続してください");
    }
    // 形式が違う ID では Durable Object を作らない
    if (!valid) return rejectSocket("room_not_found", "部屋がありません", CLOSE.notFound);
    return roomStub(env, roomId).fetch(req);
  }

  // GET /api/rooms/:id
  if (req.method !== "GET") return httpError(405, "method_not_allowed", "GET だけを受け付けます");
  const info = valid ? await roomStub(env, roomId).info() : null;
  return info ? json(info) : httpError(404, "not_found", "部屋がありません");
}

/** /api の下なら、/api を除いたパスの区切り。/api の外なら null */
export function apiParts(pathname: string): string[] | null {
  if (pathname !== API_PATH && !pathname.startsWith(`${API_PATH}/`)) return null;
  return pathname.slice(API_PATH.length).split("/").filter((s) => s.length > 0);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const parts = apiParts(url.pathname);
    // アセットにないパス（画面の存在しないファイルなど）。Durable Object は起こさない
    if (parts === null) {
      return new Response("ページが見つかりません", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // 画面と同じオリジンだけを受ける（CORS のヘッダーは返さない）。ブラウザは POST と WebSocket に Origin を必ず付ける。
    // 付いていない（スクリプト・curl など）なら通す
    const origin = req.headers.get("Origin");
    if (origin !== null && origin !== url.origin && !originAllowed(origin, env.ALLOWED_ORIGINS)) {
      return httpError(403, "forbidden_origin", "このオリジンからは接続できません");
    }
    try {
      return await route(req, env, parts);
    } catch (e) {
      console.error(e);
      return httpError(500, "internal", "サーバーの内部エラー");
    }
  },
} satisfies ExportedHandler<Env>;
