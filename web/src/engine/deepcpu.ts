// 深く読む CPU（エンドレスマッチの強い段階向け。今の easy / normal / hard の手は変えない）。
// 反復深化のアルファベータで、手の適用はエンジンの playMove / useSkill をそのまま使う（ルールを写し直さない）。
// 強さのつまみは調べる局面の数 DeepBudget.nodes（壁時計を使わないので、同じ view・同じ乱数・同じ予算なら同じ手）。
//
// 隠し情報は見ない: 入力は viewFor(state, 自分) の view だけ。探索に使う局面は view から作り直す（stateOf）:
// - 自分の王・副将は view の myKing / myVice から作る（相手は探索の中で自分の王・副将の場所を知っているものとして読む＝慎重側）
// - 相手の王・副将は「もうない」状態にしてエンジンに罰を付けさせず、公開の候補（王の候補・相手が最近置いて返されていない駒）
//   からの罰の見込みを、自分がその駒を初めて返したときに足す（同じ駒は 1 回だけ数える）
// スキル: 強打・全方向・鉄壁・連続行動・補充・回復は読みの手の候補に入れる（両者とも）。王の移し替えは自分の手番の頭だけ。
// 偵察・運命の輪・巻き戻しは乱数や見えない局面に頼るので読まず、skillcpu.ts の chooseSkillUse の規則で使う。

import { damageOf, emptyCells, healOf, pieceLines, rawLines, SIZE } from "./board";
import {
  attackable,
  availableKinds,
  kingCandidates,
  kingInfo,
  kingMoveCells,
  moveRules,
  movesBy,
  playMove,
  refillKinds,
  skillBlock,
  useSkill,
  viceInfo,
  vicesOn,
  viewFor,
  type GameState,
  type KingState,
  type PlayerView,
  type ViceState,
} from "./game";
import { other, type PieceKind, type Player } from "./rules";
import { chooseSkillUse, viceWith } from "./skillcpu";
import { gaugeMax, secondDamage, shieldDamage, SKILL_HEAL, strongDamage, VICE_DEADLINE, vicePenalty, type SkillId, type SkillUse } from "./skills";
import type { Choice } from "./cpu";

/** 読みの予算と形 */
export interface DeepBudget {
  /** 1 回の判断で調べる局面の数（playMove の回数）の上限 */
  nodes: number;
  /** 読む深さの上限（手数。既定 DEEP_MAX_DEPTH） */
  maxDepth?: number;
  /** 根より下の局面で読む手の数（手の見込みの上位。既定 DEEP_WIDTH） */
  width?: number;
}

/** 評価の係数（自己対戦で調整する） */
export interface DeepWeights {
  /** 読みの末端で、手番の人がすぐ取れる得点をどれだけ見込むか */
  tempo: number;
  /** ゲージの価値（満タンで使ったときの価値 × 溜まった割合 × これ） */
  gauge: number;
  /**
   * 相手が自分の王・副将の場所を知っているとして読む割合（1 なら真の場所の罰をそのまま、0 なら相手から見える候補に罰を等分する。
   * 偵察で知られていれば 1）
   */
  own: number;
}

export const DEEP_MAX_DEPTH = 8;
export const DEEP_WIDTH = 16;
export const DEEP_WEIGHTS: DeepWeights = { tempo: 0.8, gauge: 0.7, own: 1 };

/** 1 枚のカードを満タンで使ったときの価値の目安（点。回復は回復量） */
const CARD_VALUE: Record<SkillId, number> = {
  firstaid: SKILL_HEAL.firstaid,
  bigheal: SKILL_HEAL.bigheal,
  strong: 6,
  omni: 6,
  refill: 6,
  wall: 8,
  scout: 5,
  kingmove: 6,
  fool: 8,
  wheel: 8,
  judge: 8,
};

/** 勝ち負けの値（どんな体力差よりも大きい）と、決着までの 1 手ごとの差（手数の上限まで数えても WIN より小さい） */
const WIN = 1_000_000;
const PLY_COST = 1_000;

/**
 * 深く読む CPU の手番の次の操作。use はこの手番の頭に使うスキル、move は打つ手（王・副将の指定を含む）。
 * use と move の両方があれば、use を使った後にそのまま move を打つ。use だけなら、使った後にもう一度 chooseDeep を呼ぶ
 * （運命の輪・偵察・巻き戻しは使った結果で読みが変わる）。どちらも null なら打てない（終局）
 */
