// 対局の進行（合法手・手番・パス・体力・終局判定）。sim/*.py の play() / outcome() に対応する。
// 状態はイミュータブルに扱い、playMove は新しい GameState を返す。

import {
  applyLines,
  damageOf,
  discCount,
  emptyCells,
  gateLines,
  healOf,
  linesFor,
  newBoard,
  rawLines,
  SIZE,
  targetsOf,
  type Board,
  type Cell,
  type Line,
} from "./board";
import {
  cloneRules,
  defaultRules,
  KIND_ORDER,
  other,
  PIECES,
  type Hand,
  type PieceKind,
  type Player,
  type RuleSet,
} from "./rules";

/** ko: 体力 0 以下 / limit: 手数上限に到達 / stalled: 両者とも打てない（持ち駒切れ・置ける所なし） */
export type EndReason = "ko" | "limit" | "stalled";

export interface GameResult {
  /** 勝者。引き分けは null */
  winner: Player | null;
  reason: EndReason;
  /** 体力が同じで、石数で勝敗を決めた */
  byDiscs: boolean;
}

/** 返した（取った）駒 */
export interface Target {
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
  /** 返した駒（flip）・取って持ち駒に入れた駒（capture） */
  targets: Target[];
  damage: number;
  heal: number;
}

/** 打てない手番。noPieces: 持ち駒切れ / noMoves: 置けるマスがない */
export interface PassEvent {
  type: "pass";
  player: Player;
  reason: "noPieces" | "noMoves";
}

export type GameEvent = MoveEvent | PassEvent;

export interface GameState {
  rules: RuleSet;
  board: Board;
  hands: [Hand, Hand];
  hp: [number, number];
  turn: Player;
  /** これまでに打たれた手数（パスは数えない） */
  ply: number;
  history: GameEvent[];
  result: GameResult | null;
}

/** 最後に打たれた手（パスは飛ばす） */
export function lastMoveOf(state: Pick<GameState, "history">): MoveEvent | undefined {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const e = state.history[i];
    if (e.type === "move") return e;
  }
  return undefined;
}

/** 手持ちに残っている駒種（数字の小さい順） */
export function availableKinds(hand: Hand): PieceKind[] {
  return KIND_ORDER.filter((k) => hand[k] > 0);
}

/** p が (r, c) に kind を置ける場合に返せる（取れる）列。置けなければ null */
function legalLines(rules: RuleSet, board: Board, hand: Hand, p: Player, r: number, c: number, kind: PieceKind): Line[] | null {
  if (board[r][c] !== null || hand[kind] <= 0) return null;
  const lines = linesFor(board, r, c, p, kind, rules);
  // 裏返すルールは 1 枚以上返せるマスにしか置けない。取るルールは空きマスならどこでも置ける
  if (rules.action === "flip" && lines.length === 0) return null;
  return lines;
}

/** p に打てる手が 1 つでもあるか */
function hasMove(rules: RuleSet, board: Board, hand: Hand, p: Player): boolean {
  const kinds = availableKinds(hand);
  if (kinds.length === 0) return false;
  const empties = emptyCells(board);
  if (rules.action === "capture") return empties.length > 0;
  // 強さ制限があっても、数字の最も大きい駒で返せなければどの駒でも返せない
  const strongest = PIECES[kinds[kinds.length - 1]].value;
  return empties.some(([r, c]) => gateLines(rawLines(board, r, c, p), strongest, rules.gate).length > 0);
}

export function canMove(state: Pick<GameState, "rules" | "board" | "hands">, p: Player): boolean {
  return hasMove(state.rules, state.board, state.hands[p], p);
}

/** 体力の多い方の勝ち。同じなら石数の多い方、それも同じなら引き分け */
export function judge(board: Board, hp: readonly [number, number], reason: Exclude<EndReason, "ko">): GameResult {
  if (hp[0] !== hp[1]) return { winner: hp[0] > hp[1] ? 0 : 1, reason, byDiscs: false };
  const [d0, d1] = discCount(board);
  return { winner: d0 === d1 ? null : d0 > d1 ? 0 : 1, reason, byDiscs: d0 !== d1 };
}

