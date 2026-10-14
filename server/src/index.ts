// Worker の入口: /api の下のルーティング・Origin の確認・部屋の作成。対局の処理は部屋ごとの Durable Object（room.ts）に渡す。
// 画面（静的アセット）は wrangler.jsonc の assets が Worker を通さずに返す。ここに来るのは /api と、アセットにないパスだけ。
// エンドポイントと通信仕様は .agent/online-protocol.md。

import {
  API_PATH,
  CLOSE,
  MATCH_LIMIT,
  MATCH_WINDOW_MS,
  MAX_CREATE_BYTES,
  ROOM_ID_PATTERN,
  type CreateRoomResponse,
  type MatchResponse,
} from "../../web/src/net/protocol";
import type { Lobby } from "./lobby";
import { httpError, json, randomId, rejectSocket, roomStub } from "./util";
import { parseCreate, parseMatch } from "./validate";

export { Lobby } from "./lobby";
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

/**
 * 接続元ごとの POST /api/match の回数（MATCH_WINDOW_MS ごとに数え直す）。合言葉を次々に試す行為への軽い制限で、
 * この Worker のインスタンスのメモリだけで数える（インスタンスをまたいだ合計は数えない）。合言葉はここにも残さない
 */
const matchHits = new Map<string, { count: number; resetAt: number }>();
/** 覚えておく接続元の数の上限（メモリを使いすぎない） */
const MATCH_HITS_MAX = 10_000;

/** 接続元 ip の今回の POST /api/match を通すか。ip が分からない（ローカル・テスト）なら数えない */
export function allowMatch(ip: string | null, now = Date.now()): boolean {
  if (!ip) return true;
  const hit = matchHits.get(ip);
  if (hit && now < hit.resetAt) return ++hit.count <= MATCH_LIMIT;
  if (matchHits.size >= MATCH_HITS_MAX) {
    for (const [k, v] of matchHits) if (now >= v.resetAt) matchHits.delete(k);
    if (matchHits.size >= MATCH_HITS_MAX) matchHits.clear();
  }
  matchHits.set(ip, { count: 1, resetAt: now + MATCH_WINDOW_MS });
  return true;
}

/** 正規化した合言葉から受付の Durable Object の名前（SHA-256。合言葉そのものを名前にしない） */
export async function lobbyName(phrase: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kyosho:phrase:${phrase}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST /api/match: 合言葉で待っている部屋を探し、なければ作る */
async function match(req: Request, env: Env): Promise<Response> {
  if (!allowMatch(req.headers.get("CF-Connecting-IP"))) {
    return httpError(429, "too_many_requests", "合言葉を続けて送りすぎです。少し待ってから試してください");
  }
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const parsed = parseMatch(read.body, testTurnSeconds(env));
  if (!parsed.ok) {
    return parsed.code === "bad_phrase"
      ? httpError(400, "bad_phrase", "合言葉は 1〜20 字で、制御文字などは使えません")
      : httpError(400, "bad_rules", "rules（RuleSet）・preset・hostSeat・turnSeconds のどれかが不正です");
  }
  const lobbies = env.LOBBIES as DurableObjectNamespace<Lobby>;
  const lobby = lobbies.get(lobbies.idFromName(await lobbyName(parsed.phrase)));
  const res = (await lobby.match({ rules: parsed.rules, hostSeat: parsed.hostSeat, turnSeconds: parsed.turnSeconds })) as MatchResponse;
  return json(res, res.status === "wait" ? 201 : 200);
}

/** /api の下のルーティング。parts は /api を除いたパスの区切り（末尾スラッシュの有無は同じ扱い） */
async function route(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts.length === 1 && parts[0] === "health") return json({ ok: true });
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
