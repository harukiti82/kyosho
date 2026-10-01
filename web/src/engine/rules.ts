// 挟将のルール定数（RULES.md v1.0「取った駒が持ち駒になる」）。UI に依存しない。

export type Player = 0 | 1;
export type PieceKind = "fu" | "kin" | "hi";

export interface PieceSpec {
  kind: PieceKind;
  /** 表示名（1 文字） */
  name: string;
  /** 駒の数字。取られたときのダメージになる */
  value: number;
}

export const PIECES: Record<PieceKind, PieceSpec> = {
  fu: { kind: "fu", name: "歩", value: 1 },
  kin: { kind: "kin", name: "金", value: 3 },
  hi: { kind: "hi", name: "飛", value: 5 },
};

/** 表示・走査の順序（数字の小さい順。sim/capture.py の持ち駒の並びと同じ） */
export const KIND_ORDER: readonly PieceKind[] = ["fu", "kin", "hi"];

export type Hand = Record<PieceKind, number>;

/** 初期の持ち駒（両者共通・公開） */
export const INITIAL_HAND: Readonly<Hand> = { fu: 8, kin: 4, hi: 2 };
/** 初期体力（両者共通。後手ボーナスなし） */
export const INITIAL_HP = 20;
/** 総手数の上限（各 40 手）。達したら体力で判定する */
export const MAX_PLIES = 80;

export const PLAYER_NAME: Record<Player, string> = { 0: "先手", 1: "後手" };

export const other = (p: Player): Player => (p === 0 ? 1 : 0);
