// 対局の進行（手番・パス・体力・終局判定）。sim/capture.py の play() / outcome() に対応する。
// 状態はイミュータブルに扱い、playMove は新しい GameState を返す。

import {
  applyMove,
  bestCapture,
  capturableBy,
  capturesAt,
  damageOf,
  emptyCells,
  newBoard,
  type Board,
  type Cell,
} from "./board";
import {
  INITIAL_HAND,
  INITIAL_HP,
  KIND_ORDER,
  MAX_PLIES,
  other,
  type Hand,
  type PieceKind,
  type Player,
} from "./rules";

/** ko: 体力 0 以下 / limit: 総手数の上限に到達 / stalled: 両者とも持ち駒が尽きた */
export type EndReason = "ko" | "limit" | "stalled";

export interface GameResult {
  /** 勝者。引き分けは null */
  winner: Player | null;
  reason: EndReason;
}

export interface CapturedPiece {
  r: number;
  c: number;
  kind: PieceKind;
}

export interface MoveEvent {
  type: "move";
  ply: number;
  player: Player;
  r: number;
  c: number;
  kind: PieceKind;
  /** 取った駒（取った側の持ち駒に入った） */
  captured: CapturedPiece[];
  damage: number;
}

/** 持ち駒が尽きて打てない手番 */
export interface PassEvent {
  type: "pass";
  player: Player;
}

export type GameEvent = MoveEvent | PassEvent;

export interface GameState {
  board: Board;
  hands: [Hand, Hand];
  hp: [number, number];
  turn: Player;
  /** これまでに打たれた手数（パスは数えない） */
  ply: number;
  history: GameEvent[];
  result: GameResult | null;
}

export function createGame(): GameState {
  return {
    board: newBoard(),
    hands: [{ ...INITIAL_HAND }, { ...INITIAL_HAND }],
    hp: [INITIAL_HP, INITIAL_HP],
    turn: 0,
    ply: 0,
    history: [],
    result: null,
  };
}

/** 手持ちに残っている駒種（数字の小さい順） */
export function availableKinds(hand: Hand): PieceKind[] {
  return KIND_ORDER.filter((k) => hand[k] > 0);
}

/** p が打てるか（持ち駒があり、空きマスがある） */
export function canMove(state: Pick<GameState, "board" | "hands">, p: Player): boolean {
  return availableKinds(state.hands[p]).length > 0 && emptyCells(state.board).length > 0;
}

/** 手番のプレイヤーが置けるマスか（空いていればどこでも置ける） */
export function isPlayable(state: GameState, r: number, c: number): boolean {
  return !state.result && state.board[r][c] === null && availableKinds(state.hands[state.turn]).length > 0;
}

/** 体力の多い方の勝ち。同じなら引き分け */
export function judge(hp: [number, number], reason: Exclude<EndReason, "ko">): GameResult {
  return { winner: hp[0] === hp[1] ? null : hp[0] > hp[1] ? 0 : 1, reason };
}

export interface Preview {
  /** 取れる相手の駒 */
  captured: Cell[];
  damage: number;
  /** この手の後、相手が次の 1 手で取れる自分の駒（置いた駒を含む）。対局が終わる手なら空 */
  exposed: Cell[];
  /** 相手が次の 1 手で与えられる最大ダメージ */
  exposedDamage: number;
}

/** 手番のプレイヤーが (r, c) に kind を置いた場合の結果。置けなければ null */
export function previewMove(state: GameState, r: number, c: number, kind: PieceKind): Preview | null {
  if (!isPlayable(state, r, c) || state.hands[state.turn][kind] <= 0) return null;
  const p = state.turn;
  const q = other(p);
  const captured = capturesAt(state.board, r, c, p);
  const damage = damageOf(state.board, captured);
  const { board } = applyMove(state.board, p, r, c, kind);
  const ends = damage >= state.hp[q] || state.ply + 1 >= MAX_PLIES;
  // 相手は着手前の持ち駒のまま（取った駒は自分の持ち駒に入る）
  if (ends || availableKinds(state.hands[q]).length === 0) return { captured, damage, exposed: [], exposedDamage: 0 };
  return { captured, damage, exposed: capturableBy(board, q), exposedDamage: bestCapture(board, q) };
}

/** victim の駒のうち、相手が次の 1 手で取れるもの（相手に持ち駒がなければ空） */
export function threatenedPieces(state: GameState, victim: Player): Cell[] {
  const attacker = other(victim);
  if (state.result || availableKinds(state.hands[attacker]).length === 0) return [];
  return capturableBy(state.board, attacker);
}

/** 手番のプレイヤーが (r, c) に kind を置く。不正な手は例外 */
export function playMove(state: GameState, r: number, c: number, kind: PieceKind): GameState {
  if (state.result) throw new Error("対局は終了しています");
  const p = state.turn;
  const q = other(p);
  if (state.hands[p][kind] <= 0) throw new Error(`持ち駒に ${kind} がありません`);
  if (state.board[r][c] !== null) throw new Error(`(${r}, ${c}) は空いていません`);

  const { board, captured, capturedKinds } = applyMove(state.board, p, r, c, kind);
  const damage = damageOf(state.board, captured);
  const hands: [Hand, Hand] = [{ ...state.hands[0] }, { ...state.hands[1] }];
  hands[p][kind]--;
  // 取った駒は数字そのままで自分の持ち駒になる
  for (const k of capturedKinds) hands[p][k]++;
  const hp: [number, number] = [...state.hp];
  hp[q] -= damage;
  const ply = state.ply + 1;
  const history: GameEvent[] = [
    ...state.history,
    {
      type: "move",
      ply,
      player: p,
      r,
      c,
      kind,
      captured: captured.map(([y, x], i) => ({ r: y, c: x, kind: capturedKinds[i] })),
      damage,
    },
  ];
  const next: GameState = { ...state, board, hands, hp, ply, history };

  // 体力 0 以下になった時点で即敗北
  if (hp[q] <= 0) return { ...next, result: { winner: p, reason: "ko" } };
  if (ply >= MAX_PLIES) return { ...next, result: judge(hp, "limit") };

  // 相手が打てれば相手番。打てなければ相手はパスし、自分が続けて打つ。両者打てなければ終局
  if (canMove(next, q)) return { ...next, turn: q };
  if (canMove(next, p)) return { ...next, turn: p, history: [...history, { type: "pass", player: q }] };
  return { ...next, result: judge(hp, "stalled") };
}
