// 盤面の操作と 1 手の攻撃・回復の計算（sim/kyosho.py の lines_for / legal_moves / evaluate / apply に対応）

import { COUNT_DIV, HEAL_MINUS, PIECES, type PieceKind, type Player } from "./rules";

export const SIZE = 8;

export interface Stone {
  owner: Player;
  /** 盤上の数値。返されても変わらない */
  value: number;
  /** 表示用の駒種（初期 4 駒は歩） */
  kind: PieceKind;
}

/** board[行][列]。行 0 が盤の上端 */
export type Board = (Stone | null)[][];

export type Cell = readonly [number, number];

/** 1 方向で挟んだ列 */
export interface Line {
  /** 返る相手の駒の座標（置いたマスに近い順） */
  cells: Cell[];
  /** 反対側の端にある自分の駒の数値 */
  endValue: number;
}

export interface Move {
  r: number;
  c: number;
  lines: Line[];
}

export interface MoveEffect {
  attack: number;
  heal: number;
  /** 返した駒の座標 */
  flipped: Cell[];
  /** 返した駒の最大値 */
  maxFlipped: number;
}

const DIRS: readonly Cell[] = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];

const inside = (y: number, x: number) => y >= 0 && y < SIZE && x >= 0 && x < SIZE;

export function newBoard(): Board {
  const b: Board = Array.from({ length: SIZE }, () => Array<Stone | null>(SIZE).fill(null));
  // 通常のオセロと同じ配置。中央 4 駒はすべて歩(1)
  b[3][3] = { owner: 1, value: 1, kind: "fu" };
  b[4][4] = { owner: 1, value: 1, kind: "fu" };
  b[3][4] = { owner: 0, value: 1, kind: "fu" };
  b[4][3] = { owner: 0, value: 1, kind: "fu" };
  return b;
}

/** (r, c) に p が置いたときに挟める列。置けなければ空配列 */
export function linesFor(b: Board, r: number, c: number, p: Player): Line[] {
  if (b[r][c] !== null) return [];
  const out: Line[] = [];
  for (const [dr, dc] of DIRS) {
    const cells: Cell[] = [];
    let y = r + dr;
    let x = c + dc;
    while (inside(y, x) && b[y][x] !== null && b[y][x]!.owner !== p) {
      cells.push([y, x]);
      y += dr;
      x += dc;
    }
    if (cells.length > 0 && inside(y, x) && b[y][x]?.owner === p) {
      out.push({ cells, endValue: b[y][x]!.value });
    }
  }
  return out;
}

/** p の合法手（持ち駒の有無は見ない） */
export function legalMoves(b: Board, p: Player): Move[] {
  const out: Move[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const lines = linesFor(b, r, c, p);
      if (lines.length > 0) out.push({ r, c, lines });
    }
  }
  return out;
}

/**
 * 駒種 kind でその手を打ったときの攻撃・回復。
 * 攻撃 = 返した駒の最大値 × 倍率 + 返した枚数 ÷ 4（切り捨て）
 * 回復 = 挟んだ方向ごとの max(0, min(置いた駒, 端の自駒) − 1) のうち最大の 1 方向分
 */
export function evaluate(b: Board, lines: Line[], kind: PieceKind): MoveEffect {
  const spec = PIECES[kind];
  const flipped = lines.flatMap((l) => l.cells);
  const maxFlipped = Math.max(...flipped.map(([y, x]) => b[y][x]!.value));
  const attack = maxFlipped * spec.mult + Math.floor(flipped.length / COUNT_DIV);
  const heal = Math.max(0, Math.max(...lines.map((l) => Math.min(spec.value, l.endValue))) - HEAL_MINUS);
  return { attack, heal, flipped, maxFlipped };
}

/** 着手後の新しい盤面（元の盤面は変更しない） */
export function applyMove(b: Board, p: Player, r: number, c: number, lines: Line[], kind: PieceKind): Board {
  const nb = b.map((row) => row.slice());
  nb[r][c] = { owner: p, value: PIECES[kind].value, kind };
  for (const l of lines) {
    for (const [y, x] of l.cells) {
      // 色だけ変わり、数値と駒種は残る
      nb[y][x] = { ...nb[y][x]!, owner: p };
    }
  }
  return nb;
}

export function countStones(b: Board): [number, number] {
  const n: [number, number] = [0, 0];
  for (const row of b) for (const s of row) if (s) n[s.owner]++;
  return n;
}

const COLS = "abcdefgh";
/** 棋譜表記（列 a〜h + 行 1〜8。例: d3） */
export const cellName = (r: number, c: number) => `${COLS[c]}${r + 1}`;
