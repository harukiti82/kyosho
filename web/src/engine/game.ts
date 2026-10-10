// 対局の進行（合法手・手番・パス・体力・終局判定）。sim/*.py の play() / outcome() に対応する。
// 状態はイミュータブルに扱い、playMove は新しい GameState を返す。
// 隠し王の真の状態（GameState.kings）は、UI・CPU からは viewFor() / kingInfo() を通してしか見ない。

import {
  anchorsOf,
  applyLines,
  baseDamageOf,
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
  kindsInRules,
  other,
  type Hand,
  type PieceKind,
  type Player,
  type RuleSet,
} from "./rules";
import {
  gaugeMax,
  KINGMOVE_RANGE,
  moverGain,
  OFFER_SIZE,
  REFILL_MAX_VALUE,
  SCOUT_PENALTY_RATE,
  shieldDamage,
  SKILL_HEAL,
  SKILL_ORDER,
  strongDamage,
  victimGain,
  type SkillBlock,
  type SkillId,
  type SkillNote,
  type SkillSide,
  type SkillsState,
  type SkillUse,
} from "./skills";

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
  /** ダメージ（端の駒の上乗せを含む） */
  damage: number;
  heal: number;
  /** 端の駒の上乗せに使った自分の駒（返した列ごとの反対端）。端の駒の力が「なし」か、何も返していなければキー自体がない */
  anchors?: Target[];
  /** 相手の隠し王を返した（取った）。王はこの手で公開される。返していなければキー自体がない */
  king?: KingHit;
  /** 制限時間を過ぎて自動で打った手（playTimeout）。手番の人が打った手ならキー自体がない */
  timeout?: true;
  /** この手と一緒に使ったスキル（公開情報）。使っていなければキー自体がない */
  skill?: SkillNote;
  /** スキル（強打・相手の鉄壁）で変わる前のダメージ。変わっていなければキー自体がない */
  plain?: number;
  /** 相手の鉄壁でダメージが半分になった手。なっていなければキー自体がない */
  shielded?: true;
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
  /** 相手が偵察で場所を知っている（王の移し替えで移すまで）。知られていなければキー自体がない */
  seen?: true;
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
  /** スキル（RuleSet.skills が true のときだけ。カード・ゲージ・使ったスキル） */
  skills?: SkillsState;
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

/**
 * 手番の人がこの手で使うルール。全方向のスキルを使った手番だけ、置く駒が 8 方向に挟める（それ以外は rules そのもの）
 */
export function moveRules(state: Pick<GameState, "rules"> & { skills?: SkillsState }): RuleSet {
  return state.skills?.armed?.id === "omni" ? { ...state.rules, dirs: "all" } : state.rules;
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
  if (r.skills) g.skills = newSkills();
  // 持ち駒が 0 個などで先手が打てない設定もありうる
  return settleTurn(g, 0);
}

/** 盤の途中の局面の指定（チュートリアルの局面など） */
export interface Position {
  /** 盤の駒（ここにないマスは空き。中央の初期配置も置かない） */
  stones: readonly { at: Cell; owner: Player; kind: PieceKind }[];
  /** 持ち駒 [先手, 後手]。省略すると両者ともルールの初期の持ち駒 */
  hands?: [Hand, Hand];
  /** 体力 [先手, 後手]。省略するとルールの初期体力 */
  hp?: [number, number];
  /** 手番。省略すると先手 */
  turn?: Player;
  /** 隠し王の駒のマス [先手, 後手]（隠れた状態から始める）。null・省略は未指定 */
  kings?: [Cell | null, Cell | null];
}

/**
 * 指定した局面から対局を始める（手数 0・棋譜なし）。手番の人が打てなければ createGame と同じくパス・終局にする。
 * マスの重複・盤の外・王のマスに持ち主の駒がない指定は例外
 */
