// テスト用の盤面・局面ビルダー

import { SIZE, type Board } from "../src/engine/board";
import { createGame, type GameState } from "../src/engine/game";
import type { Hand, PieceKind, Player } from "../src/engine/rules";

export const KIND_BY_VALUE: Record<number, PieceKind> = { 1: "fu", 3: "kin", 5: "hi" };

/** 棋譜表記（例: "d3"）を [行, 列] に */
export function at(name: string): [number, number] {
  return [Number(name.slice(1)) - 1, name.charCodeAt(0) - 97];
}

/** stones: { "b1": [持ち主, 数字], ... } から盤面を作る */
export function boardOf(stones: Record<string, [Player, number]>): Board {
  const b: Board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const [name, [owner, value]] of Object.entries(stones)) {
    const [r, c] = at(name);
    b[r][c] = { owner, kind: KIND_BY_VALUE[value] };
  }
  return b;
}

export function stateOf(
  board: Board,
  opts: { turn?: Player; hp?: [number, number]; ply?: number; hands?: [Partial<Hand>, Partial<Hand>] } = {},
): GameState {
  const g = createGame();
  const empty: Hand = { fu: 0, kin: 0, hi: 0 };
  return {
    ...g,
    board,
    turn: opts.turn ?? 0,
    hp: opts.hp ?? g.hp,
    ply: opts.ply ?? 0,
    hands: opts.hands ? [{ ...empty, ...opts.hands[0] }, { ...empty, ...opts.hands[1] }] : g.hands,
  };
}
