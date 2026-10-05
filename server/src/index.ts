// Worker の入口: /api の下のルーティング・Origin の確認・部屋の作成。対局の処理は部屋ごとの Durable Object（room.ts）に渡す。
// 画面（静的アセット）は wrangler.jsonc の assets が Worker を通さずに返す。ここに来るのは /api と、アセットにないパスだけ。
// エンドポイントと通信仕様は .agent/online-protocol.md。

import { API_PATH, CLOSE, MAX_CREATE_BYTES, ROOM_ID_PATTERN, type CreateRoomResponse } from "../../web/src/net/protocol";
import type { Room } from "./room";
import { httpError, json, randomId, rejectSocket } from "./util";
import { parseCreate } from "./validate";

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

const roomStub = (env: Env, roomId: string) =>
  (env.ROOMS as DurableObjectNamespace<Room>).get(env.ROOMS.idFromName(roomId));

async function createRoom(req: Request, env: Env): Promise<Response> {
  const text = await readCapped(req, MAX_CREATE_BYTES);
  if (text === null) return httpError(413, "too_large", `本文は ${MAX_CREATE_BYTES} バイトまでです`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return httpError(400, "bad_request", "本文が JSON として読めません");
  }
  const parsed = parseCreate(body);
  if (!parsed) return httpError(400, "bad_rules", "rules（RuleSet）・preset・hostSeat のどれかが不正です");
  // 部屋 ID は 128 ビットの乱数なので衝突はまず起きないが、起きたら作り直す
  for (let i = 0; i < 3; i++) {
    const roomId = randomId(16);
    const res: CreateRoomResponse | null = await roomStub(env, roomId).create(roomId, parsed.rules, parsed.hostSeat);
    if (res) return json(res, 201);
  }
  return httpError(500, "internal", "部屋を作れませんでした");
}

/** /api の下のルーティング。parts は /api を除いたパスの区切り（末尾スラッシュの有無は同じ扱い） */
async function route(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts.length === 1 && parts[0] === "health") return json({ ok: true });
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