export function gameFrom(rules: RuleSet, pos: Position): GameState {
  const r = cloneRules(rules);
  const board: Board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const { at: [y, x], owner, kind } of pos.stones) {
    if (!(y >= 0 && y < SIZE && x >= 0 && x < SIZE)) throw new Error(`盤の外です: (${y}, ${x})`);
    if (board[y][x]) throw new Error(`同じマスに 2 つ置いています: (${y}, ${x})`);
    board[y][x] = { owner, kind };
  }
  const kings: [KingState, KingState] = [noKing(), noKing()];
  for (const p of [0, 1] as const) {
    const cell = pos.kings?.[p] ?? null;
    if (!cell) continue;
    if (!r.king.on) throw new Error("隠し王なしのルールで王を指定しています");
    if (board[cell[0]][cell[1]]?.owner !== p) throw new Error(`王のマス (${cell[0]}, ${cell[1]}) に持ち主の駒がありません`);
    kings[p] = { cell: [cell[0], cell[1]], auto: false, revealed: false };
  }
  const hands = pos.hands ?? [r.hand, r.hand];
  const g: GameState = {
    rules: r,
    board,
    hands: [{ ...hands[0] }, { ...hands[1] }],
    hp: pos.hp ? [pos.hp[0], pos.hp[1]] : [r.hp[0], r.hp[1]],
    turn: pos.turn ?? 0,
    ply: 0,
    history: [],
    result: null,
    kings,
  };
  if (r.skills) g.skills = newSkills();
  return settleTurn(g, g.turn);
}

/** 手番のプレイヤーが (r, c) に kind を置けるか */
export function isLegal(state: GameState, r: number, c: number, kind: PieceKind): boolean {
  if (state.result) return false;
  return legalLines(moveRules(state), state.board, state.hands[state.turn], state.turn, r, c, kind) !== null;
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
  const lines = state.result ? null : legalLines(moveRules(state), state.board, state.hands[state.turn], state.turn, r, c, kind);
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
  /** ダメージ（端の駒の上乗せ・スキルを含む） */
  damage: number;
  /** スキル（強打・相手の鉄壁）で変わる前のダメージ。変わらなければキー自体がない */
  plain?: number;
  /** ダメージを変えたスキル（強打で ×1.5・相手の鉄壁で半分）。なければキー自体がない */
  mods?: ("strong" | "shield")[];
  /** 返した（取った）駒の分のダメージ（上乗せを除く） */
  base: number;
  /** 端の駒の上乗せに使う自分の駒（列ごとの反対端）。端の駒の力が「なし」なら空 */
  anchors: Target[];
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
  const lines = legalLines(moveRules(state), state.board, state.hands[p], p, r, c, kind);
  if (!lines) return null;
  const targets = targetsOf(lines);
  const raw = damageOf(state.board, lines, rules);
  const { damage, mods } = skillDamage(state, raw);
  const base = baseDamageOf(state.board, lines, rules);
  const anchors = anchorTargets(state.board, lines, rules);
  const heal = healOf(lines, rules.values[kind], rules);
  const board = applyLines(state.board, p, r, c, kind, lines, rules);
  const skill = mods.length > 0 ? { plain: raw, mods } : {};
  const ends = damage >= state.hp[q] || (rules.maxPlies > 0 && state.ply + 1 >= rules.maxPlies);
  if (ends) return { targets, damage, ...skill, base, anchors, heal, exposed: [], exposedDamage: 0 };
  // 相手の持ち駒は自分の着手で変わらない（取った駒は自分の持ち駒に入る）
  const reply = bestReply(rules, board, state.hands[q], q).damage;
  return {
    targets,
    damage,
    ...skill,
    base,
    anchors,
    heal,
    exposed: attackable(rules, board, state.hands[q], q),
    // 鉄壁を使った手番なら、相手の次の手のダメージは半分
    exposedDamage: state.skills?.armed?.id === "wall" ? shieldDamage(reply) : reply,
  };
}

/** 手番の人のこの手のダメージにスキル（自分の強打・相手の鉄壁）を掛ける。スキルなしなら damage そのもの */
function skillDamage(state: Pick<GameState, "turn"> & { skills?: SkillsState }, damage: number): { damage: number; mods: ("strong" | "shield")[] } {
  const sk = state.skills;
  const mods: ("strong" | "shield")[] = [];
  if (!sk) return { damage, mods };
  let d = damage;
  if (sk.armed?.id === "strong") {
    d = strongDamage(d);
    mods.push("strong");
  }
  if (sk.shielded[state.turn]) {
    d = shieldDamage(d);
    mods.push("shield");
  }
  return { damage: d, mods };
}

/** 端の駒の上乗せに使う自分の駒（マスと駒種） */
function anchorTargets(board: Board, lines: readonly Line[], rules: RuleSet): Target[] {
  return anchorsOf(lines, rules).map(([y, x]) => ({ r: y, c: x, kind: board[y][x]!.kind }));
}

/** victim の駒のうち、相手が次の 1 手で返せる（取れる）もの */
export function threatenedPieces(state: GameState, victim: Player): Cell[] {
  if (state.result) return [];
  const attacker = other(victim);
  return attackable(state.rules, state.board, state.hands[attacker], attacker);
}

