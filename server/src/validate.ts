// 外部入力（POST /api/rooms の本文・WebSocket のメッセージ）の検証。不正なものは例外を投げずに null / エラーを返す。

import { SIZE } from "../../web/src/engine/board";
import { cloneRules, PIECES, PRESETS, sameRules, type PieceKind, type RuleSet } from "../../web/src/engine/rules";
import { SKILLS, type SkillId } from "../../web/src/engine/skills";
import { ENDLESS_CPUS, type EndlessCpu } from "../../web/src/engine/endless";
import { LIMITS } from "../../web/src/engine/rules";
import type { ClientMessage, EndlessClientMessage, HostSeat, WsErrorCode } from "../../web/src/net/protocol";
import { MAX_MESSAGE_BYTES, TOKEN_PATTERN, TURN_SECONDS } from "../../web/src/net/protocol";
import { normalizeName } from "../../web/src/net/name";
import { normalizePhrase } from "../../web/src/net/phrase";
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

/**
 * POST /api/rooms の本文。turnSeconds は TURN_SECONDS のどれか（省略は 0 = 制限なし）。
 * testSeconds は e2e 用に追加で受ける秒数（wrangler dev の --var TEST_TURN_SECONDS。本番の設定にはない）
 */
export function parseCreate(x: unknown, testSeconds?: number): { rules: RuleSet; hostSeat: HostSeat; turnSeconds: number } | null {
  if (!isObject(x)) return null;
  // rules と preset はどちらか一方
  if ((x.rules === undefined) === (x.preset === undefined)) return null;
  const preset = PRESETS.find((p) => p.id === x.preset);
  const rules = x.rules !== undefined ? parseRules(x.rules) : preset ? cloneRules(preset.rules) : null;
  if (!rules) return null;
  const seat = x.hostSeat ?? "random";
  if (seat !== "first" && seat !== "second" && seat !== "random") return null;
  const turnSeconds = x.turnSeconds === undefined ? 0 : x.turnSeconds;
  const allowed: readonly unknown[] = testSeconds ? [...TURN_SECONDS, testSeconds] : TURN_SECONDS;
  if (!allowed.includes(turnSeconds)) return null;
  return { rules, hostSeat: seat, turnSeconds: turnSeconds as number };
}

/**
 * POST /api/match の本文。phrase を正規化して検証し（net/phrase.ts）、ほかは parseCreate と同じ。
 * 合言葉が不正なら bad_phrase、ルールなどが不正なら bad_rules
 */
export function parseMatch(
  x: unknown,
  testSeconds?: number,
): { ok: true; phrase: string; rules: RuleSet; hostSeat: HostSeat; turnSeconds: number } | { ok: false; code: "bad_phrase" | "bad_rules" } {
  if (!isObject(x)) return { ok: false, code: "bad_rules" };
  const phrase = normalizePhrase(x.phrase);
  if (!phrase.ok) return { ok: false, code: "bad_phrase" };
  const { phrase: _, ...rest } = x;
  const create = parseCreate(rest, testSeconds);
  if (!create) return { ok: false, code: "bad_rules" };
  return { ok: true, phrase: phrase.phrase, ...create };
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
    case "join": {
      if (x.token !== undefined && (typeof x.token !== "string" || !TOKEN_PATTERN.test(x.token))) return bad("token の形式が違います");
      const msg: ClientMessage = x.token === undefined ? { type: "join" } : { type: "join", token: x.token };
      // 名前は検証して通ったものだけ載せる。不正な名前（長すぎる・見えない文字・文字列でない）は参加を断らず、名前なしにする
      const name = normalizeName(x.name);
      if (name.ok && name.name !== "") msg.name = name.name;
      return { ok: true, msg };
    }
    case "move": {
      if (!isCoord(x.r) || !isCoord(x.c)) return bad(`r・c は 0〜${SIZE - 1} の整数です`);
      if (typeof x.kind !== "string" || !Object.hasOwn(PIECES, x.kind)) return bad("kind が駒の種類ではありません");
      if (x.king !== undefined && typeof x.king !== "boolean") return bad("king は true / false です");
      if (x.vice !== undefined && typeof x.vice !== "boolean") return bad("vice は true / false です");
      if (x.seq !== undefined && (!Number.isInteger(x.seq) || (x.seq as number) < 0)) return bad("seq は 0 以上の整数です");
      const msg: ClientMessage = { type: "move", r: x.r, c: x.c, kind: x.kind as PieceKind, king: x.king === true };
      if (x.vice === true) msg.vice = true;
      if (x.seq !== undefined) msg.seq = x.seq as number;
      return { ok: true, msg };
    }
    case "pick":
      if (typeof x.card !== "string" || !Object.hasOwn(SKILLS, x.card)) return bad("card がスキルではありません");
      return { ok: true, msg: { type: "pick", card: x.card as SkillId } };
    case "reroll":
      return { ok: true, msg: { type: "reroll" } };
    case "skill": {
      if (typeof x.id !== "string" || !Object.hasOwn(SKILLS, x.id)) return bad("id がスキルではありません");
      if (x.kind !== undefined && (typeof x.kind !== "string" || !Object.hasOwn(PIECES, x.kind))) return bad("kind が駒の種類ではありません");
      if (x.to !== undefined && (!Array.isArray(x.to) || x.to.length !== 2 || !isCoord(x.to[0]) || !isCoord(x.to[1]))) {
        return bad(`to は [行, 列]（0〜${SIZE - 1} の整数）です`);
      }
      if (x.seq !== undefined && (!Number.isInteger(x.seq) || (x.seq as number) < 0)) return bad("seq は 0 以上の整数です");
      const msg: ClientMessage = { type: "skill", id: x.id as SkillId };
      if (x.kind !== undefined) msg.kind = x.kind as PieceKind;
      if (x.to !== undefined) msg.to = [x.to[0] as number, x.to[1] as number];
      if (x.seq !== undefined) msg.seq = x.seq as number;
      return { ok: true, msg };
    }
    case "rematch": {
      if (x.action !== "request" && x.action !== "cancel" && x.action !== "decline") return bad("action は request / cancel / decline です");
      if (!Number.isInteger(x.gameNo) || (x.gameNo as number) < 1) return bad("gameNo は 1 以上の整数です");
      return { ok: true, msg: { type: "rematch", action: x.action, gameNo: x.gameNo as number } };
    }
    case "leave":
      return { ok: true, msg: { type: "leave" } };
    default:
      return bad("type は join / move / pick / reroll / skill / rematch / leave です");
  }
}

