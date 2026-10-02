// 盤面の操作と、挟んだ列・ダメージ・回復の計算。
// sim/kyosho.py（lines_for / evaluate / apply）・sim/capture.py（captures / apply）・sim/gate.py（flips）に対応する。

import { DEFAULT_VALUES, PIECES, type PieceKind, type PieceValues, type Player, type Reach, type RuleSet } from "./rules";

export const SIZE = 8;

/** 盤上の駒。数字は駒の種類から RuleSet.values で決まる（返されても種類・数字とも変わらない） */
export interface Stone {
  owner: Player;
  kind: PieceKind;
}

/** board[行][列]。行 0 が盤の上端 */
export type Board = (Stone | null)[][];

export type Cell = readonly [number, number];

/** 挟んだ 1 方向の列 */
export interface Line {
  /** 置いたマスから見た向き [行, 列]（各 −1・0・1） */
  dir: Cell;
  /** 挟んだ相手の駒（置いたマスに近い順） */
  cells: Cell[];
  /** 反対端の自分の駒の数字 */
  end: number;
  /** 反対端の自分の駒のマス（方向ごとに別のマス） */
  endAt: Cell;
  /** 挟んだ駒の数字の最大値（強さ制限の判定に使う） */
  top: number;
}

const DIRS: readonly Cell[] = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];

/** 駒の方向でその向きの列を挟めるか */
const REACHES: Record<Reach, (dr: number, dc: number) => boolean> = {
  vertical: (_, dc) => dc === 0,
  horizontal: (dr) => dr === 0,
  diagonal: (dr, dc) => dr !== 0 && dc !== 0,
  orthogonal: (dr, dc) => dr === 0 || dc === 0,
  all: () => true,
};

export const reaches = (kind: PieceKind, [dr, dc]: Cell) => REACHES[PIECES[kind].reach](dr, dc);

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

export const valueAt = (b: Board, [y, x]: Cell, values: PieceValues = DEFAULT_VALUES) => values[b[y][x]!.kind];

/**
 * (r, c) に p が置いたときに挟める列（8 方向ごと。駒の方向・強さ制限は見ない）。
 * 空きマスでなければ空配列
 */
export function rawLines(b: Board, r: number, c: number, p: Player, values: PieceValues = DEFAULT_VALUES): Line[] {
  if (b[r][c] !== null) return [];
  const out: Line[] = [];
  for (const [dr, dc] of DIRS) {
    const cells: Cell[] = [];
    let top = 0;
    let y = r + dr;
    let x = c + dc;
    while (inside(y, x) && b[y][x] !== null && b[y][x]!.owner !== p) {
      cells.push([y, x]);
      top = Math.max(top, values[b[y][x]!.kind]);
      y += dr;
      x += dc;
    }
    const end = inside(y, x) ? b[y][x] : null;
    if (cells.length > 0 && end?.owner === p) out.push({ dir: [dr, dc], cells, end: values[end.kind], endAt: [y, x], top });
  }
  return out;
}

/** 強さ制限ありなら、置いた駒（数字 placed）より大きい駒を含む列を除く */
export const gateLines = (lines: readonly Line[], placed: number, gate: boolean): Line[] =>
  gate ? lines.filter((l) => l.top <= placed) : lines.slice();

/** 挟める方向が「駒ごと」なら、kind の方向の列だけにする */
export const dirLines = (lines: readonly Line[], kind: PieceKind, rules: RuleSet): Line[] =>
  rules.dirs === "piece" ? lines.filter((l) => reaches(kind, l.dir)) : lines.slice();

/** rawLines の列のうち、kind を置いたときに返せる（取れる）列（駒の方向と強さ制限で絞る） */
export const pieceLines = (lines: readonly Line[], kind: PieceKind, rules: RuleSet): Line[] =>
  gateLines(dirLines(lines, kind, rules), rules.values[kind], rules.gate);

