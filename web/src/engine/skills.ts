// スキル（タロットカード風の 11 枚）の定義と、ゲージ・ダメージの計算。UI に依存しない。
// 値はリポジトリ外のシミュレーター（kyosho-skillsim の sim.ts。final14b.json の推奨値・副将の罰 15）に合わせる。
// 状態の変化（配る・選ぶ・使う・打った手のゲージ）は game.ts の「スキル」節。

import { SIZE, type Cell } from "./board";
import type { GameState } from "./game";
import type { PieceKind } from "./rules";

/** 基本の 8 枚（運命の輪が引く効果） */
export type BaseSkillId = "firstaid" | "bigheal" | "strong" | "omni" | "refill" | "wall" | "scout" | "kingmove";
export type SkillId = BaseSkillId | "fool" | "wheel" | "judge";

export interface SkillSpec {
  id: SkillId;
  /** スキルの名前（画面の見出し） */
  name: string;
  /** 名前と意味を借りたタロットの札 */
  tarot: string;
  /** タロットの番号（ローマ数字） */
  numeral: string;
  /** ゲージの長さ（満タンまでの点） */
  length: number;
  /** 溜めマスに置く・溜めマス上の相手の駒を返す 1 回ごとの点 */
  zone: number;
}

/** 運命の輪が等確率で引く効果（基本の 8 枚） */
export const BASE_SKILLS: readonly BaseSkillId[] = ["firstaid", "bigheal", "strong", "omni", "refill", "wall", "scout", "kingmove"];
/** 表示・配る順 */
export const SKILL_ORDER: readonly SkillId[] = [...BASE_SKILLS, "fool", "wheel", "judge"];

export const SKILLS: Record<SkillId, SkillSpec> = {
  firstaid: { id: "firstaid", name: "応急手当", tarot: "星", numeral: "XVII", length: 20, zone: 4 },
  bigheal: { id: "bigheal", name: "大回復", tarot: "女帝", numeral: "III", length: 80, zone: 12 },
  strong: { id: "strong", name: "強打", tarot: "力", numeral: "VIII", length: 26, zone: 4 },
  omni: { id: "omni", name: "全方向", tarot: "戦車", numeral: "VII", length: 32, zone: 4 },
  refill: { id: "refill", name: "補充", tarot: "節制", numeral: "XIV", length: 48, zone: 4 },
  wall: { id: "wall", name: "鉄壁", tarot: "皇帝", numeral: "IV", length: 20, zone: 4 },
  scout: { id: "scout", name: "偵察", tarot: "隠者", numeral: "IX", length: 36, zone: 4 },
  kingmove: { id: "kingmove", name: "王の移し替え", tarot: "魔術師", numeral: "I", length: 26, zone: 4 },
  fool: { id: "fool", name: "連続行動", tarot: "愚者", numeral: "0", length: 42, zone: 4 },
  wheel: { id: "wheel", name: "運命の輪", tarot: "運命の輪", numeral: "X", length: 36, zone: 4 },
  judge: { id: "judge", name: "巻き戻し", tarot: "審判", numeral: "XX", length: 30, zone: 4 },
};

/** 回復の量（初期体力を超えない） */
export const SKILL_HEAL: Readonly<Record<"firstaid" | "bigheal", number>> = { firstaid: 2, bigheal: 10 };
/** 王の移し替えで移せる距離（縦・横・斜めに何マスまで） */
export const KINGMOVE_RANGE = 2;
/** 偵察で相手の王・副将を特定してから、それを返すまでの罰の倍率 */
export const SCOUT_PENALTY_RATE = 2;
/** 副将（スキルありで隠し王ありのルールだけ）を返されたときの罰（体力） */
export const VICE_PENALTY = 15;
/** 王を決めた後・副将を返された後、自分の手でこの手数以内に置く駒で副将を出す（期限の手で置いた駒が自動で副将になる） */
export const VICE_DEADLINE = 7;
/** 対局の前に配る枚数 */
export const OFFER_SIZE = 3;

/**
 * ゲージは 1/GAUGE_UNIT 点を 1 として整数で持つ（受けたダメージ 1 点 = 0.15 点を誤差なく足すため）。
 * 満タン = length × GAUGE_UNIT
 */
export const GAUGE_UNIT = 20;
/** 1 手で返した枚数ごとの点（0・1・2・3・4 枚以上） */
export const FLIP_POINTS: readonly number[] = [0, 1, 2, 4, 7];
/** 受けたダメージ 1 点ごとの点（GAUGE_UNIT 単位で 3 = 0.15 点） */
export const DAMAGE_POINTS_UNITS = 3;

/** 溜めマス（盤の星の 4 マス c3・f3・c6・f6） */
export const ZONE_CELLS: readonly Cell[] = [[2, 2], [2, 5], [5, 2], [5, 5]];
const ZONE_KEYS = new Set(ZONE_CELLS.map(([r, c]) => r * SIZE + c));
export const isZone = (r: number, c: number) => ZONE_KEYS.has(r * SIZE + c);

/** 満タンの値（GAUGE_UNIT 単位） */
export const gaugeMax = (id: SkillId) => SKILLS[id].length * GAUGE_UNIT;

/**
 * 1 手で手を打った人のゲージに入る点（GAUGE_UNIT 単位）。
 * 返した枚数の累進 ＋ 溜めマスに置いた・溜めマス上の相手の駒を返した 1 回ごとにカードの溜めマス点
 */