export interface DeepTurn {
  use: SkillUse | null;
  move: Choice | null;
  /** 調べた局面の数（playMove の回数。読まずに決めたら 0） */
  nodes: number;
  /** 最後まで読めた深さ（途中まで読めた深さを含む。読まずに決めたら 0） */
  depth: number;
}

/** 読みの途中で共有するもの */
interface Ctx {
  root: Player;
  budget: number;
  nodes: number;
  aborted: boolean;
  /** 根の手を 1 つ以上読み終えた深さ */
  depth: number;
  width: number;
  w: DeepWeights;
  /**
   * マスごとの罰の見込みの添字（-1 は見込みなし）・どちらが返したときか（0: 自分が相手の駒を / 1: 相手が自分の駒を）・
   * 重み（自分から見た値。同じ駒は 1 回だけ数える）。相手の置いた駒と自分の置いた駒のマスは重ならない
   */
  bonusBit: Int8Array;
  bonusSide: Int8Array;
  bonusW: number[];
}

/** 手の候補（スキルを使ってから置く手を含む） */
interface Act {
  use: SkillUse | null;
  /** use を使った後の局面（use がなければ元の局面） */
  from: GameState;
  r: number;
  c: number;
  kind: PieceKind;
  king: boolean;
  /** 並べる順の見込み（すぐ取れる得点） */
  order: number;
  /** この手で初めて返す相手の駒の罰の見込みの印と、その合計 */
  bits: number;
  bonus: number;
}

/**
 * 深く読む CPU で、手番の頭から次の操作を決める。乱数は同点の手の選び方・王の指定の時期・副将・運命の輪の指定に使う
 */
export function chooseDeep(view: PlayerView, budget: DeepBudget, rng: () => number, weights: DeepWeights = DEEP_WEIGHTS): DeepTurn {
  if (view.result) return { use: null, move: null, nodes: 0, depth: 0 };
  const sk = view.skills;
  const p = view.turn;
  // 運命の輪の指定待ち、読まないカード（偵察・運命の輪・巻き戻し）は skillcpu.ts の規則
  if (sk?.armed?.aim) return { use: chooseSkillUse(view, rng), move: null, nodes: 0, depth: 0 };
  const card = sk?.sides[p].card ?? null;
  const usable = card !== null && skillBlock(view) === null;
  if (usable && (card === "scout" || card === "wheel" || card === "judge")) {
    const use = chooseSkillUse(view, rng);
    if (use) return { use, move: null, nodes: 0, depth: 0 };
  }

  const state = stateOf(view);
  const ctx = makeCtx(view, budget, weights);
  const uses: (SkillUse | null)[] = [null];
  if (usable && card) uses.push(...rootUses(view, card));
  const mk = view.myKing;
  // 王の指定: 期限内の各手で「残りの手数分の 1」の確率で今回指定する候補を足す（cpu.ts の chooseWith と同じ時期の決め方）。
  // 期限の手はどの手でも置いた駒が王になるので、候補を二重にせず選んだ手に印を付ける
  const tryKing = mk.canDesignate && !mk.forcedNow && rng() < 1 / (view.rules.king.deadline - mk.nextMove + 1);
  const res = rootSearch(state, ctx, uses, tryKing, budget.maxDepth ?? DEEP_MAX_DEPTH);
  if (res.length === 0) return { use: null, move: null, nodes: ctx.nodes, depth: ctx.depth };

  // 王を指定する手は、指定しない最善と同じかよいときだけ選ぶ
  const bestOf = (xs: typeof res) => Math.max(...xs.map((x) => x.v));
  const withKing = res.filter((x) => x.a.king);
  const plain = res.filter((x) => !x.a.king);
  const pool = withKing.length > 0 && (plain.length === 0 || bestOf(withKing) >= bestOf(plain)) ? withKing : plain;
  const top = bestOf(pool);
  const ties = pool.filter((x) => x.v >= top - 1e-9);
  const a = ties[Math.min(ties.length - 1, Math.floor(rng() * ties.length))].a;
  const move: Choice = { r: a.r, c: a.c, kind: a.kind };
  if (a.king || mk.forcedNow) move.king = true;
  else if (viceWith(viewFor(a.from, p), move, rng)) move.vice = true;
  return { use: a.use, move, nodes: ctx.nodes, depth: ctx.depth };
}

// ---- 局面を作り直す（隠し情報なし） ----