/** (r, c) に p が kind を置いたときに返せる（取れる）列 */
export const linesFor = (b: Board, r: number, c: number, p: Player, kind: PieceKind, rules: RuleSet): Line[] =>
  pieceLines(rawLines(b, r, c, p, rules.values), kind, rules);

/** 列に含まれる相手の駒（方向順・置いたマスに近い順） */
export const targetsOf = (lines: readonly Line[]): Cell[] => lines.flatMap((l) => l.cells);

/** 返した（取った）駒の数字の列（方向順） */
const valuesOf = (b: Board, lines: readonly Line[], values: PieceValues) =>
  lines.flatMap((l) => l.cells.map((cell) => valueAt(b, cell, values)));

/** 返した（取った）駒によるダメージ（端の駒の上乗せを除く）。何も返さなければ 0 */
export function baseDamageOf(b: Board, lines: readonly Line[], rules: RuleSet): number {
  const vs = valuesOf(b, lines, rules.values);
  if (vs.length === 0) return 0;
  if (rules.damage === "sum") return vs.reduce((s, v) => s + v, 0);
  return Math.max(...vs) + Math.floor(vs.length / 4);
}

/**
 * 端の駒の上乗せに使う駒のマス（端の駒の力が「攻撃に上乗せ」のときだけ）。
 * 返した（取った）列ごとに反対端の自分の駒。列は方向ごとに 1 本なので同じ駒が 2 回入ることはない
 */
export const anchorsOf = (lines: readonly Line[], rules: RuleSet): Cell[] =>
  rules.anchor === "attack" ? lines.map((l) => l.endAt) : [];

/** 端の駒の上乗せ（列ごとの反対端の自分の駒の数字の合計）。なしなら 0 */
export function anchorBonusOf(lines: readonly Line[], rules: RuleSet): number {
  if (rules.anchor !== "attack") return 0;
  let n = 0;
  for (const l of lines) n += l.end;
  return n;
}

/** ダメージ（返した駒の分 ＋ 端の駒の上乗せ）。何も返さなければ 0 */
export const damageOf = (b: Board, lines: readonly Line[], rules: RuleSet): number =>
  baseDamageOf(b, lines, rules) + anchorBonusOf(lines, rules);

/** 回復。挟んだ両端（置いた駒と反対端の自駒）から方向ごとに求め、最大の 1 方向分 */
export function healOf(lines: readonly Line[], placed: number, rules: RuleSet): number {
  if (rules.heal === "none" || lines.length === 0) return 0;
  const per = lines.map((l) =>
    rules.heal === "avg" ? Math.floor((placed + l.end) / 2) : Math.max(0, Math.min(placed, l.end) - 1),
  );
  return Math.max(...per);
}

export function emptyCells(b: Board): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (b[r][c] === null) out.push([r, c]);
  return out;
}

/**
 * p が (r, c) に kind を置き、lines を返した（取った）後の盤面（元の盤面は変更しない）。
 * flip なら色だけ変わり数字は残る。capture なら盤から消える
 */
export function applyLines(
  b: Board,
  p: Player,
  r: number,
  c: number,
  kind: PieceKind,
  lines: readonly Line[],
  rules: RuleSet,
): Board {
  const nb = b.map((row) => row.slice());
  nb[r][c] = { owner: p, kind };
  for (const [y, x] of targetsOf(lines)) nb[y][x] = rules.action === "flip" ? { owner: p, kind: b[y][x]!.kind } : null;
  return nb;
}

/** 盤上の石数 [先手, 後手] */
export function discCount(b: Board): [number, number] {
  const n: [number, number] = [0, 0];
  for (const row of b) for (const s of row) if (s) n[s.owner]++;
  return n;
}

const COLS = "abcdefgh";
/** 棋譜表記（列 a〜h + 行 1〜8。例: d3） */
export const cellName = (r: number, c: number) => `${COLS[c]}${r + 1}`;
