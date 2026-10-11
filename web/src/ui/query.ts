// ルール設定 ⇔ URL クエリ。外部入力なので、型と範囲を検証してから使う（不正な項目は基準の値に戻す）。
// 例: ?take=flip&gate=1&dmg=sum&heal=none&hp1=40&hp2=40&fu=20&gin=0&kin=8&hi=4&limit=0&king=0
// 隠し王ありなら &king=1&kpen=hp&kdmg=20&kdue=5（なしのときは king=0 だけを載せる）
// 方向駒の項目（dir=piece・横と角の数 yoko / kaku・駒の数字 vfu〜vhi）は基準（QUERY_BASE = v1.0）と違うときだけ末尾に載せる。
// そのため既存プリセットの URL は方向駒の追加前と同じで、方向駒の項目がない古い URL は「全方向・既定の数字・横と角は 0 個」になる
// 端の駒の力（anc=atk）も基準（なし）と違うときだけ載せる。項目がない URL は「なし」
// スキル（skill=1）も基準（なし）と違うときだけ載せる。項目がない URL は「なし」
// 基準は画面の既定（DEFAULT_PRESET）とは別に固定する。既定を変えても共有済みの URL の意味が変わらない。
// ルールのキーが 1 つもないとき（クエリなし・?room= など）だけ画面の既定を使う

import {
  cloneRules,
  defaultRules,
  KIND_ORDER,
  LIMITS,
  presetById,
  type Action,
  type AnchorRule,
  type DamageRule,
  type DirRule,
  type HealRule,
  type KingPenalty,
  type PieceKind,
  type PresetId,
  type RuleSet,
} from "../engine/rules";

/** クエリの差分・欠けた項目・不正な項目の基準。共有済みの URL の意味を変えないため固定（変えない） */
export const QUERY_BASE: PresetId = "v10";
const baseRules = () => cloneRules(presetById(QUERY_BASE).rules);

const ACTION: Record<string, Action> = { flip: "flip", capture: "capture" };
const DAMAGE: Record<string, DamageRule> = { sum: "sum", max: "maxCount" };
const HEAL: Record<string, HealRule> = { none: "none", avg: "avg", low: "lowMinus1" };
const GATE: Record<string, boolean> = { "0": false, "1": true };
const KING_PENALTY: Record<string, KingPenalty> = { hp: "hp", lose: "lose" };
const DIRS: Record<string, DirRule> = { all: "all", piece: "piece" };
const ANCHOR: Record<string, AnchorRule> = { none: "none", atk: "attack" };
/** 駒の数字のキー（例: vfu） */
const valueKey = (k: PieceKind) => `v${k}`;
/** 追加前からある駒（数のキーを常に載せる）と、方向駒で足した駒（既定値と違うときだけ載せる） */
const OLD_KINDS: readonly PieceKind[] = ["fu", "gin", "kin", "hi"];
const NEW_KINDS: readonly PieceKind[] = KIND_ORDER.filter((k) => !OLD_KINDS.includes(k));
const keyOf = <T>(table: Record<string, T>, v: T) => Object.keys(table).find((k) => table[k] === v)!;

/** クエリに載せるキー（これ以外のキーは無視する） */
export const QUERY_KEYS = [
  "take", "gate", "dmg", "heal", "hp1", "hp2", ...KIND_ORDER, "limit", "king", "kpen", "kdmg", "kdue",
  "dir", ...KIND_ORDER.map(valueKey), "anc", "skill",
] as const;

export function encodeRules(r: RuleSet): string {
  const q = new URLSearchParams();
  q.set("take", keyOf(ACTION, r.action));
  q.set("gate", r.gate ? "1" : "0");
  q.set("dmg", keyOf(DAMAGE, r.damage));
  q.set("heal", keyOf(HEAL, r.heal));
  q.set("hp1", String(r.hp[0]));
  q.set("hp2", String(r.hp[1]));
  for (const k of OLD_KINDS) q.set(k, String(r.hand[k]));
  q.set("limit", String(r.maxPlies));
  q.set("king", r.king.on ? "1" : "0");
  if (r.king.on) {
    q.set("kpen", keyOf(KING_PENALTY, r.king.penalty));
    q.set("kdmg", String(r.king.amount));
    q.set("kdue", String(r.king.deadline));
  }
  // 方向駒の項目は、読むときの基準と違うものだけ
  const def = baseRules();
  if (r.dirs !== def.dirs) q.set("dir", keyOf(DIRS, r.dirs));
  for (const k of NEW_KINDS) if (r.hand[k] !== def.hand[k]) q.set(k, String(r.hand[k]));
  for (const k of KIND_ORDER) if (r.values[k] !== def.values[k]) q.set(valueKey(k), String(r.values[k]));
  if (r.anchor !== def.anchor) q.set("anc", keyOf(ANCHOR, r.anchor));
  if (r.skills !== def.skills) q.set("skill", r.skills ? "1" : "0");
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
  /** 不正で基準（QUERY_BASE）の値に戻したキー */
  invalid: string[];
}

/** location.search などから設定を読む。ルールのキーがなければ画面の既定、あればない項目・不正な項目は基準（QUERY_BASE）の値 */
export function decodeRules(search: string): Decoded {
  const q = new URLSearchParams(search);
  const present = QUERY_KEYS.some((k) => q.has(k));
  if (!present) return { rules: defaultRules(), present, invalid: [] };
  const def = baseRules();
  const invalid: string[] = [];
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
    dirs: pick("dir", own(DIRS), def.dirs),
    damage: pick("dmg", own(DAMAGE), def.damage),
    anchor: pick("anc", own(ANCHOR), def.anchor),
    heal: pick("heal", own(HEAL), def.heal),
    hp: [pick("hp1", (s) => intIn(s, LIMITS.hp), def.hp[0]), pick("hp2", (s) => intIn(s, LIMITS.hp), def.hp[1])],
    hand: { ...def.hand },
    values: { ...def.values },
    maxPlies: pick("limit", (s) => intIn(s, LIMITS.maxPlies), def.maxPlies),
    // 追加設定はなしのときも読む（「あり」に切り替えたときの値）。ない項目は基準の値
    king: {
      on: pick("king", own(GATE), def.king.on),
      penalty: pick("kpen", own(KING_PENALTY), def.king.penalty),
      amount: pick("kdmg", (s) => intIn(s, LIMITS.kingAmount), def.king.amount),
      deadline: pick("kdue", (s) => intIn(s, LIMITS.kingDeadline), def.king.deadline),
    },
    skills: pick("skill", own(GATE), def.skills),
  };
  for (const k of KIND_ORDER) rules.hand[k] = pick(k, (s) => intIn(s, LIMITS.pieces), def.hand[k]);
  for (const k of KIND_ORDER) rules.values[k] = pick(valueKey(k), (s) => intIn(s, LIMITS.value), def.values[k]);
  return { rules, present, invalid };
}
