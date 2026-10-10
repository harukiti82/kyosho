// 挟将のルール設定。各項目を独立に組み合わせられる（Web 試遊版）。UI に依存しない。

export type Player = 0 | 1;
export type PieceKind = "fu" | "yoko" | "gin" | "kaku" | "kin" | "hi";

/** 駒が挟める方向（挟める方向が「駒ごと」のときだけ使う）。縦・横は盤の絶対方向（先手・後手で反転しない） */
export type Reach = "vertical" | "horizontal" | "diagonal" | "orthogonal" | "all";

export interface PieceSpec {
  kind: PieceKind;
  /** 表示名（1 文字） */
  name: string;
  /** 既定の数字（RuleSet.values の既定値）。返された・取られたときのダメージの元になる */
  value: number;
  /** 挟める方向（駒の種類で固定） */
  reach: Reach;
}

export const PIECES: Record<PieceKind, PieceSpec> = {
  fu: { kind: "fu", name: "歩", value: 1, reach: "vertical" },
  // 中将棋の「横行」が由来
  yoko: { kind: "yoko", name: "横", value: 1, reach: "horizontal" },
  gin: { kind: "gin", name: "銀", value: 2, reach: "all" },
  kaku: { kind: "kaku", name: "角", value: 3, reach: "diagonal" },
  kin: { kind: "kin", name: "金", value: 3, reach: "all" },
  hi: { kind: "hi", name: "飛", value: 5, reach: "orthogonal" },
};

/** 方向のマーク（ルールカード・持ち駒の一覧の文字）・名前（ルール詳細・読み上げ）・短い名前（設定画面） */
export const REACH_MARK: Record<Reach, { mark: string; name: string; short: string }> = {
  vertical: { mark: "↕", name: "縦（上下）", short: "縦" },
  horizontal: { mark: "↔", name: "横（左右）", short: "横" },
  diagonal: { mark: "✕", name: "斜め 4 方向", short: "斜め" },
  orthogonal: { mark: "✚", name: "縦横 4 方向", short: "縦横" },
  all: { mark: "✱", name: "全 8 方向", short: "全方向" },
};

/**
 * 走査・設定画面の順序。歩・銀・金・飛の相対順は sim/*.py の持ち駒の並びと同じ
 * （既存プリセットでは横・角が 0 個なので、CPU の候補の並びも従来どおり）
 */
export const KIND_ORDER: readonly PieceKind[] = ["fu", "yoko", "gin", "kaku", "kin", "hi"];

export type Hand = Record<PieceKind, number>;
export type PieceValues = Record<PieceKind, number>;

/** 既定の数字（歩1 横1 銀2 角3 金3 飛5） */
export const DEFAULT_VALUES: Readonly<PieceValues> = Object.fromEntries(KIND_ORDER.map((k) => [k, PIECES[k].value])) as PieceValues;

/** 挟んだ駒を flip: 裏返す（オセロ） / capture: 取って自分の持ち駒にする */
export type Action = "flip" | "capture";
/** sum: 数字の合計 / maxCount: 最大値 + 枚数 ÷ 4（切り捨て） */
export type DamageRule = "sum" | "maxCount";
/** none: なし / avg: 両端の平均（切り捨て） / lowMinus1: 両端の低い方 − 1（0 未満は 0） */
export type HealRule = "none" | "avg" | "lowMinus1";
/** 挟める方向。all: 8 方向すべて（従来） / piece: 置いた駒の方向だけ */
export type DirRule = "all" | "piece";
/** 端の駒の力。none: なし（従来） / attack: 返した（取った）列ごとに、反対端の自分の駒の数字をダメージに上乗せする */
export type AnchorRule = "none" | "attack";
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
  /** 挟める方向 */
  dirs: DirRule;
  damage: DamageRule;
  /** 端の駒の力（挟んだ反対端の自分の駒の数字をダメージに足すか） */
  anchor: AnchorRule;
  heal: HealRule;
  /** 初期体力 [先手, 後手] */
  hp: [number, number];
  /** 初期の持ち駒（両者同じ） */
  hand: Hand;
  /** 駒種ごとの数字（盤上の駒も持ち駒もこの数字。対局中は変わらない） */
  values: PieceValues;
  /** 総手数の上限。0 なら上限なし */
  maxPlies: number;
  /** 隠し王。on が false なら他の項目は使わない */
  king: HiddenKing;
}