/**
 * view から読みに使う局面を作る。自分の王・副将は view のとおり、相手の王・副将はエンジンが罰を付けない「ない」状態にする
 * （相手の王・副将の罰は Ctx の見込みで足す）。巻き戻しの局面（undo）は view にないので持たない
 */
function stateOf(view: PlayerView): GameState {
  const { viewer, myKing, oppKing: _ok, myVice, oppVice: _ov, ...pub } = view;
  const me: KingState =
    myKing.status === "hidden"
      ? { cell: [myKing.cell![0], myKing.cell![1]], auto: myKing.auto, revealed: false, ...(myKing.seen ? { seen: true as const } : {}) }
      : myKing.status === "revealed"
        ? { cell: null, auto: myKing.auto, revealed: true }
        : { cell: null, auto: false, revealed: false, ...(myKing.kept ? { kept: true as const } : {}) };
  const vice = viceOf(view);
  if (vice) me.vice = vice;
  // 相手の王は公開済みとして扱う（エンジンは返しても罰を付けず、相手が王を指定することもない）
  const opp: KingState = { cell: null, auto: false, revealed: true };
  const kings: [KingState, KingState] = viewer === 0 ? [me, opp] : [opp, me];
  const state: GameState = { ...pub, kings };
  if (pub.skills) {
    const { undoable: _u, ...rest } = pub.skills;
    state.skills = rest;
  }
  return state;
}

/**
 * 自分の副将の状態を view の myVice から作る。窓の周期は残りの手数 left から合わせ、窓の数は 1 か 2 にそろえる
 * （置いた副将の前の履歴は読みに要らない）。相手に見せる時期（due）は相手の読みでしか使わないので 0
 */
function viceOf(view: PlayerView): ViceState | null {
  const v = view.myVice;
  if (v.status === "off" || v.status === "wait") return null;
  const n = view.myKing.nextMove;
  const entry = v.cell ? { cell: [v.cell[0], v.cell[1]] as const, due: 0, ...(v.seen ? { seen: true as const } : {}) } : { cell: [0, 0] as const, due: 0, hit: true as const };
  // set: 窓 1 に置いてある（since + 7 − n + 1 = left）。unset: 窓 2 にまだ置いていない（前の窓の副将が list に 1 つ）
  const windows = v.status === "set" ? 1 : 2;
  const since = v.left + n - 1 - VICE_DEADLINE * windows;
  return { since, base: since, list: [entry], ...(v.kept ? { kept: true as const } : {}) };
}

// ---- 相手の王・副将の罰の見込み ----

function makeCtx(view: PlayerView, budget: DeepBudget, w: DeepWeights): Ctx {
  const bonusBit = new Int8Array(SIZE * SIZE).fill(-1);
  const bonusSide = new Int8Array(SIZE * SIZE);
  const bonusW: number[] = [];
  const add = (r: number, c: number, weight: number, side = 0) => {
    if (weight === 0) return;
    const k = r * SIZE + c;
    if (bonusBit[k] < 0) {
      if (bonusW.length >= 30) return;
      bonusBit[k] = bonusW.length;
      bonusSide[k] = side;
      bonusW.push(0);
    }
    if (bonusSide[k] === side) bonusW[bonusBit[k]] += weight;
  };
  const p = view.turn;
  const q = other(p);
  const { rules } = view;
  const ok = view.oppKing;
  const oppMoves = movesBy(view, q);
  if (rules.king.on && !ok.revealed && ok.candidates.length > 0) {
    const pen = rules.king.penalty === "lose" ? Math.max(1, view.hp[q]) : rules.king.amount;
    // 相手が期限より前に王を決めたかは分からないので、決めている見込みを打った手数 ÷ 期限とする
    const pk = ok.scouted ? 1 : Math.min(1, oppMoves / rules.king.deadline);
    for (const [y, x] of ok.candidates) add(y, x, (pen * pk) / ok.candidates.length);
  }
  if (vicesOn(rules)) {
    const ov = view.oppVice;
    if (ov.scouted && ov.cell) add(ov.cell[0], ov.cell[1], vicePenalty(rules));
    else {
      const started = ok.revealed || oppMoves >= rules.king.deadline;
      const pv = ov.set ? 1 : started ? 0.5 : 0;
      const known = ok.scouted ? ok.candidates[0] : null;
      const cells = pv > 0 ? viceCandidates(view, q, known) : [];
      for (const [y, x] of cells) add(y, x, (vicePenalty(rules) * pv) / cells.length);
    }
  }
  // 自分の王・副将: エンジンは真の場所の罰を付ける。相手が知らない分（1 − own）は真の場所から戻し、相手から見える候補に等分する
  const doubt = 1 - Math.max(0, Math.min(1, w.own));
  const mk = view.myKing;
  if (doubt > 0 && mk.status === "hidden" && !mk.seen && mk.cell) {
    const pen = rules.king.penalty === "lose" ? Math.max(1, view.hp[p]) : rules.king.amount;
    const cands = kingCandidates(view, p);
    add(mk.cell[0], mk.cell[1], doubt * pen, 1);
    for (const [y, x] of cands) add(y, x, (-doubt * pen) / cands.length, 1);
  }
  const mv = view.myVice;
  if (doubt > 0 && mv.cell && !mv.seen) {
    const cells = viceCandidates(view, p, mk.cell);
    add(mv.cell[0], mv.cell[1], doubt * vicePenalty(rules), 1);
    for (const [y, x] of cells) add(y, x, (-doubt * vicePenalty(rules)) / cells.length, 1);
  }
  return {
    root: p,
    budget: Math.max(1, budget.nodes),
    nodes: 0,
    aborted: false,
    depth: 0,
    width: Math.max(1, budget.width ?? DEEP_WIDTH),
    w,
    bonusBit,
    bonusSide,
    bonusW,
  };
}

