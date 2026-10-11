// スキル（タロットカード風の 8 枚）の定義と、ゲージ・ダメージの計算。UI に依存しない。
// 値はリポジトリ外のシミュレーター（kyosho-skillsim の sim.ts・final.json、大回復だけはユーザーの採用値）に合わせる。
// 状態の変化（配る・選ぶ・使う・打った手のゲージ）は game.ts の「スキル」節。

import { SIZE, type Cell } from "./board";
import type { PieceKind } from "./rules";

export type SkillId = "firstaid" | "bigheal" | "strong" | "omni" | "refill" | "wall" | "scout" | "kingmove";

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

/** 表示・配る順 */
export const SKILL_ORDER: readonly SkillId[] = ["firstaid", "bigheal", "strong", "omni", "refill", "wall", "scout", "kingmove"];

export const SKILLS: Record<SkillId, SkillSpec> = {
  firstaid: { id: "firstaid", name: "応急手当", tarot: "星", numeral: "XVII", length: 20, zone: 4 },
  bigheal: { id: "bigheal", name: "大回復", tarot: "女帝", numeral: "III", length: 80, zone: 12 },
  strong: { id: "strong", name: "強打", tarot: "力", numeral: "VIII", length: 26, zone: 4 },
  omni: { id: "omni", name: "全方向", tarot: "戦車", numeral: "VII", length: 32, zone: 4 },
  refill: { id: "refill", name: "補充", tarot: "節制", numeral: "XIV", length: 26, zone: 4 },
  wall: { id: "wall", name: "鉄壁", tarot: "皇帝", numeral: "IV", length: 20, zone: 4 },
  scout: { id: "scout", name: "偵察", tarot: "隠者", numeral: "IX", length: 20, zone: 4 },
  kingmove: { id: "kingmove", name: "王の移し替え", tarot: "魔術師", numeral: "I", length: 26, zone: 4 },
};

/** 回復の量（初期体力を超えない） */
export const SKILL_HEAL: Readonly<Record<"firstaid" | "bigheal", number>> = { firstaid: 2, bigheal: 10 };
/** 補充で戻せる駒の数字の上限 */
export const REFILL_MAX_VALUE = 3;
/** 王の移し替えで移せる距離（縦・横・斜めに何マスまで） */
export const KINGMOVE_RANGE = 2;
/** 偵察した手で相手の王を返したときの罰の倍率 */
export const SCOUT_PENALTY_RATE = 2;
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

/** スキルを使えない理由 */
export type SkillBlock =
  | "off" // スキルなしのルール・カードなし
  | "picking" // 対局の前にカードを選んでいる
  | "over" // 終局
  | "used" // この手番でもう使った
  | "charging" // ゲージが満タンでない
  | "fullHp" // 回復: 体力が初期値
  | "noRefill" // 補充: 戻せる駒がない
  | "noTarget" // 偵察: 相手の王がまだ決まっていない（期限前）か、もう返した
  | "noKing" // 王の移し替え: 自分の王が隠れていない
  | "noRoom"; // 王の移し替え: 移せる駒がない

/** スキルを使うときの指定 */
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
}