/**
 * 手番のプレイヤーが (r, c) に kind を置く。opts.king なら置いた駒を自分の王にする（隠し王）。
 * opts.timeout は制限時間切れの自動の手として棋譜に印を付ける（playTimeout が使う）。不正な手は例外
 */
export function playMove(
  state: GameState,
  r: number,
  c: number,
  kind: PieceKind,
  opts: { king?: boolean; timeout?: boolean } = {},
): GameState {
  if (state.result) throw new Error("対局は終了しています");
  if (state.skills && !state.skills.ready) throw new Error("スキルのカードを選び終えていません");
  const { rules } = state;
  const p = state.turn;
  const q = other(p);
  if (state.hands[p][kind] <= 0) throw new Error(`持ち駒に ${kind} がありません`);
  if (state.board[r][c] !== null) throw new Error(`(${r}, ${c}) は空いていません`);
  const lines = legalLines(moveRules(state), state.board, state.hands[p], p, r, c, kind);
  if (!lines) throw new Error(`(${r}, ${c}) に ${kind} を置いても返せる駒がありません`);
  const mine = kingInfo(state, p);
  if (opts.king && !mine.canDesignate) throw new Error("王はもう指定できません");

  const targets: Target[] = targetsOf(lines).map(([y, x]) => ({ r: y, c: x, kind: state.board[y][x]!.kind }));
  const raw = damageOf(state.board, lines, rules);
  const { damage, mods } = skillDamage(state, raw);
  const armed = state.skills?.armed ?? null;
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
    // 偵察した手で返したら罰が SCOUT_PENALTY_RATE 倍
    const amount = rules.king.amount * (armed?.id === "scout" ? SCOUT_PENALTY_RATE : 1);
    hit = { r: qk.cell[0], c: qk.cell[1], kind: state.board[qk.cell[0]][qk.cell[1]]!.kind, penalty: lose ? 0 : amount, lose };
    kings[q] = { ...qk, revealed: true };
  }

  const hp: [number, number] = [...state.hp];
  hp[q] -= damage + (hit?.penalty ?? 0);
  hp[p] += heal;
  const ply = state.ply + 1;
  const move: MoveEvent = { type: "move", ply, player: p, r, c, kind, targets, damage, heal };
  const anchors = anchorTargets(state.board, lines, rules);
  if (anchors.length > 0) move.anchors = anchors;
  if (hit) move.king = hit;
  if (opts.timeout) move.timeout = true;
  if (armed) move.skill = armed;
  if (mods.length > 0) move.plain = raw;
  if (mods.includes("shield")) move.shielded = true;
  const history: GameEvent[] = [...state.history, move];
  const next: GameState = { ...state, board, hands, hp, ply, history, kings };
  if (state.skills) next.skills = skillsAfterMove(state.skills, move, state.hp[q] - hp[q]);

  if (hit?.lose) return { ...next, result: { winner: p, reason: "king", byDiscs: false } };
  // 体力 0 以下になった時点で即敗北
  if (hp[q] <= 0) return { ...next, result: { winner: p, reason: "ko", byDiscs: false } };
  if (rules.maxPlies > 0 && ply >= rules.maxPlies) return { ...next, result: judge(board, hp, "limit") };
  // 相手が打てれば相手番。打てなければ相手はパスし、自分が続けて打つ。両者打てなければ終局
  return settleTurn(next, q);
}

// ---- 制限時間切れ ----

/**
 * 手番のプレイヤーが置ける手（マスと駒種の組）から、rng で一様に 1 つ選ぶ。打てる手がない（終局）なら null。
 * 王は指定しない（期限の手なら playMove がルールどおり置いた駒を自動で王にする）。
 * 手番の人の持ち駒と盤だけを見るので、PlayerView（相手の王の場所を含まない）にも使える
 */
export function randomMove(
  state: Pick<GameState, "rules" | "board" | "hands" | "turn" | "result" | "skills">,
  rng: () => number,
): { r: number; c: number; kind: PieceKind } | null {
  if (state.result) return null;
  const p = state.turn;
  const rules = moveRules(state);
  const moves: { r: number; c: number; kind: PieceKind }[] = [];
  for (const [r, c] of emptyCells(state.board)) {
    for (const kind of availableKinds(state.hands[p])) {
      if (legalLines(rules, state.board, state.hands[p], p, r, c, kind)) moves.push({ r, c, kind });
    }
  }
  if (moves.length === 0) return null;
  return moves[Math.min(moves.length - 1, Math.floor(rng() * moves.length))];
}

