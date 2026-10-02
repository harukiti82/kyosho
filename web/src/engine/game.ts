// 対局の進行（合法手・手番・パス・体力・終局判定）。sim/*.py の play() / outcome() に対応する。
// 状態はイミュータブルに扱い、playMove は新しい GameState を返す。
// 隠し王の真の状態（GameState.kings）は、UI・CPU からは viewFor() / kingInfo() を通してしか見ない。

import {
  applyLines,
  damageOf,
  discCount,
  emptyCells,
  healOf,
  linesFor,
  newBoard,
  pieceLines,
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
  type Hand,
  type PieceKind,
  type Player,
  type RuleSet,
} from "./rules";

/** ko: 体力 0 以下 / limit: 手数上限に到達 / stalled: 両者とも打てない（持ち駒切れ・置ける所なし） / king: 王を返された（罰が即負け） */
export type EndReason = "ko" | "limit" | "stalled" | "king";

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
  /** 相手の隠し王を返した（取った）。王はこの手で公開される。返していなければキー自体がない */
  king?: KingHit;
}

/** 相手の王を返した（取った）ときの記録（公開情報） */
export interface KingHit {
  /** 王の駒のマスと駒種 */
  r: number;
  c: number;
  kind: PieceKind;
  /** 通常のダメージに加えて減らした体力（即負けなら 0） */
  penalty: number;
  /** 罰が即負け */
  lose: boolean;
}

/** 隠し王の真の状態（プレイヤーごと） */
export interface KingState {
  /** 王の駒を置いたマス。未指定なら null */
  cell: Cell | null;
  /** 期限の手で自動的に決まった */
  auto: boolean;
  /** 相手に返されて公開された（以後ふつうの駒） */
  revealed: boolean;
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
  /**
   * 隠し王の真の状態 [先手, 後手]。相手の王の場所は隠し情報なので、UI・CPU はここを直接読まない
   * （CPU は viewFor()、UI は viewFor() / kingInfo() を手番・見ている側に限って使う）
   */
  kings: [KingState, KingState];
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
  // 駒の方向・強さ制限で返せる列は駒ごとに違うので、持っている駒すべてで調べる
  return empties.some(([r, c]) => {
    const raw = rawLines(board, r, c, p, rules.values);
    return raw.length > 0 && kinds.some((k) => pieceLines(raw, k, rules).length > 0);
  });
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
    kings: [noKing(), noKing()],
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

/**
 * attacker が次の 1 手で返せる（取れる）駒の座標（持ち駒のどれかでどこかに置けば返せる駒すべて）。
 * 挟める方向が「駒ごと」なら、attacker の持ち駒の方向で挟める列だけ
 */
export function attackable(rules: RuleSet, board: Board, hand: Hand, attacker: Player): Cell[] {
  const kinds = availableKinds(hand);
  if (kinds.length === 0) return [];
  const seen = new Set<number>();
  const out: Cell[] = [];
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, attacker, rules.values);
    if (raw.length === 0) continue;
    // 列は方向ごとに 1 本なので、どれかの駒で返せる列を集めれば重複しない
    const lines = raw.filter((l) => kinds.some((k) => pieceLines([l], k, rules).length > 0));
    for (const [y, x] of targetsOf(lines)) {
      if (seen.has(y * SIZE + x)) continue;
      seen.add(y * SIZE + x);
      out.push([y, x]);
    }
  }
  return out;
}

/**
 * p が次の 1 手で得られる最大の (ダメージ, ダメージ + 回復)。打てなければ 0。
 * king を渡すと、そのマスの駒（相手の王）を返す手の score に penalty を足す（CPU の読み用。damage には足さない）
 */
