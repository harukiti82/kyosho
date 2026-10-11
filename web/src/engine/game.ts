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
  secondDamage,
  shieldDamage,
  SKILL_HEAL,
  SKILL_ORDER,
  strongDamage,
  VICE_DEADLINE,
  VICE_PENALTY,
  victimGain,
  type EffectBlock,
  type SkillBlock,
  type SkillId,
  type SkillNote,
  type SkillSide,
  type SkillsState,
  type SkillUse,
  type WheelEffect,
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
  /** 連続行動の 2 手目（ダメージ半分）。そうでなければキー自体がない */
  second?: true;
  /** 相手の副将を返した（公開情報）。返していなければキー自体がない */
  vice?: ViceHit;
}

/** 相手の副将を返したときの記録（公開情報） */
export interface ViceHit {
  r: number;
  c: number;
  kind: PieceKind;
  /** 減らした体力（VICE_PENALTY） */
  penalty: number;
  /** 偵察で特定していた副将。そうでなければキー自体がない */
  scouted?: true;
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
  /**
   * 王を指定した手を相手の巻き戻しで戻された（指定は戻さない）。次に置く駒がそのまま王になる。
   * cell は null。そうでなければキー自体がない
   */
  kept?: true;
  /** 副将（スキルありで隠し王ありのルールだけ。王を決めた手から始まる）。始まる前・副将なしのルールではキー自体がない */
  vice?: ViceState;
}

/** 副将の真の状態（隠し情報。kings の中だけに持つ） */
export interface ViceState {
  /** 副将の駒のマス。まだ決めていなければ null */
  cell: Cell | null;
  /** 今の副将を決める期間が始まった時点の自分の手数（王を決めた手・副将を返された時点）。since + VICE_DEADLINE 手目が期限 */
  since: number;
  /** 期限の手で自動的に決まった。そうでなければキー自体がない */
  auto?: true;
  /** 相手が偵察で今の副将を知っている（返されるまで）。知られていなければキー自体がない */
  seen?: true;
  /** 副将を出した手を相手の巻き戻しで戻された（指定は戻さない）。次に置く駒がそのまま副将になる。そうでなければキー自体がない */
  kept?: true;
  /** 今の副将を決める期間が副将を返されて始まった（始まりの手数が相手にも分かる）。最初の期間ならキー自体がない */
  hit?: true;
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
  return armedEffect(state.skills) === "omni" ? { ...state.rules, dirs: "all" } : state.rules;
}

/**
 * 手番の人がこの手番で使って効いているスキルの効果（運命の輪は引いた効果）。
 * 使っていない・不発・運命の輪の指定待ちなら null
 */
export function armedEffect(sk: SkillsState | undefined): SkillId | null {
  const a = sk?.armed;
  if (!a || a.fizzle || a.aim) return null;
  return a.effect ?? a.id;
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
  /** 副将の駒のマス [先手, 後手]（副将のあるルールで、王を指定した人だけ。隠れた状態から始める）。null・省略は未指定 */
  vices?: [Cell | null, Cell | null];
  /**
   * スキルのルールの各自のカード [先手, 後手]。offer は配られた 3 枚（card がなければ選ぶ前）、card は選んだカード、gauge は GAUGE_UNIT 単位
   * （満タンを超えない）。省略すると createGame と同じく配る前から始める
   */
  skills?: [PositionSkill, PositionSkill];
}

/** 指定した局面のスキルの 1 人分（チュートリアル） */
export interface PositionSkill {
  offer?: SkillId[];
  card?: SkillId | null;
  gauge?: number;
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
    // 副将のあるルールなら、王を決めた後と同じく副将を決める期間から始める
    if (vicesOn(r)) kings[p].vice = { cell: null, since: 0 };
  }
  for (const p of [0, 1] as const) {
    const cell = pos.vices?.[p] ?? null;
    if (!cell) continue;
    if (!kings[p].vice) throw new Error("副将は、副将のあるルールで王を指定した人だけに置けます");
    if (board[cell[0]][cell[1]]?.owner !== p) throw new Error(`副将のマス (${cell[0]}, ${cell[1]}) に持ち主の駒がありません`);
    const k = kings[p].cell!;
    if (k[0] === cell[0] && k[1] === cell[1]) throw new Error("王と副将は同じ駒にできません");
    kings[p].vice = { cell: [cell[0], cell[1]], since: 0 };
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
  if (r.skills) g.skills = pos.skills ? skillsFrom(pos.skills) : newSkills();
  else if (pos.skills) throw new Error("スキルなしのルールでカードを指定しています");
  return settleTurn(g, g.turn);
}

