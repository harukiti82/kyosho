// スキルのゲージが溜まる演出の中身（DOM なし）: 1 手で増えた量・「+N」の文字・溜めマスの光の出どころ・満タンになったか・演出の時刻。
// 増えた量は engine が出した前後のゲージの差で、ここで計算し直さない（溜めマスの判定も engine の isZone）。

import type { Cell } from "../engine/board";
import type { MoveEvent } from "../engine/game";
import { gaugeMax, GAUGE_UNIT, isZone, type SkillsState } from "../engine/skills";

/** 光の粒が溜めマスからゲージへ飛ぶ時間（ミリ秒） */
export const ORB_MS = 520;
/** 粒を 1 つずつずらす間隔 */
export const ORB_STAGGER_MS = 70;
/** バーが伸びる時間 */
export const GROW_MS = 600;
/** 置いてからバーが伸び始めるまで（溜めマスの光がないとき）。返す駒がめくれるのを待つ */
export const GROW_AT_MS = 180;
/** 満タンになった瞬間の光の長さ */
export const FULL_FLASH_MS = 900;
/** 「+N」が浮かんで消える時間 */
export const GAIN_TEXT_MS = 1100;

/** 名札に描いたゲージ（前回の描画）。key は対局の番号、ply は手数（パスは数えない） */
export interface GaugeSnap {
  key: number;
  ply: number;
  gauge: [number, number];
}

export const snapOf = (key: number, ply: number, sk: SkillsState): GaugeSnap => ({ key, ply, gauge: [sk.sides[0].gauge, sk.sides[1].gauge] });

/** 1 人分の溜まった演出 */
export interface GaugeGain {
  /** 演出の前後のゲージ（GAUGE_UNIT 単位） */
  from: number;
  to: number;
  /** 満タンの値（GAUGE_UNIT 単位） */
  max: number;
  /** この手で満タンになった */
  full: boolean;
}

/**
 * 前回描いたゲージ（snap）から今の局面（sk）までに、1 手で増えた分を人ごとに返す（増えていなければ null）。
 * 演出するのは前回の描画からちょうど 1 手だけ進んだとき（続くパスは数えない）だけ（待った・別の対局・再接続でまとめて進んだ局面は演出しない）。
 * 減ったとき（スキルを使って 0 に戻ったなど）は演出しない
 */
export function gaugeGains(snap: GaugeSnap | null, key: number, ply: number, sk: SkillsState | undefined): [GaugeGain | null, GaugeGain | null] {
  if (!snap || !sk?.ready || snap.key !== key || ply !== snap.ply + 1) return [null, null];
  return ([0, 1] as const).map((p) => {
    const card = sk.sides[p].card;
    const to = sk.sides[p].gauge;
    const from = snap.gauge[p];
    if (!card || to <= from) return null;
    const max = gaugeMax(card);
    return { from, to, max, full: from < max && to >= max };
  }) as [GaugeGain | null, GaugeGain | null];
}

/**
 * 「+N」の文字。点は四捨五入して整数で出し（小数は出さない）、1 に満たない増え方（受けたダメージ数点ぶんの微増）は出さない（null）。
 * バーはそれでも伸びる
 */
export function gainText(g: GaugeGain): string | null {
  const n = Math.round((g.to - g.from) / GAUGE_UNIT);
  return n >= 1 ? `+${n}` : null;
}

/** 手を打った人のゲージに溜めマスの点が入ったマス（置いたマス・返した相手の駒のマスのうち溜めマス）。打った人のゲージが増えていなければ空 */
export function zoneSources(m: MoveEvent, gain: GaugeGain | null): Cell[] {
  if (!gain) return [];
  const cells: Cell[] = [];
  if (isZone(m.r, m.c)) cells.push([m.r, m.c]);
  for (const t of m.targets) if (isZone(t.r, t.c)) cells.push([t.r, t.c]);
  return cells;
}

/** 名札のゲージの演出（描き直しても途中から続けるため、始まる時刻を覚える） */
export interface GaugeAnim extends GaugeGain {
  key: number;
  /** バーが伸び始める時刻（Date.now の値） */
  start: number;
}

/** バーが伸び始めるまでの遅れ。溜めマスの光が飛んでくるなら着くまで、受けた側は着手の演出（特大の溜め）が弾けてから */
export function growDelay(orbs: number, burstAt: number): number {
  const orbArrive = orbs > 0 ? ORB_MS + (orbs - 1) * ORB_STAGGER_MS - 80 : 0;
  return Math.max(GROW_AT_MS, orbArrive, burstAt);
}

/** 演出が終わっているか（満タンの光まで） */
export const animDone = (a: GaugeAnim, now: number) => now >= a.start + GROW_MS + (a.full ? FULL_FLASH_MS : 0);

export type GaugeAnims = [GaugeAnim | null, GaugeAnim | null];