/**
 * q の副将の候補（公開情報）: q が最近 2 つの窓の間（VICE_DEADLINE × 2 手）に置いた駒のうち、置いてから一度も返されていないもの。
 * 王と分かっている駒（except）は除く
 */
function viceCandidates(view: PlayerView, q: Player, except: readonly [number, number] | null): [number, number][] {
  const placed = new Map<number, number>();
  let n = 0;
  const total = movesBy(view, q);
  for (const e of view.history) {
    if (e.type !== "move") continue;
    if (e.player === q) {
      n++;
      if (n > total - VICE_DEADLINE * 2) placed.set(e.r * SIZE + e.c, n);
    } else for (const t of e.targets) placed.delete(t.r * SIZE + t.c);
  }
  if (except) placed.delete(except[0] * SIZE + except[1]);
  return [...placed.keys()].filter((k) => view.board[Math.floor(k / SIZE)][k % SIZE]?.owner === q).map((k) => [Math.floor(k / SIZE), k % SIZE]);
}

// ---- 手の候補 ----

/** 手番の頭で読みに入れる自分のスキル（王の移し替えは次の手で返されない駒へ、補充は数字の大きい駒 2 つまで） */
function rootUses(view: PlayerView, card: SkillId): SkillUse[] {
  switch (card) {
    case "strong":
    case "omni":
    case "wall":
    case "fool":
    case "firstaid":
    case "bigheal":
      return [{ id: card }];
    case "refill":
      return byValue(view.rules.values, refillKinds(view)).slice(0, 2).map((kind) => ({ id: card, kind }));
    case "kingmove": {
      const q = other(view.turn);
      const threatened = new Set(attackable(view.rules, view.board, view.hands[q], q).map(([y, x]) => y * SIZE + x));
      const edge = ([y, x]: readonly [number, number]) => (y === 0 || y === SIZE - 1 ? 1 : 0) + (x === 0 || x === SIZE - 1 ? 1 : 0);
      const safe = kingMoveCells(view).filter(([y, x]) => !threatened.has(y * SIZE + x));
      return safe
        .map((cell, i) => ({ cell, i }))
        .sort((a, b) => edge(b.cell) - edge(a.cell) || a.i - b.i)
        .slice(0, 3)
        .map(({ cell }) => ({ id: card, to: cell }));
    }
    default:
      return [];
  }
}

const byValue = (values: Record<PieceKind, number>, kinds: PieceKind[]) => [...kinds].sort((a, b) => values[b] - values[a]);

/** 読みの中で手番の人が使えるスキル（強打・全方向・鉄壁・連続行動・回復・補充。王の移し替え・偵察・運命の輪・巻き戻しは読まない） */
function treeUses(s: GameState): SkillUse[] {
  const sk = s.skills;
  if (!sk || !sk.ready || sk.armed || sk.second || s.result) return [];
  const p = s.turn;
  const card = sk.sides[p].card;
  if (!card || sk.sides[p].gauge < gaugeMax(card, s.rules)) return [];
  switch (card) {
    case "strong":
    case "omni":
    case "wall":
    case "fool":
      return [{ id: card }];
    case "firstaid":
    case "bigheal":
      return s.hp[p] < s.rules.hp[p] ? [{ id: card }] : [];
    case "refill": {
      const kind = byValue(s.rules.values, refillKinds(s))[0];
      return kind ? [{ id: card, kind }] : [];
    }
    default:
      return [];
  }
}