/** 指定したカード・ゲージのスキルの状態。両者が選び終えていれば（カードを選んだか、配られていなければ）打てる */
function skillsFrom(spec: [PositionSkill, PositionSkill]): SkillsState {
  const sides = spec.map((s) => {
    const card = s.card ?? null;
    const offer = [...(s.offer ?? (card ? [card] : []))];
    if (card && !offer.includes(card)) throw new Error(`${card} は配られていません`);
    return { offer, card, gauge: card ? Math.max(0, Math.min(gaugeMax(card), s.gauge ?? 0)) : 0 };
  }) as [SkillSide, SkillSide];
  return { ...newSkills(), sides, ready: sides.every((s) => s.card !== null || s.offer.length === 0) };
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
  /** ダメージを変えたスキル（強打で ×1.5・相手の鉄壁で半分・連続行動の 2 手目で半分）。なければキー自体がない */
  mods?: DamageMod[];
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
    exposedDamage: armedEffect(state.skills) === "wall" ? shieldDamage(reply) : reply,
  };
}

/** ダメージを変えるスキル。strong: 自分の強打 ×1.5 / shield: 相手の鉄壁で半分 / second: 連続行動の 2 手目で半分 */
export type DamageMod = "strong" | "shield" | "second";

/** 手番の人のこの手のダメージにスキル（自分の強打・相手の鉄壁・連続行動の 2 手目）を掛ける。スキルなしなら damage そのもの */
function skillDamage(state: Pick<GameState, "turn"> & { skills?: SkillsState }, damage: number): { damage: number; mods: DamageMod[] } {
  const sk = state.skills;
  const mods: DamageMod[] = [];
  if (!sk) return { damage, mods };
  let d = damage;
  if (armedEffect(sk) === "strong") {
    d = strongDamage(d);
    mods.push("strong");
  }
  if (sk.shielded[state.turn]) {
    d = shieldDamage(d);
    mods.push("shield");
  }
  if (sk.second) {
    d = secondDamage(d);
    mods.push("second");
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
 * opts.vice なら置いた駒を自分の副将にする（副将を決める期間だけ。王と同じ手では出せない）。
 * opts.timeout は制限時間切れの自動の手として棋譜に印を付ける（playTimeout が使う）。不正な手は例外
 */
export function playMove(
  state: GameState,
  r: number,
  c: number,
  kind: PieceKind,
  opts: { king?: boolean; vice?: boolean; timeout?: boolean } = {},
): GameState {
  if (state.result) throw new Error("対局は終了しています");
  if (state.skills && !state.skills.ready) throw new Error("スキルのカードを選び終えていません");
  if (state.skills?.armed?.aim) throw new Error("運命の輪の指定が済んでいません");
  const { rules } = state;
  const p = state.turn;
  const q = other(p);
  if (state.hands[p][kind] <= 0) throw new Error(`持ち駒に ${kind} がありません`);
  if (state.board[r][c] !== null) throw new Error(`(${r}, ${c}) は空いていません`);
  const lines = legalLines(moveRules(state), state.board, state.hands[p], p, r, c, kind);
  if (!lines) throw new Error(`(${r}, ${c}) に ${kind} を置いても返せる駒がありません`);
  const mine = kingInfo(state, p);
  if (opts.king && !mine.canDesignate) throw new Error("王はもう指定できません");
  if (opts.vice && opts.king) throw new Error("王と副将は同じ手では出せません");
  if (opts.vice && viceInfo(state, p).status !== "unset") throw new Error("副将はいま出せません");

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
  if (mine.canDesignate && (opts.king || mine.forcedNow)) kings[p] = { cell: [r, c], auto: opts.king ? false : mine.kept ? state.kings[p].auto : true, revealed: false };
  // 相手の隠れた王を返した（取った）ら、罰を与えて王を公開する
  let hit: KingHit | undefined;
  const qk = kings[q];
  if (rules.king.on && qk.cell && !qk.revealed && targets.some((t) => t.r === qk.cell![0] && t.c === qk.cell![1])) {
    const lose = rules.king.penalty === "lose";
    hit = { r: qk.cell[0], c: qk.cell[1], kind: state.board[qk.cell[0]][qk.cell[1]]!.kind, penalty: lose ? 0 : rules.king.amount, lose };
    kings[q] = { ...qk, revealed: true };
  }
  // 相手の副将を返したら罰。相手はまた自分の手で VICE_DEADLINE 手以内に次の副将を決める
  let viceHit: ViceHit | undefined;
  const qv = kings[q].vice;
  if (qv?.cell && targets.some((t) => t.r === qv.cell![0] && t.c === qv.cell![1])) {
    const [y, x] = qv.cell;
    viceHit = { r: y, c: x, kind: state.board[y][x]!.kind, penalty: VICE_PENALTY };
    if (qv.seen) viceHit.scouted = true;
    kings[q] = { ...kings[q], vice: { cell: null, since: movesBy(state, q), hit: true } };
  }
  // 自分の副将: 王を決めた手の次の手から決める期間が始まり、置く駒を副将にして出す。
  // 期限の手（巻き戻しで戻された指定なら次の手）まで出さなければ、その手で置いた駒が自動で副将になる
  if (vicesOn(rules)) {
    const pk = kings[p];
    const n = movesBy(state, p) + 1;
    if (!pk.vice && pk.cell) kings[p] = { ...pk, vice: { cell: null, since: n } };
    else if (pk.vice && !pk.vice.cell && (opts.vice || pk.vice.kept || n - pk.vice.since >= VICE_DEADLINE)) {
      const { kept: _kept, ...v } = pk.vice;
      kings[p] = { ...pk, vice: { ...v, cell: [r, c], ...(opts.vice ? {} : { auto: true as const }) } };
    }
  }

  const hp: [number, number] = [...state.hp];
  hp[q] -= damage + (hit?.penalty ?? 0) + (viceHit?.penalty ?? 0);
  hp[p] += heal;
  const ply = state.ply + 1;
  const move: MoveEvent = { type: "move", ply, player: p, r, c, kind, targets, damage, heal };
  const anchors = anchorTargets(state.board, lines, rules);
  if (anchors.length > 0) move.anchors = anchors;
  if (hit) move.king = hit;
  if (viceHit) move.vice = viceHit;
  if (opts.timeout) move.timeout = true;
  if (armed) move.skill = armed;
  if (mods.length > 0) move.plain = raw;
  if (mods.includes("shield")) move.shielded = true;
  if (mods.includes("second")) move.second = true;
  const history: GameEvent[] = [...state.history, move];
  const next: GameState = { ...state, board, hands, hp, ply, history, kings };
  if (state.skills) next.skills = skillsAfterMove(state, move, state.hp[q] - hp[q]);

  if (hit?.lose) return { ...next, result: { winner: p, reason: "king", byDiscs: false } };
  // 体力 0 以下になった時点で即敗北
  if (hp[q] <= 0) return { ...next, result: { winner: p, reason: "ko", byDiscs: false } };
  if (rules.maxPlies > 0 && ply >= rules.maxPlies) return { ...next, result: judge(board, hp, "limit") };
  // 連続行動の 1 手目: 置ける手があれば続けて 2 手目（なければふつうに相手の番）
  if (armedEffect(state.skills) === "fool" && canMove(next, p)) return { ...next, turn: p, skills: { ...next.skills!, second: true } };
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

/**
 * 制限時間切れ: 手番のプレイヤーの手を randomMove で選んで打つ（棋譜の手に timeout の印）。終局後は例外。
 * 運命の輪の指定を待っていれば、戻す駒・移す先も rng で選んでから打つ
 */
export function playTimeout(state: GameState, rng: () => number): GameState {
  if (state.skills?.armed?.aim) state = useSkill(state, randomAim(state, rng));
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
  /** 王を指定した手を相手の巻き戻しで戻された。次に置く駒がそのまま王になる（forcedNow も true） */
  kept: boolean;
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
  if (!king.on) return { status: "off", kept: false, cell: null, auto: false, nextMove, canDesignate: false, forcedNow: false, seen: false };
  const status = ks.revealed ? "revealed" : ks.cell ? "hidden" : "unset";
  const canDesignate = status === "unset" && nextMove <= king.deadline && !state.result;
  const kept = canDesignate && ks.kept === true;
  return {
    status,
    kept,
    cell: status === "hidden" ? ks.cell : null,
    auto: ks.auto,
    nextMove,
    canDesignate,
    forcedNow: canDesignate && (nextMove === king.deadline || kept),
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
  // 王の移し替え（運命の輪で出たものを含む）の印は、使った時点の自分の駒 cands
  const moveKing = (note: SkillNote | undefined | null) => {
    if (!note?.cands) return;
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

// ---- 副将（スキルありで隠し王ありのルールだけ） ----

/** 副将のあるルールか（スキルありで隠し王あり） */
export const vicesOn = (rules: RuleSet): boolean => rules.skills && rules.king.on;

/** p 自身から見た自分の副将 */
export interface ViceInfo {
  /** off: 副将なしのルール / wait: 王を決める前 / unset: 決める期間 / set: 決めてある */
  status: "off" | "wait" | "unset" | "set";
  /** 副将の駒のマス（set のときだけ） */
  cell: Cell | null;
  /** 期限の手で自動的に決まった */
  auto: boolean;
  /** 期限まで、次の自分の手を含めてあと何手（unset のときだけ。ほかは 0） */
  left: number;
  /** 次の自分の手が期限（出さなければ置いた駒が自動で副将になる。巻き戻しで戻された指定のときも） */
  forcedNow: boolean;
  /** 巻き戻しで戻された指定。次に置く駒がそのまま副将になる（forcedNow も true） */
  kept: boolean;
  /** 相手が偵察で今の副将を知っている */
  seen: boolean;
}

/** p の副将の情報。p 本人だけが見てよい（kingInfo と同じ扱い） */
export function viceInfo(state: GameState, p: Player): ViceInfo {
  const off: ViceInfo = { status: "off", cell: null, auto: false, left: 0, forcedNow: false, kept: false, seen: false };
  if (!vicesOn(state.rules)) return off;
  const v = state.kings[p].vice;
  if (!v) return { ...off, status: "wait" };
  if (v.cell) return { ...off, status: "set", cell: v.cell, auto: v.auto === true, seen: v.seen === true };
  const left = Math.max(1, v.since + VICE_DEADLINE - movesBy(state, p));
  const kept = v.kept === true;
  return { ...off, status: "unset", left, forcedNow: !state.result && (left === 1 || kept), kept };
}

/**
 * 相手の副将について分かること。set は相手に今の副将が必ずいると分かるか（偵察を使えるかに要る）。
 * 副将は置く駒で出すので、出した時点で set を見せると置いた駒が副将だと分かってしまう。
 * そこで、決める期間の期限（必ず決まる手）を相手が打ち終えるまでは false にする。期間の始まりは、
 * 最初は王を決めた手（隠し情報）なので王の期限 ＋ VICE_DEADLINE 手、副将を返された後は返された時点（公開）＋ VICE_DEADLINE 手。
 * wait は set になるまでの相手の手数（set なら 0）。偵察で知っているときは scouted が true で cell がそのマス
 */
export interface OppVice {
  set: boolean;
  wait: number;
  scouted: boolean;
  cell: Cell | null;
}

function oppViceOf(state: GameState, owner: Player): OppVice {
  const none: OppVice = { set: false, wait: 0, scouted: false, cell: null };
  if (!vicesOn(state.rules)) return none;
  const v = state.kings[owner].vice;
  const due = (v?.hit ? v.since : state.rules.king.deadline) + VICE_DEADLINE;
  const wait = Math.max(0, due - movesBy(state, owner));
  if (!v?.cell || wait > 0) return { ...none, wait };
  return v.seen ? { set: true, wait: 0, scouted: true, cell: [v.cell[0], v.cell[1]] } : { ...none, set: true };
}

/** viewer から見える局面。相手の王・副将の真の場所は含まない（CPU はこれだけを見て打つ） */
export interface PlayerView extends Omit<GameState, "kings"> {
  viewer: Player;
  /** 自分の王 */
  myKing: KingInfo;
  /**
   * 相手の王について分かること（公開されたか・候補）。偵察で場所を知っているときは scouted が true で、候補はその 1 マス
   */
  oppKing: { revealed: boolean; candidates: Cell[]; scouted: boolean };
  /** 自分の副将 */
  myVice: ViceInfo;
  /** 相手の副将について分かること */
  oppVice: OppVice;
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
    myVice: viceInfo(state, viewer),
    oppVice: oppViceOf(state, opp),
  };
  if (skills) view.skills = skillsFor(skills, viewer);
  return view;
}

// ---- スキル ----

const emptySide = (): SkillSide => ({ offer: [], card: null, gauge: 0 });
const newSkills = (): SkillsState => ({ sides: [emptySide(), emptySide()], ready: false, armed: null, shielded: [false, false] });

/**
 * viewer に見せるスキルの状態。相手の配られたカード・配り直したかは見せず、相手の選んだカードは両者が選び終えるまで見せない。
 * 巻き戻しで戻す局面（undo。王を含む）は消し、戻せるか（undoable）だけを見せる
 */
function skillsFor(sk: SkillsState, viewer: Player): SkillsState {
  const { undo, ...rest } = sk;
  const sides = sk.sides.map((s, i) =>
    i === viewer ? { ...s, offer: [...s.offer] } : { offer: [], card: sk.ready ? s.card : null, gauge: s.gauge },
  ) as [SkillSide, SkillSide];
  const out: SkillsState = { ...rest, sides, shielded: [sk.shielded[0], sk.shielded[1]] };
  if (undo) out.undoable = [undo[0] !== null, undo[1] !== null];
  return out;
}

/** 配れるカード（隠し王なしのルールでは偵察・王の移し替えを除く） */
export const skillPool = (rules: RuleSet): SkillId[] =>
  SKILL_ORDER.filter((id) => rules.king.on || (id !== "scout" && id !== "kingmove"));

/** 運命の輪が引く効果（運命の輪を除く 10 枚。隠し王なしのルールでは偵察・王の移し替えも除く） */
export const wheelPool = (rules: RuleSet): WheelEffect[] => skillPool(rules).filter((id): id is WheelEffect => id !== "wheel");

/** pool から OFFER_SIZE 枚を重ならずに引く（pool の並びで rng を OFFER_SIZE 回使う） */
function drawOffer(pool: SkillId[], rng: () => number): SkillId[] {
  for (let i = 0; i < Math.min(OFFER_SIZE, pool.length); i++) {
    const j = i + Math.min(pool.length - i - 1, Math.floor(rng() * (pool.length - i)));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, OFFER_SIZE);
}

/** 両者に OFFER_SIZE 枚ずつ配る（各自のカードは重ならない。両者の間では重なってよい）。スキルなし・配り済みなら例外 */
export function dealSkills(state: GameState, rng: () => number): GameState {
  const sk = state.skills;
  if (!sk) throw new Error("スキルなしのルールです");
  if (sk.sides.some((s) => s.offer.length > 0 || s.card)) throw new Error("もう配りました");
  const deal = () => drawOffer(skillPool(state.rules), rng);
  const sides: [SkillSide, SkillSide] = [{ ...sk.sides[0], offer: deal() }, { ...sk.sides[1], offer: deal() }];
  return { ...state, skills: { ...sk, sides } };
}

/** p が配り直しを使えないなら理由、使えるなら null（選ぶ前に 1 局 1 回） */
export function rerollBlock(sk: SkillsState | undefined, p: Player): "off" | "picked" | "rerolled" | null {
  if (!sk || sk.sides[p].offer.length === 0) return "off";
  if (sk.ready || sk.sides[p].card) return "picked";
  return sk.sides[p].rerolled ? "rerolled" : null;
}

/**
 * p が配られた 3 枚を配り直す（選ぶ前に 1 局 1 回）。新しい 3 枚は、配られていた 3 枚を除いた残りから引く（同じ札は戻らず、前の 3 枚にも戻れない）。
 * 乱数は引数（画面は crypto、サーバーは crypto）。配り直したことは相手に見せない（viewFor が消す）。使えないなら例外
 */
export function rerollSkills(state: GameState, p: Player, rng: () => number): GameState {
  const block = rerollBlock(state.skills, p);
  if (block) throw new Error(block === "rerolled" ? "配り直しは 1 回までです" : block === "picked" ? "もう選びました" : "配られていません");
  const sk = state.skills!;
  const old = sk.sides[p].offer;
  const sides: [SkillSide, SkillSide] = [sk.sides[0], sk.sides[1]];
  sides[p] = { ...sides[p], offer: drawOffer(skillPool(state.rules).filter((id) => !old.includes(id)), rng), rerolled: true };
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

/** 補充で戻せる駒（初期の数より減っている駒。数字は問わない。表示の順） */
export function refillKinds(view: Pick<GameState, "rules" | "hands" | "turn">): PieceKind[] {
  const hand = view.hands[view.turn];
  return kindsInRules(view.rules).filter((k) => hand[k] < view.rules.hand[k]);
}

/** 王の移し替えで移せるマス（今の王から KINGMOVE_RANGE マス以内の自分の駒。今の王のマスと自分の副将のマスは除く） */
export function kingMoveCells(view: Pick<PlayerView, "board" | "turn" | "myKing"> & { myVice?: ViceInfo }): Cell[] {
  const k = view.myKing.status === "hidden" ? view.myKing.cell : null;
  if (!k) return [];
  const v = view.myVice?.cell;
  const out: Cell[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (r === k[0] && c === k[1]) continue;
      if (v && r === v[0] && c === v[1]) continue;
      if (view.board[r][c]?.owner !== view.turn) continue;
      if (Math.max(Math.abs(r - k[0]), Math.abs(c - k[1])) <= KINGMOVE_RANGE) out.push([r, c]);
    }
  }
  return out;
}

/**
 * 偵察の効果（公開情報だけで決める）。find: 相手の王を特定する（相手の王が隠れていて、まだ知らず、候補が 2 つ以上）/
 * vice: 相手の今の副将を特定する（王が分かっている・返した後）
 */
export function scoutMode(view: Pick<PlayerView, "oppKing">): "find" | "vice" {
  const ok = view.oppKing;
  return !ok.revealed && !ok.scouted && ok.candidates.length >= 2 ? "find" : "vice";
}

/**
 * 偵察を使えない理由。相手が期限の手まで打ち終えるまでは使えない（相手が期限より前に王を決めたかは隠し情報なので、期限まで待つ。
 * 先に王を返していれば使える）。副将を特定する効果は、相手の副将が決まっていない間・今の副将を特定済みの間は使えない
 */
function scoutBlock(view: PlayerView): EffectBlock | null {
  const opp = other(view.turn);
  if (!view.rules.king.on) return "noTarget";
  if (!view.oppKing.revealed && movesBy(view, opp) < view.rules.king.deadline) return "noTarget";
  if (scoutMode(view) === "find") return null;
  if (view.oppVice.scouted) return "viceSeen";
  return view.oppVice.set ? null : "noVice";
}

/** 運命の輪以外の 10 枚の効果を、手番の人がいま使えない理由（使えるなら null）。カードの使う判定と運命の輪の不発の判定で同じ */
export function effectBlock(view: PlayerView, effect: WheelEffect): EffectBlock | null {
  const p = view.turn;
  switch (effect) {
    case "firstaid":
    case "bigheal":
      return view.hp[p] >= view.rules.hp[p] ? "fullHp" : null;
    case "refill":
      return refillKinds(view).length === 0 ? "noRefill" : null;
    case "scout":
      return scoutBlock(view);
    case "kingmove":
      if (view.myKing.status !== "hidden") return "noKing";
      return kingMoveCells(view).length === 0 ? "noRoom" : null;
    case "judge":
      return view.skills?.undoable?.[p] ? null : "noUndo";
    default:
      return null;
  }
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
  if (sk.armed || sk.second) return "used";
  if (sk.sides[p].gauge < gaugeMax(card)) return "charging";
  // 運命の輪は引いた効果が使えなければ不発（使うことはできる）
  return card === "wheel" ? null : effectBlock(view, card);
}

/** 手番の人のゲージが満タンか（使えるかは skillBlock） */
export function gaugeFull(sk: SkillsState, p: Player): boolean {
  const card = sk.sides[p].card;
  return card !== null && sk.sides[p].gauge >= gaugeMax(card);
}

/**
 * 手番の人がスキルを使う（置く前）。ゲージは 0 に戻る。使えない・指定が違うなら例外。
 * 効果のうち回復・補充・鉄壁・偵察・王の移し替え・巻き戻しはすぐ、強打・全方向・連続行動はこの手番の手で効く。
 * 運命の輪は rng で運命の輪以外の 10 枚から 1 つを引き（乱数は引数。画面は crypto、サーバーは crypto）、その場で使えなければ不発。
 * 連続行動・巻き戻しが出たらカードと同じに効く（巻き戻しはすぐ戻す）。
 * 補充・王の移し替えが出たら armed.aim になり、続けて同じ id で戻す駒・移す先を指定する（この 2 回目は rng を使わない）
 */
export function useSkill(state: GameState, use: SkillUse, rng?: () => number): GameState {
  const p = state.turn;
  const sk = state.skills;
  const armed = sk?.armed;
  if (sk && armed?.aim) {
    if (use.id !== armed.id) throw new Error("運命の輪の指定を待っています");
    const { aim: _aim, ...note } = armed;
    return applyEffect({ ...state, skills: { ...sk, armed: null } }, armed.effect as "refill" | "kingmove", use, note);
  }
  const view = viewFor(state, p);
  const block = skillBlock(view);
  if (block) throw new Error(`スキルを使えません: ${block}`);
  const card = sk!.sides[p].card!;
  if (use.id !== card) throw new Error(`${use.id} は自分のカードではありません`);
  const sides: [SkillSide, SkillSide] = [sk!.sides[0], sk!.sides[1]];
  sides[p] = { ...sides[p], gauge: 0 };
  const spent: GameState = { ...state, skills: { ...sk!, sides } };
  switch (card) {
    case "judge":
      return takeBack(spent, p);
    case "fool":
      return { ...spent, skills: { ...spent.skills!, armed: { id: card } } };
    case "wheel": {
      if (!rng) throw new Error("運命の輪には乱数が要ります");
      const pool = wheelPool(state.rules);
      const effect = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
      const note: SkillNote = { id: card, effect };
      if (effectBlock(viewFor(spent, p), effect)) note.fizzle = true;
      else if (effect === "refill" || effect === "kingmove") note.aim = true;
      else if (effect === "judge") return takeBack(spent, p, note);
      else return applyEffect(spent, effect, {}, note);
      return { ...spent, skills: { ...spent.skills!, armed: note } };
    }
    default:
      return applyEffect(spent, card, use, { id: card });
  }
}

/** 巻き戻し以外の効果を手番の人に掛け、note を armed にする（ゲージは減らしてある前提） */
function applyEffect(state: GameState, effect: Exclude<WheelEffect, "judge">, use: Pick<SkillUse, "kind" | "to">, note: SkillNote): GameState {
  const p = state.turn;
  const q = other(p);
  const sk = state.skills!;
  const sides: [SkillSide, SkillSide] = [sk.sides[0], sk.sides[1]];
  const shielded: [boolean, boolean] = [sk.shielded[0], sk.shielded[1]];
  const next: GameState = { ...state };
  const view = viewFor(state, p);
  switch (effect) {
    case "firstaid":
    case "bigheal": {
      const hp: [number, number] = [state.hp[0], state.hp[1]];
      hp[p] = Math.min(state.rules.hp[p], hp[p] + SKILL_HEAL[effect]);
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
      if (scoutBlock(view)) throw new Error("偵察できません");
      if (scoutMode(view) === "find") {
        const kings: [KingState, KingState] = [state.kings[0], state.kings[1]];
        if (!kings[q].cell) throw new Error("相手の王が決まっていません");
        kings[q] = { ...kings[q], seen: true };
        next.kings = kings;
        note.scout = "find";
      } else {
        const kings: [KingState, KingState] = [state.kings[0], state.kings[1]];
        const v = kings[q].vice;
        if (!v?.cell) throw new Error("相手の副将が決まっていません");
        kings[q] = { ...kings[q], vice: { ...v, seen: true } };
        next.kings = kings;
        note.scout = "vice";
      }
      break;
    }
    case "kingmove": {
      const to = use.to;
      if (!to || !kingMoveCells(view).some(([y, x]) => y === to[0] && x === to[1])) throw new Error("そのマスには移せません");
      const kings: [KingState, KingState] = [state.kings[0], state.kings[1]];
      // 副将はそのまま（移せるマスに副将のマスは入らない）
      kings[p] = { cell: [to[0], to[1]], auto: false, revealed: false, ...(kings[p].vice ? { vice: kings[p].vice } : {}) };
      note.cands = [];
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (state.board[r][c]?.owner === p) note.cands.push([r, c]);
      next.kings = kings;
      break;
    }
    default:
      // 強打・全方向・連続行動は置く手で効く
      break;
  }
  const skills: SkillsState = { ...sk, sides, armed: note, shielded };
  return { ...next, skills };
}

/**
 * 巻き戻し: 手番の人 p の前の手番の頭の局面に戻す（自分の直前の手と、それに続く相手の応手をまとめて戻す）。
 * 相手の王の指定は戻さない: 戻した応手で相手が王を指定していたら、相手が次に置く駒がそのまま王になる（kept）。
 * 戻した後のゲージは戻した局面のもの（p は 0）。note は使ったスキル（運命の輪で出たときは id が wheel）
 */
function takeBack(state: GameState, p: Player, note: SkillNote = { id: "judge" }): GameState {
  const q = other(p);
  const sk = state.skills!;
  const snap = sk.undo?.[p];
  if (!snap?.skills) throw new Error("戻す手がありません");
  const kings: [KingState, KingState] = [snap.kings[0], snap.kings[1]];
  const cur = state.kings[q];
  if (!snap.kings[q].cell && cur.cell && !cur.revealed) kings[q] = { cell: null, auto: cur.auto, revealed: false, kept: true };
  // 相手の副将の指定も戻さない（王と同じ）: 副将は置いた駒で出すので、出した手を戻したら相手が次に置く駒がそのまま副将になる
  const sv = snap.kings[q].vice;
  const cv = cur.vice;
  if (sv && !sv.cell && cv?.cell && cv.since === sv.since) kings[q] = { ...kings[q], vice: { ...sv, kept: true } };
  const undone = state.history.slice(snap.history.length).filter((e): e is MoveEvent => e.type === "move");
  const mine = undone.find((e) => e.player === p);
  note.back = undone.length;
  if (mine) note.redo = { r: mine.r, c: mine.c, kind: mine.kind };
  const sides: [SkillSide, SkillSide] = [snap.skills.sides[0], snap.skills.sides[1]];
  sides[p] = { ...sides[p], gauge: 0 };
  // 戻した局面からは、どちらも次に自分が打つまで巻き戻しできない（局面を重ねて持たない）
  const { undo: _undo, ...base } = snap.skills;
  return { ...snap, kings, skills: { ...base, sides, armed: note, undo: [null, null] } };
}

/** 運命の輪の指定を rng で選ぶ（制限時間切れ）。補充は戻せる駒から、王の移し替えは移せるマスから一様に */
function randomAim(state: GameState, rng: () => number): SkillUse {
  const effect = state.skills!.armed!.effect;
  const pick = <T>(xs: T[]) => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
  if (effect === "refill") return { id: "wheel", kind: pick(refillKinds(state)) };
  return { id: "wheel", to: pick(kingMoveCells(viewFor(state, state.turn))) };
}

/** 巻き戻しで戻す局面を覚えるカード（巻き戻しと、巻き戻しが出うる運命の輪） */
const keepsUndo = (card: SkillId | null) => card === "judge" || card === "wheel";

/**
 * 打った手の後のスキルの状態（ゲージを足し、この手番で使ったスキル・この手に掛かった鉄壁・連続行動の 2 手目を消す）。
 * 巻き戻し・運命の輪のカードを持つ人が打ったら、打つ前の局面（手番の頭）を覚える
 */
function skillsAfterMove(before: GameState, move: MoveEvent, lost: number): SkillsState {
  const sk = before.skills!;
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
  const { second: _second, undo, ...rest } = sk;
  const out: SkillsState = { ...rest, sides, armed: null, shielded };
  if (undo || keepsUndo(card)) {
    const u: [GameState | null, GameState | null] = undo ? [undo[0], undo[1]] : [null, null];
    // 連続行動の 2 手目は手番の頭ではない（運命の輪で連続行動が出た 2 手目は 1 手目の前の局面のまま）
    if (keepsUndo(card) && !sk.second) {
      const { undo: _u, undoable: _ua, ...plain } = sk;
      u[p] = { ...before, skills: { ...plain, armed: null } };
    }
    out.undo = u;
  }
  return out;
}