export function bestReply(
  rules: RuleSet,
  board: Board,
  hand: Hand,
  p: Player,
  king?: { cell: Cell; penalty: number },
): { damage: number; score: number } {
  const kinds = availableKinds(hand);
  let damage = 0;
  let score = 0;
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p, rules.values);
    if (raw.length === 0) continue;
    for (const k of kinds) {
      const v = rules.values[k];
      const lines = pieceLines(raw, k, rules);
      if (lines.length === 0) continue;
      const d = damageOf(board, lines, rules);
      damage = Math.max(damage, d);
      const hit = king && lines.some((l) => l.cells.some(([y, x]) => y === king.cell[0] && x === king.cell[1]));
      score = Math.max(score, d + healOf(lines, v, rules) + (hit ? king.penalty : 0));
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
  const heal = healOf(lines, rules.values[kind], rules);
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

/** 手番のプレイヤーが (r, c) に kind を置く。opts.king なら置いた駒を自分の王にする（隠し王）。不正な手は例外 */
export function playMove(state: GameState, r: number, c: number, kind: PieceKind, opts: { king?: boolean } = {}): GameState {
  if (state.result) throw new Error("対局は終了しています");
  const { rules } = state;
  const p = state.turn;
  const q = other(p);
  if (state.hands[p][kind] <= 0) throw new Error(`持ち駒に ${kind} がありません`);
  if (state.board[r][c] !== null) throw new Error(`(${r}, ${c}) は空いていません`);
  const lines = legalLines(rules, state.board, state.hands[p], p, r, c, kind);
  if (!lines) throw new Error(`(${r}, ${c}) に ${kind} を置いても返せる駒がありません`);
  const mine = kingInfo(state, p);
  if (opts.king && !mine.canDesignate) throw new Error("王はもう指定できません");

  const targets: Target[] = targetsOf(lines).map(([y, x]) => ({ r: y, c: x, kind: state.board[y][x]!.kind }));
  const damage = damageOf(state.board, lines, rules);
  const heal = healOf(lines, rules.values[kind], rules);
  const board = applyLines(state.board, p, r, c, kind, lines, rules);
  const hands: [Hand, Hand] = [{ ...state.hands[0] }, { ...state.hands[1] }];
  hands[p][kind]--;
  // 取るルールでは、取った駒が数字そのままで自分の持ち駒になる
  if (rules.action === "capture") for (const t of targets) hands[p][t.kind]++;

  const kings: [KingState, KingState] = [state.kings[0], state.kings[1]];
  // 王の指定。期限の手までに指定しなければ、期限の手で置いた駒が自動で王になる
  if (mine.canDesignate && (opts.king || mine.forcedNow)) kings[p] = { cell: [r, c], auto: !opts.king, revealed: false };
  // 相手の隠れた王を返した（取った）ら、罰を与えて王を公開する
  let hit: KingHit | undefined;
  const qk = kings[q];
  if (rules.king.on && qk.cell && !qk.revealed && targets.some((t) => t.r === qk.cell![0] && t.c === qk.cell![1])) {
    const lose = rules.king.penalty === "lose";
    hit = { r: qk.cell[0], c: qk.cell[1], kind: state.board[qk.cell[0]][qk.cell[1]]!.kind, penalty: lose ? 0 : rules.king.amount, lose };
    kings[q] = { ...qk, revealed: true };
  }

  const hp: [number, number] = [...state.hp];
  hp[q] -= damage + (hit?.penalty ?? 0);
  hp[p] += heal;
  const ply = state.ply + 1;
  const move: MoveEvent = { type: "move", ply, player: p, r, c, kind, targets, damage, heal };
  if (hit) move.king = hit;
  const history: GameEvent[] = [...state.history, move];
  const next: GameState = { ...state, board, hands, hp, ply, history, kings };

  if (hit?.lose) return { ...next, result: { winner: p, reason: "king", byDiscs: false } };
  // 体力 0 以下になった時点で即敗北
  if (hp[q] <= 0) return { ...next, result: { winner: p, reason: "ko", byDiscs: false } };
  if (rules.maxPlies > 0 && ply >= rules.maxPlies) return { ...next, result: judge(board, hp, "limit") };
  // 相手が打てれば相手番。打てなければ相手はパスし、自分が続けて打つ。両者打てなければ終局
  return settleTurn(next, q);
}

// ---- 隠し王 ----

const noKing = (): KingState => ({ cell: null, auto: false, revealed: false });

/** p がこれまでに打った手数（パスは数えない） */
export function movesBy(state: Pick<GameState, "history">, p: Player): number {
  return state.history.filter((e) => e.type === "move" && e.player === p).length;
}

/** p 自身から見た自分の王 */
export interface KingInfo {
  /** off: 隠し王なし / unset: まだ決めていない / hidden: 隠れている / revealed: 返されて公開済み */
  status: "off" | "unset" | "hidden" | "revealed";
  /** 王の駒のマス（hidden のときだけ） */
  cell: Cell | null;
  /** 期限の手で自動的に決まった */
  auto: boolean;
  /** 次の自分の手が何手目か（自分の手だけを数える。1 始まり） */
  nextMove: number;
  /** 次の自分の手で王を指定できる */
  canDesignate: boolean;
  /** 次の自分の手が期限（指定しなければ置いた駒が自動で王になる） */
  forcedNow: boolean;
}

/**
 * p の王の情報。p 本人だけが見てよい（UI は手番の人・CPU 対戦の人間、CPU は自分の分だけを呼ぶ）
 */
export function kingInfo(state: GameState, p: Player): KingInfo {
  const { king } = state.rules;
  const ks = state.kings[p];
  const nextMove = movesBy(state, p) + 1;
  if (!king.on) return { status: "off", cell: null, auto: false, nextMove, canDesignate: false, forcedNow: false };
  const status = ks.revealed ? "revealed" : ks.cell ? "hidden" : "unset";
  const canDesignate = status === "unset" && nextMove <= king.deadline && !state.result;
  return {
    status,
    cell: status === "hidden" ? ks.cell : null,
    auto: ks.auto,
    nextMove,
    canDesignate,
    forcedNow: canDesignate && nextMove === king.deadline,
  };
}

/** owner の王が返されて公開されたか（棋譜から分かる公開情報） */
export function kingRevealed(state: Pick<GameState, "history">, owner: Player): boolean {
  return state.history.some((e) => e.type === "move" && e.player !== owner && e.king !== undefined);
}

/**
 * owner の王の候補（棋譜だけから求める公開情報）。
 * owner が指定期限内に置き、まだ一度も返されて（取られて）いない駒。期限内の手を打ち終えていなくても、それまでに置いた駒を候補にする。
 * 王が公開された後は空
 */
export function kingCandidates(state: Pick<GameState, "rules" | "history">, owner: Player): Cell[] {
  const { king } = state.rules;
  if (!king.on) return [];
  const cands = new Map<number, Cell>();
  let n = 0;
  for (const e of state.history) {
    if (e.type !== "move") continue;
    if (e.player === owner) {
      n++;
      if (n <= king.deadline) cands.set(e.r * SIZE + e.c, [e.r, e.c]);
    } else {
      if (e.king) return [];
      for (const t of e.targets) cands.delete(t.r * SIZE + t.c);
    }
  }
  return [...cands.values()];
}

/** viewer から見える局面。相手の王の真の場所は含まない（CPU はこれだけを見て打つ） */
export interface PlayerView extends Omit<GameState, "kings"> {
  viewer: Player;
  /** 自分の王 */
  myKing: KingInfo;
  /** 相手の王について分かること（公開されたか・候補） */
  oppKing: { revealed: boolean; candidates: Cell[] };
}

export function viewFor(state: GameState, viewer: Player): PlayerView {
  const { kings: _secret, ...pub } = state;
  const opp = other(viewer);
  return {
    ...pub,
    viewer,
    myKing: kingInfo(state, viewer),
    oppKing: { revealed: kingRevealed(state, opp), candidates: kingCandidates(state, opp) },
  };
}
