// 対局の進行（手番・パス・体力・終局判定）。sim/kyosho.py の play() / outcome() に対応する。
// 状態はイミュータブルに扱い、playMove は新しい GameState を返す。

import {
  applyMove,
  countStones,
  evaluate,
  legalMoves,
  newBoard,
  type Board,
  type Cell,
  type Move,
  type MoveEffect,
} from "./board";
import { KIND_ORDER, makeRules, type Hand, type PieceKind, type Player, type RuleOptions, type Rules } from "./rules";

export type EndReason = "ko" | "hp" | "discs" | "draw";

export interface GameResult {
  /** 勝者。引き分けは null */
  winner: Player | null;
  reason: EndReason;
}

export interface MoveEvent {
  type: "move";
  ply: number;
  player: Player;
  r: number;
  c: number;
  kind: PieceKind;
  attack: number;
  heal: number;
  flipped: Cell[];
}

export interface PassEvent {
  type: "pass";
  player: Player;
  /** no-move: 置ける場所がない / no-piece: 持ち駒が尽きた */
  reason: "no-move" | "no-piece";
}

export type GameEvent = MoveEvent | PassEvent;

export interface GameState {
  rules: Rules;
  board: Board;
  hands: [Hand, Hand];
  hp: [number, number];
  turn: Player;
  /** これまでに打たれた手数 */
  ply: number;
  history: GameEvent[];
  result: GameResult | null;
}

export function createGame(opts: RuleOptions): GameState {
  const rules = makeRules(opts);
  return {
    rules,
    board: newBoard(),
    hands: [{ ...rules.hand }, { ...rules.hand }],
    hp: [...rules.hp],
    turn: 0,
    ply: 0,
    history: [],
    result: null,
  };
}

/** 手持ちに残っている駒種 */
export function availableKinds(hand: Hand): PieceKind[] {
  return KIND_ORDER.filter((k) => hand[k] > 0);
}

/** p が今打てる手。持ち駒が尽きていれば空 */
export function movesFor(state: GameState, p: Player): Move[] {
  if (availableKinds(state.hands[p]).length === 0) return [];
  return legalMoves(state.board, p);
}

export function findMove(state: GameState, r: number, c: number): Move | undefined {
  return movesFor(state, state.turn).find((m) => m.r === r && m.c === c);
}

/** 手番のプレイヤーが (r, c) に kind を置いた場合の効果。置けなければ null */
export function previewMove(state: GameState, r: number, c: number, kind: PieceKind): MoveEffect | null {
  if (state.result || state.hands[state.turn][kind] <= 0) return null;
  const m = findMove(state, r, c);
  return m ? evaluate(state.board, m.lines, kind) : null;
}

/** 体力・石数・引き分けの順で勝敗を決める（体力 0 以下での決着以外） */
export function judge(hp: [number, number], board: Board): GameResult {
  if (hp[0] !== hp[1]) return { winner: hp[0] > hp[1] ? 0 : 1, reason: "hp" };
  const n = countStones(board);
  if (n[0] !== n[1]) return { winner: n[0] > n[1] ? 0 : 1, reason: "discs" };
  return { winner: null, reason: "draw" };
}

/** 手番のプレイヤーが (r, c) に kind を置く。不正な手は例外 */
export function playMove(state: GameState, r: number, c: number, kind: PieceKind): GameState {
  if (state.result) throw new Error("対局は終了しています");
  const p = state.turn;
  const q: Player = p === 0 ? 1 : 0;
  if (state.hands[p][kind] <= 0) throw new Error(`持ち駒に ${kind} がありません`);
  const m = findMove(state, r, c);
  if (!m) throw new Error(`(${r}, ${c}) には置けません`);

  const eff = evaluate(state.board, m.lines, kind);
  const hands: [Hand, Hand] = [{ ...state.hands[0] }, { ...state.hands[1] }];
  hands[p][kind]--;
  const hp: [number, number] = [...state.hp];
  hp[q] -= eff.attack;
  hp[p] += eff.heal;
  const ply = state.ply + 1;
  const history: GameEvent[] = [
    ...state.history,
    { type: "move", ply, player: p, r, c, kind, attack: eff.attack, heal: eff.heal, flipped: eff.flipped },
  ];
  const next: GameState = {
    ...state,
    board: applyMove(state.board, p, r, c, m.lines, kind),
    hands,
    hp,
    ply,
    history,
  };

  // 体力 0 以下になった時点で即敗北
  if (hp[q] <= 0) return { ...next, result: { winner: p, reason: "ko" } };

  // 相手が打てれば相手番。打てなければ相手はパスし、自分が続けて打つ。両者打てなければ終局
  if (movesFor(next, q).length > 0) return { ...next, turn: q };
  if (movesFor(next, p).length > 0) {
    const reason = availableKinds(hands[q]).length === 0 ? "no-piece" : "no-move";
    return { ...next, turn: p, history: [...history, { type: "pass", player: q, reason }] };
  }
  return { ...next, result: judge(hp, next.board) };
}