/** 設定値の範囲（設定画面・URL の検証で使う） */
export const LIMITS = {
  hp: { min: 5, max: 200 },
  pieces: { min: 0, max: 40 },
  value: { min: 1, max: 20 },
  maxPlies: { min: 0, max: 300 },
  kingAmount: { min: 1, max: 200 },
  kingDeadline: { min: 1, max: 20 },
} as const;

/** 隠し王なし（追加設定は「あり」に切り替えたときの既定値） */
export const NO_KING: Readonly<HiddenKing> = { on: false, penalty: "hp", amount: 20, deadline: 5 };

export type PresetId = "v04" | "v10" | "v2" | "orig" | "king" | "dir" | "anchor" | "std";

export interface Preset {
  id: PresetId;
  name: string;
  /** プリセットの 1 行説明 */
  note: string;
  rules: RuleSet;
}

/** 歩・銀・金・飛の数（横・角は 0） */
const hand = (fu: number, gin: number, kin: number, hi: number): Hand => ({ fu, yoko: 0, gin, kaku: 0, kin, hi });
const values = (): PieceValues => ({ ...DEFAULT_VALUES });

export const PRESETS: readonly Preset[] = [
  {
    id: "v04",
    name: "v0.4",
    note: "裏返す・最大値＋枚数÷4・回復は低い方−1",
    rules: {
      action: "flip", gate: false, dirs: "all", damage: "maxCount", anchor: "none", heal: "lowMinus1",
      hp: [65, 66], hand: hand(14, 10, 6, 2), values: values(), maxPlies: 0, king: { ...NO_KING },
    },
  },
  {
    id: "v10",
    name: "v1.0（取る）",
    note: "取って持ち駒にする・どこでも置ける・合計",
    rules: {
      action: "capture", gate: false, dirs: "all", damage: "sum", anchor: "none", heal: "none",
      hp: [20, 20], hand: hand(8, 0, 4, 2), values: values(), maxPlies: 80, king: { ...NO_KING },
    },
  },
  {
    id: "v2",
    name: "v2案（強い駒は返せない）",
    note: "裏返す・置いた駒より強い駒は返せない・合計",
    rules: {
      action: "flip", gate: true, dirs: "all", damage: "sum", anchor: "none", heal: "none",
      hp: [40, 40], hand: hand(20, 0, 8, 4), values: values(), maxPlies: 0, king: { ...NO_KING },
    },
  },
  {
    id: "orig",
    name: "原案",
    note: "裏返す・合計・回復は両端の平均",
    rules: {
      action: "flip", gate: false, dirs: "all", damage: "sum", anchor: "none", heal: "avg",
      hp: [40, 40], hand: hand(14, 10, 6, 2), values: values(), maxPlies: 0, king: { ...NO_KING },
    },
  },
  {
    id: "king",
    name: "隠し王",
    note: "裏返す・合計・最初の5手で王を隠す（返されたら−20）",
    rules: {
      action: "flip", gate: false, dirs: "all", damage: "sum", anchor: "none", heal: "none",
      // 体力 60・60 だと 2 手読み同士の先手勝率が 32.5%（400 局）だったため、先手に 10 上乗せ（48.3%）
      hp: [70, 60], hand: hand(14, 10, 6, 2), values: values(), maxPlies: 0,
      king: { on: true, penalty: "hp", amount: 20, deadline: 5 },
    },
  },
  {
    id: "dir",
    name: "方向駒",
    note: "駒ごとに挟める方向が違う（歩↕ 横↔ 角✕ 飛✚ 金✱）＋隠し王",
    rules: {
      action: "flip", gate: false, dirs: "piece", damage: "sum", anchor: "none", heal: "none",
      // 体力 60・60 だと 2 手読み同士の先手勝率が 60.9%（2000 局）だったため、後手に 5 上乗せ（48.9%）
      hp: [60, 65],
      hand: { fu: 8, yoko: 8, gin: 0, kaku: 6, kin: 4, hi: 6 },
      // 便利な駒ほど数字が大きい（返されると痛い）。既存プリセットの金3・飛5 とは逆
      values: { ...DEFAULT_VALUES, hi: 3, kin: 5 },
      maxPlies: 0,
      king: { on: true, penalty: "hp", amount: 20, deadline: 5 },
    },
  },
  {
    id: "anchor",
    name: "拠点",
    note: "方向駒＋挟んだ反対側の自分の駒の数字もダメージに足す",
    rules: {
      action: "flip", gate: false, dirs: "piece", damage: "sum", anchor: "attack", heal: "none",
      // 方向駒と同じ 60・65 だと上乗せでダメージが増え、2 手読み同士の平均手数が 16.9 手（2000 局）と短すぎるため、
      // 平均 30 手以上になるよう引き上げた（125・130: 先手勝率 47.3%・平均 31.3 手、4000 局）
      hp: [125, 130],
      hand: { fu: 8, yoko: 8, gin: 0, kaku: 6, kin: 4, hi: 6 },
      values: { ...DEFAULT_VALUES, hi: 3, kin: 5 },
      maxPlies: 0,
      king: { on: true, penalty: "hp", amount: 20, deadline: 5 },
    },
  },
  {
    id: "std",
    name: "標準",
    note: "方向駒＋反対側の駒の力＋隠し王（最初の7手・返されたら−30）・回復は両端の低い方−1",
    rules: {
      // ユーザーが遊び比べて既定に選んだ組み合わせ（URL: take=flip&gate=0&dmg=sum&heal=avg&hp1=125&hp2=130&fu=10&gin=0&kin=2&hi=3
      // &limit=0&king=1&kpen=hp&kdmg=30&kdue=5&dir=piece&yoko=10&kaku=4&vkin=5&vhi=3&anc=atk）から、
      // 王の指定期限を 5 → 7 手、回復を平均 → 低い方−1 に変え（ユーザーの指定）、先手の体力を測り直した
      // （2 手読み同士の先手勝率 129・130: 49.5 ± 1.1%、8000 局。先手 128: 48.4%・先手 130: 50.6%）
      action: "flip", gate: false, dirs: "piece", damage: "sum", anchor: "attack", heal: "lowMinus1",
      hp: [129, 130],
      hand: { fu: 10, yoko: 10, gin: 0, kaku: 4, kin: 2, hi: 3 },
      values: { ...DEFAULT_VALUES, hi: 3, kin: 5 },
      maxPlies: 0,
      king: { on: true, penalty: "hp", amount: 30, deadline: 7 },
    },
  },
];

