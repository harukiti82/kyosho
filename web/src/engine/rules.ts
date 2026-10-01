// 挟将のルール設定。各項目を独立に組み合わせられる（Web 試遊版）。UI に依存しない。

export type Player = 0 | 1;
export type PieceKind = "fu" | "gin" | "kin" | "hi";

export interface PieceSpec {
  kind: PieceKind;
  /** 表示名（1 文字） */
  name: string;
  /** 駒の数字。返された・取られたときのダメージの元になる */
  value: number;
}

export const PIECES: Record<PieceKind, PieceSpec> = {
  fu: { kind: "fu", name: "歩", value: 1 },
  gin: { kind: "gin", name: "銀", value: 2 },
  kin: { kind: "kin", name: "金", value: 3 },
  hi: { kind: "hi", name: "飛", value: 5 },
};

/** 表示・走査の順序（数字の小さい順。sim/*.py の持ち駒の並びと同じ） */
export const KIND_ORDER: readonly PieceKind[] = ["fu", "gin", "kin", "hi"];

export type Hand = Record<PieceKind, number>;

/** 挟んだ駒を flip: 裏返す（オセロ） / capture: 取って自分の持ち駒にする */
export type Action = "flip" | "capture";
/** sum: 数字の合計 / maxCount: 最大値 + 枚数 ÷ 4（切り捨て） */
export type DamageRule = "sum" | "maxCount";
/** none: なし / avg: 両端の平均（切り捨て） / lowMinus1: 両端の低い方 − 1（0 未満は 0） */
export type HealRule = "none" | "avg" | "lowMinus1";
/** 王を返された（取られた）ときの罰。hp: 体力−amount / lose: 即負け */
export type KingPenalty = "hp" | "lose";

/** 隠し王（読み合い要素）。各自が期限内の 1 手で置いた駒を、相手に見えない王にする */
export interface HiddenKing {
  on: boolean;
  penalty: KingPenalty;
  /** 罰が hp のときに減る体力 */
  amount: number;
  /** 指定期限。各自の最初の deadline 手のうち 1 手で置いた駒を王にする（期限の手までに決めなければその手の駒が王） */
  deadline: number;
}

export interface RuleSet {
  action: Action;
  /** true なら、置いた駒より数字が大きい駒を含む列は返せない（取れない） */
  gate: boolean;
  damage: DamageRule;
  heal: HealRule;
  /** 初期体力 [先手, 後手] */
  hp: [number, number];
  /** 初期の持ち駒（両者同じ） */
  hand: Hand;
  /** 総手数の上限。0 なら上限なし */
  maxPlies: number;
  /** 隠し王。on が false なら他の項目は使わない */
  king: HiddenKing;
}

/** 設定値の範囲（設定画面・URL の検証で使う） */
export const LIMITS = {
  hp: { min: 5, max: 200 },
  pieces: { min: 0, max: 40 },
  maxPlies: { min: 0, max: 300 },
  kingAmount: { min: 1, max: 200 },
  kingDeadline: { min: 1, max: 20 },
} as const;

/** 隠し王なし（追加設定は「あり」に切り替えたときの既定値） */
export const NO_KING: Readonly<HiddenKing> = { on: false, penalty: "hp", amount: 20, deadline: 5 };

export type PresetId = "v04" | "v10" | "v2" | "orig" | "king";

export interface Preset {
  id: PresetId;
  name: string;
  /** プリセットの 1 行説明 */
  note: string;
  rules: RuleSet;
}

const hand = (fu: number, gin: number, kin: number, hi: number): Hand => ({ fu, gin, kin, hi });

export const PRESETS: readonly Preset[] = [
  {
    id: "v04",
    name: "v0.4",
    note: "裏返す・最大値＋枚数÷4・回復は低い方−1",
    rules: {
      action: "flip", gate: false, damage: "maxCount", heal: "lowMinus1",
      hp: [65, 66], hand: hand(14, 10, 6, 2), maxPlies: 0, king: { ...NO_KING },
    },
  },
  {
    id: "v10",
    name: "v1.0（取る）",
    note: "取って持ち駒にする・どこでも置ける・合計",
    rules: {
      action: "capture", gate: false, damage: "sum", heal: "none",
      hp: [20, 20], hand: hand(8, 0, 4, 2), maxPlies: 80, king: { ...NO_KING },
    },
  },
  {
    id: "v2",
    name: "v2案（強い駒は返せない）",
    note: "裏返す・置いた駒より強い駒は返せない・合計",
    rules: {
      action: "flip", gate: true, damage: "sum", heal: "none",
      hp: [40, 40], hand: hand(20, 0, 8, 4), maxPlies: 0, king: { ...NO_KING },
    },
  },
  {
    id: "orig",
    name: "原案",
    note: "裏返す・合計・回復は両端の平均",
    rules: {
      action: "flip", gate: false, damage: "sum", heal: "avg",
      hp: [40, 40], hand: hand(14, 10, 6, 2), maxPlies: 0, king: { ...NO_KING },
    },
  },
  {
    id: "king",
    name: "隠し王",
    note: "裏返す・合計・最初の5手で王を隠す（返されたら−20）",
    rules: {
      action: "flip", gate: false, damage: "sum", heal: "none",
      // 体力 60・60 だと 2 手読み同士の先手勝率が 32.5%（400 局）だったため、先手に 10 上乗せ（48.3%）
      hp: [70, 60], hand: hand(14, 10, 6, 2), maxPlies: 0,
      king: { on: true, penalty: "hp", amount: 20, deadline: 5 },
    },
  },
];

export const presetById = (id: PresetId): Preset => PRESETS.find((p) => p.id === id)!;

/** 既定のルール（RULES.md の現行版 v1.0） */
export const DEFAULT_PRESET: PresetId = "v10";

export const cloneRules = (r: RuleSet): RuleSet => ({ ...r, hp: [r.hp[0], r.hp[1]], hand: { ...r.hand }, king: { ...r.king } });

/** 隠し王の設定が同じか（どちらも「なし」なら追加設定の違いは問わない） */
function sameKing(a: HiddenKing, b: HiddenKing): boolean {
  if (!a.on || !b.on) return a.on === b.on;
  return a.penalty === b.penalty && a.deadline === b.deadline && (a.penalty === "lose" || a.amount === b.amount);
}

export const defaultRules = (): RuleSet => cloneRules(presetById(DEFAULT_PRESET).rules);

export function sameRules(a: RuleSet, b: RuleSet): boolean {
  return (
    a.action === b.action &&
    a.gate === b.gate &&
    a.damage === b.damage &&
    a.heal === b.heal &&
    a.hp[0] === b.hp[0] &&
    a.hp[1] === b.hp[1] &&
    a.maxPlies === b.maxPlies &&
    sameKing(a.king, b.king) &&
    KIND_ORDER.every((k) => a.hand[k] === b.hand[k])
  );
}

/** 設定と一致するプリセット（なければ null = カスタム） */
export const matchPreset = (r: RuleSet): Preset | null => PRESETS.find((p) => sameRules(p.rules, r)) ?? null;

export const PLAYER_NAME: Record<Player, string> = { 0: "先手", 1: "後手" };

export const other = (p: Player): Player => (p === 0 ? 1 : 0);
