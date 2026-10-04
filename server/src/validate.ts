// 外部入力（POST /rooms の本文・WebSocket のメッセージ）の検証。不正なものは例外を投げずに null / エラーを返す。

import { SIZE } from "../../web/src/engine/board";
import { cloneRules, PIECES, PRESETS, sameRules, type PieceKind, type RuleSet } from "../../web/src/engine/rules";
import type { ClientMessage, HostSeat, WsErrorCode } from "../../web/src/net/protocol";
import { MAX_MESSAGE_BYTES, TOKEN_PATTERN } from "../../web/src/net/protocol";
import { decodeRules, encodeRules } from "../../web/src/ui/query";

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * ルール設定の検証。共有 URL と同じ基準（ui/query.ts）で、エンコード → デコードして値が変わらないものだけを通す。
 * 型・範囲・列挙の外れ・欠けた項目はすべて不正。通したときはデコードした値（余計なキーを含まない複製）を返す
 */
export function parseRules(x: unknown): RuleSet | null {
  if (!isObject(x)) return null;
  try {
    const decoded = decodeRules(encodeRules(x as unknown as RuleSet));
    if (decoded.invalid.length > 0 || !sameRules(decoded.rules, x as unknown as RuleSet)) return null;
    return decoded.rules;
  } catch {
    // 項目が欠けていて encodeRules が読めない など
    return null;
  }
}

export function parseCreate(x: unknown): { rules: RuleSet; hostSeat: HostSeat } | null {
  if (!isObject(x)) return null;
  // rules と preset はどちらか一方
  if ((x.rules === undefined) === (x.preset === undefined)) return null;
  const preset = PRESETS.find((p) => p.id === x.preset);
  const rules = x.rules !== undefined ? parseRules(x.rules) : preset ? cloneRules(preset.rules) : null;
  if (!rules) return null;
  const seat = x.hostSeat ?? "random";
  if (seat !== "first" && seat !== "second" && seat !== "random") return null;
  return { rules, hostSeat: seat };
}

export type Parsed = { ok: true; msg: ClientMessage } | { ok: false; code: WsErrorCode; message: string };

const isCoord = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < SIZE;

/** WebSocket の 1 メッセージを読む */
export function parseClientMessage(data: string | ArrayBuffer): Parsed {
  if (typeof data !== "string") return { ok: false, code: "bad_message", message: "テキストのメッセージだけを受け付けます" };
  // 文字数が上限以下でも UTF-8 では最大 3 倍になるので、バイト数で測る
  if (data.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(data).length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: "too_large", message: `メッセージは ${MAX_MESSAGE_BYTES} バイトまでです` };
  }
  let x: unknown;
  try {
    x = JSON.parse(data);
  } catch {
    return { ok: false, code: "bad_json", message: "JSON として読めません" };
  }
  if (!isObject(x)) return { ok: false, code: "bad_message", message: "オブジェクトを送ってください" };
  const bad = (message: string): Parsed => ({ ok: false, code: "bad_message", message });
  switch (x.type) {
    case "join":
      if (x.token !== undefined && (typeof x.token !== "string" || !TOKEN_PATTERN.test(x.token))) return bad("token の形式が違います");
      return { ok: true, msg: x.token === undefined ? { type: "join" } : { type: "join", token: x.token } };
    case "move": {
      if (!isCoord(x.r) || !isCoord(x.c)) return bad(`r・c は 0〜${SIZE - 1} の整数です`);
      if (typeof x.kind !== "string" || !Object.hasOwn(PIECES, x.kind)) return bad("kind が駒の種類ではありません");
      if (x.king !== undefined && typeof x.king !== "boolean") return bad("king は true / false です");
      return { ok: true, msg: { type: "move", r: x.r, c: x.c, kind: x.kind as PieceKind, king: x.king === true } };
    }
    default:
      return bad("type は join / move です");
  }
}