export const presetById = (id: PresetId): Preset => PRESETS.find((p) => p.id === id)!;

/**
 * 既定のルール（クエリなしで開いたときの設定）。URL クエリの差分の基準は ui/query.ts の QUERY_BASE（v1.0 で固定）で、
 * これを変えても共有済みの URL の意味は変わらない
 */
export const DEFAULT_PRESET: PresetId = "std";

export const cloneRules = (r: RuleSet): RuleSet => ({
  ...r,
  hp: [r.hp[0], r.hp[1]],
  hand: { ...r.hand },
  values: { ...r.values },
  king: { ...r.king },
});

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
    a.dirs === b.dirs &&
    a.damage === b.damage &&
    a.anchor === b.anchor &&
    a.heal === b.heal &&
    a.hp[0] === b.hp[0] &&
    a.hp[1] === b.hp[1] &&
    a.maxPlies === b.maxPlies &&
    sameKing(a.king, b.king) &&
    KIND_ORDER.every((k) => a.hand[k] === b.hand[k] && a.values[k] === b.values[k])
  );
}

/** 表示の順序（数字の小さい順。同じ数字なら KIND_ORDER の順。既存プリセットでは KIND_ORDER と同じ） */
export const kindsByValue = (r: RuleSet, kinds: readonly PieceKind[] = KIND_ORDER): PieceKind[] =>
  [...kinds].sort((a, b) => r.values[a] - r.values[b] || KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));

/** 対局に出てくる駒種（持ち駒が 1 個以上。中央の初期配置の歩は常に含む）。表示の順序 */
export const kindsInRules = (r: RuleSet): PieceKind[] => kindsByValue(r, KIND_ORDER.filter((k) => k === "fu" || r.hand[k] > 0));

/** 設定と一致するプリセット（なければ null = カスタム） */
export const matchPreset = (r: RuleSet): Preset | null => PRESETS.find((p) => sameRules(p.rules, r)) ?? null;

export const PLAYER_NAME: Record<Player, string> = { 0: "先手", 1: "後手" };

export const other = (p: Player): Player => (p === 0 ? 1 : 0);