/** 手番の人のこの手のダメージの倍率（強打・相手の鉄壁・連続行動の 2 手目） */
function damageMod(s: GameState, d: number): number {
  const sk = s.skills;
  if (!sk) return d;
  const a = sk.armed;
  if (a && !a.fizzle && !a.aim && (a.effect ?? a.id) === "strong") d = strongDamage(d, !!a.ex);
  if (sk.shielded[s.turn]) d = shieldDamage(d, !!sk.wallEx?.[s.turn]);
  if (sk.second && !sk.secondEx) d = secondDamage(d);
  return d;
}

/** 局面 from で手番の人が置ける手（王を指定する手も withKing なら足す）。見込みの高い順 */
function movesOf(from: GameState, use: SkillUse | null, ctx: Ctx, mask: number, withKing: boolean): Act[] {
  const out: Act[] = [];
  scanMoves(from, ctx, mask, (r, c, kind, order, bits, bonus) => {
    out.push({ use, from, r, c, kind, king: false, order, bits, bonus });
    if (withKing) out.push({ use, from, r, c, kind, king: true, order, bits, bonus });
  });
  return out.sort((a, b) => b.order - a.order);
}

/**
 * 局面 from で手番の人が置ける手ごとに、すぐ取れる得点（ダメージ ＋ 回復 ＋ 罰）を求めて f に渡す。
 * 自分の手なら、まだ返していない相手の駒の罰の見込み（bits / bonus）を足す。相手の手なら、自分の王・副将を返す罰を足す
 */
function scanMoves(
  from: GameState,
  ctx: Ctx,
  mask: number,
  f: (r: number, c: number, kind: PieceKind, order: number, bits: number, bonus: number) => void,
): void {
  const p = from.turn;
  const rules = moveRules(from);
  const mine = p === ctx.root;
  const myKing = mine ? null : kingInfo(from, ctx.root).cell;
  const myVice = mine ? null : viceInfo(from, ctx.root).cell;
  const kinds = availableKinds(from.hands[p]);
  for (const [r, c] of emptyCells(from.board)) {
    const raw = rawLines(from.board, r, c, p, rules.values);
    if (raw.length === 0 && rules.action === "flip") continue;
    for (const kind of kinds) {
      const lines = pieceLines(raw, kind, rules);
      if (rules.action === "flip" && lines.length === 0) continue;
      let order = damageMod(from, damageOf(from.board, lines, rules)) + healOf(lines, rules.values[kind], rules);
      let bits = 0;
      let bonus = 0;
      for (const l of lines) {
        for (const [y, x] of l.cells) {
          const k = y * SIZE + x;
          const b = ctx.bonusBit[k];
          if (b >= 0 && ctx.bonusSide[k] === (mine ? 0 : 1) && !(mask & (1 << b)) && !(bits & (1 << b))) {
            bits |= 1 << b;
            bonus += ctx.bonusW[b];
          }
          if (!mine) {
            if (myKing && myKing[0] === y && myKing[1] === x) order += from.rules.king.amount;
            if (myVice && myVice[0] === y && myVice[1] === x) order += vicePenalty(from.rules);
          }
        }
      }
      // order は手番の人から見た得点、bonus は自分から見た値
      f(r, c, kind, mine ? order + bonus : order - bonus, bits, bonus);
    }
  }
}

/** 局面 s の手番の人の手の候補（スキルを使う手を含む）。top なら絞らない */
function actsOf(s: GameState, ctx: Ctx, mask: number, uses: (SkillUse | null)[], withKing: boolean, top: boolean): Act[] {
  const out: Act[] = [];
  for (const use of uses) {
    let from = s;
    if (use) {
      try {
        from = useSkill(s, use);
      } catch {
        continue;
      }
    }
    const ms = movesOf(from, use, ctx, mask, withKing);
    // スキルを使う手は使わない手より少なく読む（使う手が枠から押し出されないよう、別に数える）
    out.push(...(top ? ms : ms.slice(0, use ? Math.ceil(ctx.width / 2) : ctx.width)));
  }
  return out;
}

