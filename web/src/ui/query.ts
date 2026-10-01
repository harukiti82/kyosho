// ルール設定 ⇔ URL クエリ。外部入力なので、型と範囲を検証してから使う（不正な項目は既定値に戻す）。
// 例: ?take=flip&gate=1&dmg=sum&heal=none&hp1=40&hp2=40&fu=20&gin=0&kin=8&hi=4&limit=0&king=0
// 隠し王ありなら &king=1&kpen=hp&kdmg=20&kdue=5（なしのときは king=0 だけを載せる）

import {
  defaultRules,
  KIND_ORDER,
  LIMITS,
  type Action,
  type DamageRule,
  type HealRule,
  type KingPenalty,
  type RuleSet,
} from "../engine/rules";

const ACTION: Record<string, Action> = { flip: "flip", capture: "capture" };
const DAMAGE: Record<string, DamageRule> = { sum: "sum", max: "maxCount" };
const HEAL: Record<string, HealRule> = { none: "none", avg: "avg", low: "lowMinus1" };
const GATE: Record<string, boolean> = { "0": false, "1": true };
const KING_PENALTY: Record<string, KingPenalty> = { hp: "hp", lose: "lose" };
const keyOf = <T>(table: Record<string, T>, v: T) => Object.keys(table).find((k) => table[k] === v)!;

/** クエリに載せるキー（これ以外のキーは無視する） */
export const QUERY_KEYS = ["take", "gate", "dmg", "heal", "hp1", "hp2", ...KIND_ORDER, "limit", "king", "kpen", "kdmg", "kdue"] as const;

export function encodeRules(r: RuleSet): string {
  const q = new URLSearchParams();
  q.set("take", keyOf(ACTION, r.action));
  q.set("gate", r.gate ? "1" : "0");
  q.set("dmg", keyOf(DAMAGE, r.damage));
  q.set("heal", keyOf(HEAL, r.heal));
  q.set("hp1", String(r.hp[0]));
  q.set("hp2", String(r.hp[1]));
  for (const k of KIND_ORDER) q.set(k, String(r.hand[k]));
  q.set("limit", String(r.maxPlies));
  q.set("king", r.king.on ? "1" : "0");
  if (r.king.on) {
    q.set("kpen", keyOf(KING_PENALTY, r.king.penalty));
    q.set("kdmg", String(r.king.amount));
    q.set("kdue", String(r.king.deadline));
  }
  return q.toString();
}

/** 0 以上の整数（先頭 0 や符号・小数・指数表記は不可）で範囲内なら数値、それ以外は null */
function intIn(s: string | null, range: { min: number; max: number }): number | null {
  if (s === null || !/^(0|[1-9]\d{0,3})$/.test(s)) return null;
  const n = Number(s);
  return n >= range.min && n <= range.max ? n : null;
}

export interface Decoded {
  rules: RuleSet;
  /** クエリにルールのキーが 1 つでもあったか */
  present: boolean;
  /** 不正で既定値に戻したキー */
  invalid: string[];
}

/** location.search などから設定を読む。ない項目・不正な項目は既定値 */
export function decodeRules(search: string): Decoded {
  const q = new URLSearchParams(search);
  const def = defaultRules();
  const invalid: string[] = [];
  const present = QUERY_KEYS.some((k) => q.has(k));
  const pick = <T>(key: string, parse: (s: string | null) => T | null | undefined, fallback: T): T => {
    if (!q.has(key)) return fallback;
    const v = parse(q.get(key));
    if (v === null || v === undefined) {
      invalid.push(key);
      return fallback;
    }
    return v;
  };
  const own = <T>(table: Record<string, T>) => (s: string | null) =>
    s !== null && Object.hasOwn(table, s) ? table[s] : null;

  const rules: RuleSet = {
    action: pick("take", own(ACTION), def.action),
    gate: pick("gate", own(GATE), def.gate),
    damage: pick("dmg", own(DAMAGE), def.damage),
    heal: pick("heal", own(HEAL), def.heal),
    hp: [pick("hp1", (s) => intIn(s, LIMITS.hp), def.hp[0]), pick("hp2", (s) => intIn(s, LIMITS.hp), def.hp[1])],
    hand: { ...def.hand },
    maxPlies: pick("limit", (s) => intIn(s, LIMITS.maxPlies), def.maxPlies),
    // 追加設定はなしのときも読む（「あり」に切り替えたときの値）。ない項目は既定値
    king: {
      on: pick("king", own(GATE), def.king.on),
      penalty: pick("kpen", own(KING_PENALTY), def.king.penalty),
      amount: pick("kdmg", (s) => intIn(s, LIMITS.kingAmount), def.king.amount),
      deadline: pick("kdue", (s) => intIn(s, LIMITS.kingDeadline), def.king.deadline),
    },
  };
  for (const k of KIND_ORDER) rules.hand[k] = pick(k, (s) => intIn(s, LIMITS.pieces), def.hand[k]);
  return { rules, present, invalid };
}
