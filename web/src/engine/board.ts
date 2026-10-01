// 盤面の操作と取りの計算（sim/capture.py の captures / apply / best_capture に対応）

import { PIECES, type PieceKind, type Player } from "./rules";

export const SIZE = 8;

export interface Stone {
  owner: Player;
  kind: PieceKind;
}

/** board[行][列]。行 0 が盤の上端 */
export type Board = (Stone | null)[][];

export type Cell = readonly [number, number];

const DIRS: readonly Cell[] = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];

const inside = (y: number, x: number) => y >= 0 && y < SIZE && x >= 0 && x < SIZE;

export function newBoard(): Board {
  const b: Board = Array.from({ length: SIZE }, () => Array<Stone | null>(SIZE).fill(null));
  // 通常のオセロと同じ配置。中央 4 駒はすべて歩(1)
  b[3][3] = { owner: 1, kind: "fu" };
  b[4][4] = { owner: 1, kind: "fu" };
  b[3][4] = { owner: 0, kind: "fu" };
  b[4][3] = { owner: 0, kind: "fu" };
  return b;
}

export const valueAt = (b: Board, [y, x]: Cell) => PIECES[b[y][x]!.kind].value;

/**
 * (r, c) に p が置いたときに取れる相手の駒の座標（方向ごと・置いたマスに近い順）。
 * 空きマスでなければ空配列
 */
export function capturesAt(b: Board, r: number, c: number, p: Player): Cell[] {
  if (b[r][c] !== null) return [];
  const out: Cell[] = [];
  for (const [dr, dc] of DIRS) {
    const cells: Cell[] = [];
    let y = r + dr;
    let x = c + dc;
    while (inside(y, x) && b[y][x] !== null && b[y][x]!.owner !== p) {
      cells.push([y, x]);
      y += dr;
      x += dc;
    }
    if (cells.length > 0 && inside(y, x) && b[y][x]?.owner === p) out.push(...cells);
  }
  return out;
}

/** 取った駒の数字の合計（= 相手へのダメージ） */
export const damageOf = (b: Board, cells: readonly Cell[]) => cells.reduce((s, cell) => s + valueAt(b, cell), 0);

export function emptyCells(b: Board): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (b[r][c] === null) out.push([r, c]);
  return out;
}

/** p が (r, c) に kind を置いた後の盤面と、取った駒（元の盤面は変更しない） */
export function applyMove(
  b: Board,
  p: Player,
  r: number,
  c: number,
  kind: PieceKind,
): { board: Board; captured: Cell[]; capturedKinds: PieceKind[] } {
  const captured = capturesAt(b, r, c, p);
  const nb = b.map((row) => row.slice());
  nb[r][c] = { owner: p, kind };
  const capturedKinds = captured.map(([y, x]) => b[y][x]!.kind);
  for (const [y, x] of captured) nb[y][x] = null;
  return { board: nb, captured, capturedKinds };
}

/** p が次の 1 手で与えられる最大ダメージ（置く駒の種類はダメージに無関係） */
export function bestCapture(b: Board, p: Player): number {
  let best = 0;
  for (const [r, c] of emptyCells(b)) {
    const cap = capturesAt(b, r, c, p);
    if (cap.length > 0) best = Math.max(best, damageOf(b, cap));
  }
  return best;
}

/** attacker が次の 1 手で取れる駒の座標（どこかに置けば取れる駒すべて） */
export function capturableBy(b: Board, attacker: Player): Cell[] {
  const seen = new Set<number>();
  const out: Cell[] = [];
  for (const [r, c] of emptyCells(b)) {
    for (const [y, x] of capturesAt(b, r, c, attacker)) {
      if (seen.has(y * SIZE + x)) continue;
      seen.add(y * SIZE + x);
      out.push([y, x]);
    }
  }
  return out;
}

const COLS = "abcdefgh";
/** 棋譜表記（列 a〜h + 行 1〜8。例: d3） */
export const cellName = (r: number, c: number) => `${COLS[c]}${r + 1}`;