/** 手番を決める。turn が打てなければパスして相手へ、両者打てなければ終局 */
function settleTurn(state: GameState, turn: Player): GameState {
  if (canMove(state, turn)) return { ...state, turn };
  const q = other(turn);
  if (canMove(state, q)) {
    const reason = availableKinds(state.hands[turn]).length === 0 ? "noPieces" : "noMoves";
    return { ...state, turn: q, history: [...state.history, { type: "pass", player: turn, reason }] };
  }
  return { ...state, turn, result: judge(state.board, state.hp, "stalled") };
}

export function createGame(rules: RuleSet = defaultRules()): GameState {
  const r = cloneRules(rules);
  const g: GameState = {
    rules: r,
    board: newBoard(),
    hands: [{ ...r.hand }, { ...r.hand }],
    hp: [r.hp[0], r.hp[1]],
    turn: 0,
    ply: 0,
    history: [],
    result: null,
  };
  // 持ち駒が 0 個などで先手が打てない設定もありうる
  return settleTurn(g, 0);
}

/** 手番のプレイヤーが (r, c) に kind を置けるか */
export function isLegal(state: GameState, r: number, c: number, kind: PieceKind): boolean {
  if (state.result) return false;
  return legalLines(state.rules, state.board, state.hands[state.turn], state.turn, r, c, kind) !== null;
}

/** 手番のプレイヤーが kind を置けるマス */
export function legalCells(state: GameState, kind: PieceKind): Cell[] {
  if (state.result) return [];
  return emptyCells(state.board).filter(([r, c]) => isLegal(state, r, c, kind));
}

/** 手番のプレイヤーが置ける駒種（置けるマスが 1 つ以上ある駒。数字の小さい順） */
export function playableKinds(state: GameState): PieceKind[] {
  if (state.result) return [];
  return availableKinds(state.hands[state.turn]).filter((k) => legalCells(state, k).length > 0);
}

/** 手番のプレイヤーが (r, c) に kind を置いたときに返せる（取れる）相手の駒。置けなければ空 */
export function targetsAt(state: GameState, r: number, c: number, kind: PieceKind): Cell[] {
  const lines = state.result ? null : legalLines(state.rules, state.board, state.hands[state.turn], state.turn, r, c, kind);
  return lines ? targetsOf(lines) : [];
}

/** attacker が次の 1 手で返せる（取れる）駒の座標（持ち駒のどれかでどこかに置けば返せる駒すべて） */
export function attackable(rules: RuleSet, board: Board, hand: Hand, attacker: Player): Cell[] {
  const kinds = availableKinds(hand);
  if (kinds.length === 0) return [];
  // 強さ制限があっても、最も大きい駒で返せる列が返せる列のすべて
  const strongest = PIECES[kinds[kinds.length - 1]].value;
  const seen = new Set<number>();
  const out: Cell[] = [];
  for (const [r, c] of emptyCells(board)) {
    for (const [y, x] of targetsOf(gateLines(rawLines(board, r, c, attacker), strongest, rules.gate))) {
      if (seen.has(y * SIZE + x)) continue;
      seen.add(y * SIZE + x);
      out.push([y, x]);
    }
  }
  return out;
}

/** p が次の 1 手で得られる最大の (ダメージ, ダメージ + 回復)。打てなければ 0 */
export function bestReply(rules: RuleSet, board: Board, hand: Hand, p: Player): { damage: number; score: number } {
  const kinds = availableKinds(hand);
  let damage = 0;
  let score = 0;
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p);
    if (raw.length === 0) continue;
    for (const k of kinds) {
      const v = PIECES[k].value;
      const lines = gateLines(raw, v, rules.gate);
      if (lines.length === 0) continue;
      const d = damageOf(board, lines, rules);
      damage = Math.max(damage, d);
      score = Math.max(score, d + healOf(lines, v, rules));
    }
  }
  return { damage, score };
}