// ---- 探索 ----

interface RootResult {
  a: Act;
  v: number;
}

/** 根の手をすべて反復深化で読み、最後まで読めた深さでの各手の値を返す */
function rootSearch(s: GameState, ctx: Ctx, uses: (SkillUse | null)[], withKing: boolean, maxDepth: number): RootResult[] {
  let acts = actsOf(s, ctx, 0, uses, withKing, true);
  if (acts.length === 0) return [];
  let done: RootResult[] = acts.map((a) => ({ a, v: a.order }));
  for (let depth = 1; depth <= maxDepth; depth++) {
    const cur: RootResult[] = [];
    let alpha = -Infinity;
    for (const a of acts) {
      const v = child(a, depth - 1, alpha - 1e-6, Infinity, 0, 0, ctx);
      if (ctx.aborted) break;
      cur.push({ a, v });
      if (v > alpha) alpha = v;
    }
    // 途中で予算が尽きたら、読めた手（前の深さの最善の手から読むので、それを含む）の中から選ぶ
    if (cur.length > 0) {
      done = cur;
      ctx.depth = depth;
    }
    if (ctx.aborted) break;
    // 次の深さは今の値の順に読む
    const order = new Map(done.map((d) => [d.a, d.v]));
    acts = [...acts].sort((x, y) => order.get(y)! - order.get(x)!);
  }
  return done;
}

/** 手 a を打った後の局面を読む */
function child(a: Act, depth: number, alpha: number, beta: number, mask: number, acc: number, ctx: Ctx): number {
  if (ctx.nodes >= ctx.budget) {
    ctx.aborted = true;
    return 0;
  }
  ctx.nodes++;
  const next = playMove(a.from, a.r, a.c, a.kind, a.king ? { king: true } : {});
  return search(next, depth, alpha, beta, mask | a.bits, acc + a.bonus, ctx);
}

function search(s: GameState, depth: number, alpha: number, beta: number, mask: number, acc: number, ctx: Ctx): number {
  if (s.result) return terminal(s, ctx);
  if (depth === 0) return leaf(s, mask, acc, ctx);
  const acts = actsOf(s, ctx, mask, [null, ...treeUses(s)], false, false).sort((x, y) => y.order - x.order);
  const maxing = s.turn === ctx.root;
  let best = maxing ? -Infinity : Infinity;
  for (const a of acts) {
    const v = child(a, depth - 1, alpha, beta, mask, acc, ctx);
    if (ctx.aborted) return 0;
    if (maxing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }
  return best;
}

/** 終局の値。勝ちは早いほど、負けは遅いほどよい（決着を先送りしない） */
function terminal(s: GameState, ctx: Ctx): number {
  const q = other(ctx.root);
  const diff = s.hp[ctx.root] - s.hp[q];
  const w = s.result!.winner;
  return w === null ? diff : w === ctx.root ? WIN - PLY_COST * s.ply + diff : -WIN + PLY_COST * s.ply + diff;
}

/** 読みの末端の評価（自分から見て）: 体力差 ＋ 相手の王・副将を返した見込み ＋ ゲージ ＋ 手番の人がすぐ取れる得点の見込み */
function leaf(s: GameState, mask: number, acc: number, ctx: Ctx): number {
  const p = ctx.root;
  const q = other(p);
  let v = s.hp[p] - s.hp[q] + acc;
  if (s.skills) v += ctx.w.gauge * (gaugeValue(s, p) - gaugeValue(s, q));
  const now = bestNow(s, mask, ctx);
  v += (s.turn === p ? 1 : -1) * ctx.w.tempo * now;
  return v;
}

/** p のゲージの価値（満タンで使ったときの価値 × 溜まった割合） */
function gaugeValue(s: GameState, p: Player): number {
  const side = s.skills!.sides[p];
  if (!side.card) return 0;
  return (CARD_VALUE[side.card] * side.gauge) / gaugeMax(side.card, s.rules);
}

/** 手番の人が次の 1 手で取れる最大の得点（ダメージ ＋ 回復 ＋ 王・副将の罰。自分なら相手の罰の見込み） */
function bestNow(s: GameState, mask: number, ctx: Ctx): number {
  let best = 0;
  scanMoves(s, ctx, mask, (_r, _c, _k, order) => {
    if (order > best) best = order;
  });
  return best;
}