export function moverGain(id: SkillId, placed: Cell, targets: readonly { r: number; c: number }[]): number {
  const flips = FLIP_POINTS[Math.min(targets.length, FLIP_POINTS.length - 1)];
  const zoneHits = (isZone(placed[0], placed[1]) ? 1 : 0) + targets.filter((t) => isZone(t.r, t.c)).length;
  return (flips + SKILLS[id].zone * zoneHits) * GAUGE_UNIT;
}

/** 受けた側のゲージに入る点（GAUGE_UNIT 単位）。lost = その手で減った体力 */
export const victimGain = (lost: number) => Math.max(0, lost) * DAMAGE_POINTS_UNITS;

/** 強打: その手のダメージ ×1.5（端数切り捨て） */
export const strongDamage = (d: number) => Math.floor((d * 3) / 2);
/** 鉄壁: 相手の次の手のダメージを半分（端数切り捨て） */
export const shieldDamage = (d: number) => Math.floor(d / 2);
/** 連続行動: 2 手目のダメージを半分（端数切り捨て。王の罰は変えない） */
export const secondDamage = (d: number) => Math.floor(d / 2);

/** スキルを使えない理由 */
export type SkillBlock =
  | "off" // スキルなしのルール・カードなし
  | "picking" // 対局の前にカードを選んでいる
  | "over" // 終局
  | "used" // この手番でもう使った（連続行動の 2 手目を含む）
  | "charging" // ゲージが満タンでない
  | "fullHp" // 回復: 体力が初期値
  | "noRefill" // 補充: 戻せる駒がない
  | "noTarget" // 偵察: 相手の王がまだ決まっていない（期限前）
  | "noVice" // 偵察: 王が分かった・返した後で、相手が副将を出す期限の前・相手の副将が決まっていない
  | "viceSeen" // 偵察: 相手の今の副将はもう特定している
  | "noKing" // 王の移し替え: 自分の王が隠れていない
  | "noRoom" // 王の移し替え: 移せる駒がない
  | "noUndo"; // 巻き戻し: 戻す手がない（まだ打っていない・この手番の前に戻せない）

/** 運命の輪の効果ごとの、使えない理由（使えるかの判定は game.ts の skillBlock と同じ） */
export type EffectBlock = Exclude<SkillBlock, "off" | "picking" | "over" | "used" | "charging" | "noUndo">;

/**
 * スキルを使うときの指定。
 * 運命の輪で補充・王の移し替えが出たら、続けて同じ id（wheel）で戻す駒・移す先を指定する（state.skills.armed.aim の間）
 */
export interface SkillUse {
  id: SkillId;
  /** 補充: 戻す駒 */
  kind?: PieceKind;
  /** 王の移し替え: 移す先のマス（隠し情報。棋譜・相手には送らない） */
  to?: Cell;
}

/**
 * 使ったスキルの公開情報（手番中の state.skills.armed と、その手の棋譜 MoveEvent.skill）。
 * 王の移し替えの移す先は含めない
 */
export interface SkillNote {
  id: SkillId;
  /** 回復: 回復した体力 */
  heal?: number;
  /** 補充: 戻した駒 */
  kind?: PieceKind;
  /** 王の移し替え: 使った時点の自分の駒（相手から見た王の候補。公開されている盤の情報） */
  cands?: Cell[];
  /** 運命の輪: 引いた効果 */
  effect?: BaseSkillId;
  /** 運命の輪: 引いた効果がその場で使えず不発 */
  fizzle?: true;
  /** 運命の輪: 補充・王の移し替えが出て、戻す駒・移す先の指定を待っている（置く前に指定する） */
  aim?: true;
  /** 偵察: find = 相手の王を特定した（罰 2 倍は王を返すまで）/ vice = 相手の今の副将を特定した（罰 2 倍はその副将を返すまで） */
  scout?: "find" | "vice";
  /** 巻き戻し: 戻した手数（自分の手と相手の応手） */
  back?: number;
  /** 巻き戻し: 戻した自分の手（公開されていた手。CPU が同じ手を打ち直さないため） */
  redo?: { r: number; c: number; kind: PieceKind };
}

export interface SkillSide {
  /** 配られたカード（選ぶ前の候補。相手には見せない） */
  offer: SkillId[];
  /** 選んだカード。まだ選んでいない・カードなしなら null */
  card: SkillId | null;
  /** ゲージ（GAUGE_UNIT 単位。満タンは gaugeMax(card)） */
  gauge: number;
}

export interface SkillsState {
  sides: [SkillSide, SkillSide];
  /** 両者が選び終えた（打てる）。選び終えるまで相手のカードは見せない */
  ready: boolean;
  /** 手番の人がこの手番で使ったスキル（置くまで） */
  armed: SkillNote | null;
  /** 相手の鉄壁で、次の手のダメージが半分になる */
  shielded: [boolean, boolean];
  /** 手番の人が連続行動の 2 手目を打つ（ダメージ半分・スキルは使えない）。キーがなければ false */
  second?: boolean;
  /** 偵察で相手の王を特定してから、その王を返すまで罰が 2 倍。キーがなければ両者 false */
  hunt?: [boolean, boolean];
  /** 巻き戻しで戻せる（前の自分の手番の頭の局面がある）。公開情報。キーがなければ両者 false */
  undoable?: [boolean, boolean];
  /**
   * 巻き戻しで戻す局面（各自の前の手番の頭。王を含む隠し情報なので viewFor が消す）。
   * 巻き戻しのカードを持つ人の分だけ。中の局面の skills には undo を持たない
   */
  undo?: [GameState | null, GameState | null];
}