export interface Preview {
  /** 返せる（取れる）相手の駒 */
  targets: Cell[];
  damage: number;
  heal: number;
  /** この手の後、相手が次の 1 手で返せる（取れる）自分の駒（置いた駒を含む）。対局が終わる手なら空 */
  exposed: Cell[];
  /** 相手が次の 1 手で与えられる最大ダメージ */
  exposedDamage: number;
}

/** 手番のプレイヤーが (r, c) に kind を置いた場合の結果。置けなければ null */
export function previewMove(state: GameState, r: number, c: number, kind: PieceKind): Preview | null {
  if (state.result) return null;
  const { rules } = state;
  const p = state.turn;
  const q = other(p);
  const lines = legalLines(rules, state.board, state.hands[p], p, r, c, kind);
  if (!lines) return null;
  const targets = targetsOf(lines);
  const damage = damageOf(state.board, lines, rules);
  const heal = healOf(lines, PIECES[kind].value, rules);
  const board = applyLines(state.board, p, r, c, kind, lines, rules);
  const ends = damage >= state.hp[q] || (rules.maxPlies > 0 && state.ply + 1 >= rules.maxPlies);
  if (ends) return { targets, damage, heal, exposed: [], exposedDamage: 0 };
  // 相手の持ち駒は自分の着手で変わらない（取った駒は自分の持ち駒に入る）
  return {
    targets,
    damage,
    heal,
    exposed: attackable(rules, board, state.hands[q], q),
    exposedDamage: bestReply(rules, board, state.hands[q], q).damage,
  };
}

/** victim の駒のうち、相手が次の 1 手で返せる（取れる）もの */
export function threatenedPieces(state: GameState, victim: Player): Cell[] {
  if (state.result) return [];
  const attacker = other(victim);
  return attackable(state.rules, state.board, state.hands[attacker], attacker);
}

/** 手番のプレイヤーが (r, c) に kind を置く。不正な手は例外 */
export function playMove(state: GameState, r: number, c: number, kind: PieceKind): GameState {
  if (state.result) throw new Error("対局は終了しています");
  const { rules } = state;
  const p = state.turn;
  const q = other(p);
  if (state.hands[p][kind] <= 0) throw new Error(`持ち駒に ${kind} がありません`);
  if (state.board[r][c] !== null) throw new Error(`(${r}, ${c}) は空いていません`);
  const lines = legalLines(rules, state.board, state.hands[p], p, r, c, kind);
  if (!lines) throw new Error(`(${r}, ${c}) に ${kind} を置いても返せる駒がありません`);

  const targets: Target[] = targetsOf(lines).map(([y, x]) => ({ r: y, c: x, kind: state.board[y][x]!.kind }));
  const damage = damageOf(state.board, lines, rules);
  const heal = healOf(lines, PIECES[kind].value, rules);
  const board = applyLines(state.board, p, r, c, kind, lines, rules);
  const hands: [Hand, Hand] = [{ ...state.hands[0] }, { ...state.hands[1] }];
  hands[p][kind]--;
  // 取るルールでは、取った駒が数字そのままで自分の持ち駒になる
  if (rules.action === "capture") for (const t of targets) hands[p][t.kind]++;
  const hp: [number, number] = [...state.hp];
  hp[q] -= damage;
  hp[p] += heal;
  const ply = state.ply + 1;
  const history: GameEvent[] = [...state.history, { type: "move", ply, player: p, r, c, kind, targets, damage, heal }];
  const next: GameState = { ...state, board, hands, hp, ply, history };

  // 体力 0 以下になった時点で即敗北
  if (hp[q] <= 0) return { ...next, result: { winner: p, reason: "ko", byDiscs: false } };
  if (rules.maxPlies > 0 && ply >= rules.maxPlies) return { ...next, result: judge(board, hp, "limit") };
  // 相手が打てれば相手番。打てなければ相手はパスし、自分が続けて打つ。両者打てなければ終局
  return settleTurn(next, q);
}