/** 制限時間切れ: 手番のプレイヤーの手を randomMove で選んで打つ（棋譜の手に timeout の印）。終局後は例外 */
export function playTimeout(state: GameState, rng: () => number): GameState {
  const m = randomMove(state, rng);
  if (!m) throw new Error("対局は終了しています");
  return playMove(state, m.r, m.c, m.kind, { timeout: true });
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
  /** 相手が偵察で王の場所を知っている */
  seen: boolean;
}

/**
 * p の王の情報。p 本人だけが見てよい（UI は手番の人・CPU 対戦の人間、CPU は自分の分だけを呼ぶ）
 */
export function kingInfo(state: GameState, p: Player): KingInfo {
  const { king } = state.rules;
  const ks = state.kings[p];
  const nextMove = movesBy(state, p) + 1;
  if (!king.on) return { status: "off", cell: null, auto: false, nextMove, canDesignate: false, forcedNow: false, seen: false };
  const status = ks.revealed ? "revealed" : ks.cell ? "hidden" : "unset";
  const canDesignate = status === "unset" && nextMove <= king.deadline && !state.result;
  return {
    status,
    cell: status === "hidden" ? ks.cell : null,
    auto: ks.auto,
    nextMove,
    canDesignate,
    forcedNow: canDesignate && nextMove === king.deadline,
    seen: status === "hidden" && ks.seen === true,
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
export function kingCandidates(
  state: Pick<GameState, "rules" | "history"> & Partial<Pick<GameState, "turn" | "skills">>,
  owner: Player,
): Cell[] {
  const { king } = state.rules;
  if (!king.on) return [];
  let cands = new Map<number, Cell>();
  // 王の移し替えの後は、使った時点の自分の駒が候補（以後に置いた駒は王になれない）
  let moved = false;
  const moveKing = (note: SkillNote | undefined | null) => {
    if (note?.id !== "kingmove" || !note.cands) return;
    cands = new Map(note.cands.map(([y, x]) => [y * SIZE + x, [y, x] as Cell]));
    moved = true;
  };
  let n = 0;
  for (const e of state.history) {
    if (e.type !== "move") continue;
    if (e.player === owner) {
      n++;
      moveKing(e.skill);
      if (!moved && n <= king.deadline) cands.set(e.r * SIZE + e.c, [e.r, e.c]);
    } else {
      if (e.king) return [];
      for (const t of e.targets) cands.delete(t.r * SIZE + t.c);
    }
  }
  // 手番の途中（スキルを使って、まだ置いていない）
  if (state.turn === owner) moveKing(state.skills?.armed);
  return [...cands.values()];
}

/** viewer から見える局面。相手の王の真の場所は含まない（CPU はこれだけを見て打つ） */
export interface PlayerView extends Omit<GameState, "kings"> {
  viewer: Player;
  /** 自分の王 */
  myKing: KingInfo;
  /**
   * 相手の王について分かること（公開されたか・候補）。偵察で場所を知っているときは scouted が true で、候補はその 1 マス
   */
  oppKing: { revealed: boolean; candidates: Cell[]; scouted: boolean };
}

export function viewFor(state: GameState, viewer: Player): PlayerView {
  const { kings: _secret, skills, ...pub } = state;
  const opp = other(viewer);
  const ok = state.kings[opp];
  const revealed = kingRevealed(state, opp);
  const scouted = !revealed && ok.seen === true && ok.cell !== null;
  const view: PlayerView = {
    ...pub,
    viewer,
    myKing: kingInfo(state, viewer),
    oppKing: { revealed, candidates: scouted ? [[ok.cell![0], ok.cell![1]]] : kingCandidates(state, opp), scouted },
  };
  if (skills) view.skills = skillsFor(skills, viewer);
  return view;
}

// ---- スキル ----

const emptySide = (): SkillSide => ({ offer: [], card: null, gauge: 0 });
const newSkills = (): SkillsState => ({ sides: [emptySide(), emptySide()], ready: false, armed: null, shielded: [false, false] });

/** viewer に見せるスキルの状態。相手の配られたカードは見せず、相手の選んだカードは両者が選び終えるまで見せない */
function skillsFor(sk: SkillsState, viewer: Player): SkillsState {
  const sides = sk.sides.map((s, i) =>
    i === viewer ? { ...s, offer: [...s.offer] } : { offer: [], card: sk.ready ? s.card : null, gauge: s.gauge },
  ) as [SkillSide, SkillSide];
  return { ...sk, sides, shielded: [sk.shielded[0], sk.shielded[1]] };
}

/** 配れるカード（隠し王なしのルールでは偵察・王の移し替えを除く） */
export const skillPool = (rules: RuleSet): SkillId[] =>
  SKILL_ORDER.filter((id) => rules.king.on || (id !== "scout" && id !== "kingmove"));

/** 両者に OFFER_SIZE 枚ずつ配る（各自のカードは重ならない。両者の間では重なってよい）。スキルなし・配り済みなら例外 */
export function dealSkills(state: GameState, rng: () => number): GameState {
  const sk = state.skills;
  if (!sk) throw new Error("スキルなしのルールです");
  if (sk.sides.some((s) => s.offer.length > 0 || s.card)) throw new Error("もう配りました");
  const deal = (): SkillId[] => {
    const pool = skillPool(state.rules);
    for (let i = 0; i < Math.min(OFFER_SIZE, pool.length); i++) {
      const j = i + Math.min(pool.length - i - 1, Math.floor(rng() * (pool.length - i)));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, OFFER_SIZE);
  };
  const sides: [SkillSide, SkillSide] = [{ ...sk.sides[0], offer: deal() }, { ...sk.sides[1], offer: deal() }];
  return { ...state, skills: { ...sk, sides } };
}

/** p が配られたカードから 1 枚を選ぶ。両者が選んだら打てる。配られていないカード・選び直しは例外 */
export function pickSkill(state: GameState, p: Player, card: SkillId): GameState {
  const sk = state.skills;
  if (!sk) throw new Error("スキルなしのルールです");
  if (sk.ready || sk.sides[p].card) throw new Error("もう選びました");
  if (!sk.sides[p].offer.includes(card)) throw new Error(`${card} は配られていません`);
  const sides: [SkillSide, SkillSide] = [sk.sides[0], sk.sides[1]];
  sides[p] = { ...sides[p], card };
  return { ...state, skills: { ...sk, sides, ready: sides.every((s) => s.card !== null) } };
}

/** カードを直接決めて始める（バランス確認・テスト用。null はその人だけスキルなし） */
export function setSkills(state: GameState, cards: [SkillId | null, SkillId | null]): GameState {
  if (!state.skills) throw new Error("スキルなしのルールです");
  const sides = cards.map((card) => ({ offer: card ? [card] : [], card, gauge: 0 })) as [SkillSide, SkillSide];
  return { ...state, skills: { ...state.skills, sides, ready: true } };
}

/** 補充で戻せる駒（使い切った駒のうち数字が REFILL_MAX_VALUE 以下。表示の順） */
export function refillKinds(view: Pick<GameState, "rules" | "hands" | "turn">): PieceKind[] {
  const hand = view.hands[view.turn];
  return kindsInRules(view.rules).filter((k) => hand[k] === 0 && view.rules.values[k] <= REFILL_MAX_VALUE);
}

/** 王の移し替えで移せるマス（今の王から KINGMOVE_RANGE マス以内の自分の駒。今の王のマスは除く） */
export function kingMoveCells(view: Pick<PlayerView, "board" | "turn" | "myKing">): Cell[] {
  const k = view.myKing.status === "hidden" ? view.myKing.cell : null;
  if (!k) return [];
  const out: Cell[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (r === k[0] && c === k[1]) continue;
      if (view.board[r][c]?.owner !== view.turn) continue;
      if (Math.max(Math.abs(r - k[0]), Math.abs(c - k[1])) <= KINGMOVE_RANGE) out.push([r, c]);
    }
  }
  return out;
}

/**
 * 偵察を使えるか（公開情報だけで決める）: 相手の王が隠れていて、相手が期限の手まで打ち終えている（王が必ず決まっている）。
 * 相手が期限より前に王を決めたかは隠し情報なので、期限まで待つ
 */
function scoutable(view: Pick<GameState, "rules" | "history" | "turn">): boolean {
  const opp = other(view.turn);
  return view.rules.king.on && movesBy(view, opp) >= view.rules.king.deadline && !kingRevealed(view, opp);
}

/** 手番の人がいまスキルを使えないなら理由、使えるなら null（PlayerView でも GameState を viewFor したものでも同じ） */
export function skillBlock(view: PlayerView): SkillBlock | null {
  const sk = view.skills;
  if (!sk) return "off";
  if (!sk.ready) return "picking";
  const p = view.turn;
  const card = sk.sides[p].card;
  if (!card) return "off";
  if (view.result) return "over";
  if (sk.armed) return "used";
  if (sk.sides[p].gauge < gaugeMax(card)) return "charging";
  switch (card) {
    case "firstaid":
    case "bigheal":
      return view.hp[p] >= view.rules.hp[p] ? "fullHp" : null;
    case "refill":
      return refillKinds(view).length === 0 ? "noRefill" : null;
    case "scout":
      return scoutable(view) ? null : "noTarget";
    case "kingmove":
      if (view.myKing.status !== "hidden") return "noKing";
      return kingMoveCells(view).length === 0 ? "noRoom" : null;
    default:
      return null;
  }
}

/** 手番の人のゲージが満タンか（使えるかは skillBlock） */
export function gaugeFull(sk: SkillsState, p: Player): boolean {
  const card = sk.sides[p].card;
  return card !== null && sk.sides[p].gauge >= gaugeMax(card);
}

/**
 * 手番の人がスキルを使う（置く前。効果のうち回復・補充・鉄壁・偵察・王の移し替えはすぐ、強打・全方向・偵察の罰はこの手番の手で効く）。
 * ゲージは 0 に戻る。使えない・指定が違うなら例外
 */
export function useSkill(state: GameState, use: SkillUse): GameState {
  const p = state.turn;
  const q = other(p);
  const view = viewFor(state, p);
  const block = skillBlock(view);
  if (block) throw new Error(`スキルを使えません: ${block}`);
  const sk = state.skills!;
  const card = sk.sides[p].card!;
  if (use.id !== card) throw new Error(`${use.id} は自分のカードではありません`);
  const sides: [SkillSide, SkillSide] = [sk.sides[0], sk.sides[1]];
  sides[p] = { ...sides[p], gauge: 0 };
  const note: SkillNote = { id: card };
  const shielded: [boolean, boolean] = [sk.shielded[0], sk.shielded[1]];
  let next: GameState = { ...state };
  switch (card) {
    case "firstaid":
    case "bigheal": {
      const hp: [number, number] = [state.hp[0], state.hp[1]];
      hp[p] = Math.min(state.rules.hp[p], hp[p] + SKILL_HEAL[card]);
      note.heal = hp[p] - state.hp[p];
      next.hp = hp;
      break;
    }
    case "refill": {
      if (!use.kind || !refillKinds(state).includes(use.kind)) throw new Error("補充できない駒です");
      const hands: [Hand, Hand] = [{ ...state.hands[0] }, { ...state.hands[1] }];
      hands[p][use.kind]++;
      note.kind = use.kind;
      next.hands = hands;
      break;
    }
    case "wall":
      shielded[q] = true;
      break;
    case "scout": {
      const kings: [KingState, KingState] = [state.kings[0], state.kings[1]];
      kings[q] = { ...kings[q], seen: true };
      next.kings = kings;
      break;
    }
    case "kingmove": {
      const to = use.to;
      if (!to || !kingMoveCells(view).some(([y, x]) => y === to[0] && x === to[1])) throw new Error("そのマスには移せません");
      const kings: [KingState, KingState] = [state.kings[0], state.kings[1]];
      kings[p] = { cell: [to[0], to[1]], auto: false, revealed: false };
      note.cands = [];
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (state.board[r][c]?.owner === p) note.cands.push([r, c]);
      next.kings = kings;
      break;
    }
    default:
      // 強打・全方向は置く手で効く
      break;
  }
  next = { ...next, skills: { ...sk, sides, armed: note, shielded } };
  return next;
}

/** 打った手の後のスキルの状態（ゲージを足し、この手番で使ったスキル・この手に掛かった鉄壁を消す） */
function skillsAfterMove(sk: SkillsState, move: MoveEvent, lost: number): SkillsState {
  const p = move.player;
  const q = other(p);
  const sides: [SkillSide, SkillSide] = [sk.sides[0], sk.sides[1]];
  const add = (who: Player, n: number) => {
    const card = sides[who].card;
    if (!card || n <= 0) return;
    sides[who] = { ...sides[who], gauge: Math.min(gaugeMax(card), sides[who].gauge + n) };
  };
  const card = sides[p].card;
  if (card) add(p, moverGain(card, [move.r, move.c], move.targets));
  add(q, victimGain(lost));
  const shielded: [boolean, boolean] = [sk.shielded[0], sk.shielded[1]];
  shielded[p] = false;
  return { ...sk, sides, armed: null, shielded };
}
