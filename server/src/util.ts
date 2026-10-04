// HTTP / WebSocket の小物（応答の組み立て・乱数の ID）

import type { ErrorMessage, HttpErrorCode, ServerMessage, WsErrorCode } from "../../web/src/net/protocol";

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export const httpError = (status: number, code: HttpErrorCode, message: string): Response =>
  json({ error: { code, message } }, status);

/** ランダムなバイト列の base64url（パディングなし）。16 バイトで 22 文字、32 バイトで 43 文字 */
export function randomId(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 0 以上 n 未満の一様な整数 */
export function randomInt(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

/** 送れなくても（相手が切断済みなど）例外にしない */
export function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // 閉じかけの接続
  }
}

export const errorMsg = (code: WsErrorCode, message: string): ErrorMessage => ({ type: "error", code, message });

export function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // すでに閉じている
  }
}

/**
 * WebSocket を受けてすぐ error を送って閉じる（部屋がない など）。
 * ブラウザの WebSocket は HTTP の応答コードを読めないので、拒否も WebSocket の上で伝える
 */
export function rejectSocket(code: WsErrorCode, message: string, closeCode: number): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  send(server, errorMsg(code, message));
  closeQuietly(server, closeCode, code);
  return new Response(null, { status: 101, webSocket: client });
}