/** e2e 用の上書き（var TEST_ENDLESS のときだけ start で受ける）。hp: [プレイヤー, CPU] の体力 / cpu: 段階の CPU の代わり / turnSeconds: 1 手の秒数 */
export interface EndlessTest {
  hp?: [number, number];
  cpu?: EndlessCpu;
  turnSeconds?: number;
}

export type ParsedEndless = { ok: true; msg: EndlessClientMessage; test?: EndlessTest } | { ok: false; code: WsErrorCode; message: string };

function parseTest(x: unknown): EndlessTest | null {
  if (!isObject(x)) return null;
  const t: EndlessTest = {};
  if (x.hp !== undefined) {
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= LIMITS.hp.max;
    if (!Array.isArray(x.hp) || x.hp.length !== 2 || !ok(x.hp[0]) || !ok(x.hp[1])) return null;
    t.hp = [x.hp[0], x.hp[1]];
  }
  if (x.cpu !== undefined) {
    if (!ENDLESS_CPUS.includes(x.cpu as EndlessCpu)) return null;
    t.cpu = x.cpu as EndlessCpu;
  }
  if (x.turnSeconds !== undefined) {
    if (!Number.isInteger(x.turnSeconds) || (x.turnSeconds as number) < 1 || (x.turnSeconds as number) > 90) return null;
    t.turnSeconds = x.turnSeconds as number;
  }
  return t;
}

/**
 * エンドレスマッチの WebSocket の 1 メッセージを読む。手・スキル・カードは対局の部屋と同じ形（parseClientMessage）。
 * join は token が必須。連勝数などほかのキーは捨てる（受け取らない）。test は allowTest（var TEST_ENDLESS）のときの start だけ
 */
export function parseEndlessMessage(data: string | ArrayBuffer, allowTest = false): ParsedEndless {
  const base = parseClientMessage(data);
  if (!base.ok) {
    // join / move / pick / reroll / skill 以外の type はここで読み直す
    if (base.code !== "bad_message" || typeof data !== "string") return base;
    let x: unknown;
    try {
      x = JSON.parse(data);
    } catch {
      return base;
    }
    if (!isObject(x)) return base;
    const bad = (message: string): ParsedEndless => ({ ok: false, code: "bad_message", message });
    if (x.type === "start") {
      if (x.test === undefined || !allowTest) return { ok: true, msg: { type: "start" } };
      const test = parseTest(x.test);
      return test ? { ok: true, msg: { type: "start" }, test } : bad("test の形が違います");
    }
    if (x.type === "next") {
      if (!Number.isInteger(x.game) || (x.game as number) < 1) return bad("game は 1 以上の整数です");
      return { ok: true, msg: { type: "next", game: x.game as number } };
    }
    return base.message.startsWith("type は") ? bad("type は join / start / next / move / pick / reroll / skill です") : base;
  }
  const msg = base.msg;
  switch (msg.type) {
    case "join":
      if (msg.token === undefined) return { ok: false, code: "bad_message", message: "token が要ります" };
      return { ok: true, msg: { type: "join", token: msg.token, ...(msg.name !== undefined ? { name: msg.name } : {}) } };
    case "move":
    case "pick":
    case "reroll":
    case "skill":
      return { ok: true, msg };
    default:
      return { ok: false, code: "bad_message", message: "type は join / start / next / move / pick / reroll / skill です" };
  }
}
