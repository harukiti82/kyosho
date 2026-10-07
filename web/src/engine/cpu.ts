// CPU の打ち手。ノーマルは sim/kyosho.py・sim/capture.py・sim/gate.py の bot_lookahead（2 手読み）を全設定共通にしたもの。
// 評価 = 自分の (ダメージ + 回復) − 相手の最善応手の (ダメージ + 回復)。同点はランダム。ダメージは damageOf（端の駒の上乗せ込み）。
// 隠し王ありでは、相手の王の「候補」（公開情報）と自分の王だけを見て罰を評価に足す（PlayerView は相手の王の正体を持たない）。
// 強さは 3 段階（chooseMove）。イージーは 1 手読み＋ときどき適当な手、ハードは候補を絞った 3 手読み＋決着の読み。

import { applyLines, damageOf, emptyCells, healOf, pieceLines, rawLines, SIZE, targetsOf, type Board, type Cell, type Line } from "./board";
import { availableKinds, bestReply, type PlayerView } from "./game";
import { other, type Hand, type PieceKind, type Player } from "./rules";

/** CPU の強さ */
export type CpuLevel = "easy" | "normal" | "hard";
export const CPU_LEVELS: readonly CpuLevel[] = ["easy", "normal", "hard"];
export const DEFAULT_CPU_LEVEL: CpuLevel = "normal";
export const CPU_LEVEL_NAME: Record<CpuLevel, string> = { easy: "イージー", normal: "ノーマル", hard: "ハード" };

/** イージーが読まずに適当な手を打つ確率 */
const EASY_RANDOM = 0.35;
/** ハードが 3 手目まで読む自分の候補の数（2 手読みの上位）と、そのときに読む相手の応手の数（その手の得点の上位） */
const HARD_MOVES = 8;
const HARD_REPLIES = 6;
/** ハード: 相手の体力を削り切る手・削り切られる手の重み（どんな得点差よりも大きい） */
const DECISIVE = 100_000;

export interface Choice {
  r: number;
  c: number;
  kind: PieceKind;
  /** この手で置く駒を自分の王にする */
  king?: boolean;
}

/** 王を返されたときの罰を評価値にしたもの。即負けは残りの体力をすべて失うのと同じとみなす */
function penaltyOf(view: PlayerView, victim: Player): number {
  const { king } = view.rules;
  return king.penalty === "lose" ? Math.max(1, view.hp[victim]) : king.amount;
}

/**
 * 最善スコアと、そのスコアを取る候補手すべて。
 * 隠し王ありでは 自分の (ダメージ + 回復 + 罰 × 返す候補の数 ÷ 候補の総数) − 相手の最善応手の (ダメージ + 回復 + 自分の王を返すなら罰)。
 * designate なら、この手で置く駒を王にするとして読む
 */
export function lookaheadCandidates(view: PlayerView, opts: { designate?: boolean } = {}): { best: number; cands: Choice[] } {
  const { rules, board } = view;
  const p = view.turn;
  const q = other(p);
  const myKinds = availableKinds(view.hands[p]);
  // 相手の持ち駒は自分の着手で変わらない（取った駒は自分の持ち駒に入る）
  const oppHand = view.hands[q];
  const oppCands = new Set(view.oppKing.candidates.map(([y, x]) => y * SIZE + x));
  const oppPenalty = oppCands.size > 0 ? penaltyOf(view, q) / oppCands.size : 0;
  const myPenalty = rules.king.on ? penaltyOf(view, p) : 0;
  let best = -Infinity;
  let cands: Choice[] = [];

  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p, rules.values);
    const myKing: Cell | null = opts.designate ? [r, c] : view.myKing.cell;
    for (const kind of myKinds) {
      const v = rules.values[kind];
      // 挟める方向が「駒ごと」なら、その駒の方向の列だけ
      const lines = pieceLines(raw, kind, rules);
      if (rules.action === "flip" && lines.length === 0) continue;
      let own = damageOf(board, lines, rules) + healOf(lines, v, rules);
      if (oppPenalty > 0) {
        const hits = lines.reduce((n, l) => n + l.cells.filter(([y, x]) => oppCands.has(y * SIZE + x)).length, 0);
        own += oppPenalty * hits;
      }
      // 置いた駒の数字・方向によって相手の返せる量が変わるので、駒種ごとに読む
      const next = applyLines(board, p, r, c, kind, lines, rules);
      const reply = bestReply(rules, next, oppHand, q, myKing ? { cell: myKing, penalty: myPenalty } : undefined).score;
      const s = own - reply;
      if (s > best) {
        best = s;
        cands = [{ r, c, kind }];
      } else if (s === best) {
        cands.push({ r, c, kind });
      }
    }
  }
  return { best, cands };
}

/**
 * 2 手読みで 1 手選ぶ。打てる手がなければ null。
 * 隠し王の指定: 期限内の各手で「残りの手数分の 1」の確率で今回指定するかを決める（期限内のどの手になるかがほぼ一様になる）。
 * 指定する手は王が返されにくい手を読みで選ぶが、その手が普段の最善より悪くなる（王がすぐ返されうる）なら見送る。期限の手では必ず指定する
 */
export function chooseLookahead(view: PlayerView, rng: () => number = Math.random): Choice | null {
  return chooseWith(view, rng, lookaheadCandidates);
}

/** 強さに合わせて 1 手選ぶ。ノーマルは chooseLookahead と同じ（同じ乱数で同じ手） */
export function chooseMove(view: PlayerView, level: CpuLevel, rng: () => number = Math.random): Choice | null {
  if (level === "easy") return chooseEasy(view, rng);
  if (level === "hard") return chooseWith(view, rng, hardCandidates);
  return chooseLookahead(view, rng);
}

type Candidates = (view: PlayerView, opts?: { designate?: boolean }) => { best: number; cands: Choice[] };

/** 候補の出し方（2 手読み・3 手読み）が違うだけで、王の指定の決め方は同じ */
function chooseWith(view: PlayerView, rng: () => number, candidates: Candidates): Choice | null {
  if (view.result) return null;
  const pick = (cs: Choice[]) => cs[Math.floor(rng() * cs.length)];
  const normal = candidates(view);
  if (normal.cands.length === 0) return null;
  const mk = view.myKing;
  if (mk.canDesignate) {
    const remaining = view.rules.king.deadline - mk.nextMove + 1;
    if (mk.forcedNow || rng() < 1 / remaining) {
      const withKing = candidates(view, { designate: true });
      if (mk.forcedNow || withKing.best >= normal.best) return { ...pick(withKing.cands), king: true };
    }
  }
  return pick(normal.cands);
}

/** 置ける手と、その手の自分の得点（ダメージ + 回復。読みなし） */
interface Plain {
  ch: Choice;
  lines: Line[];
  damage: number;
  heal: number;
}

function plainMoves(rules: PlayerView["rules"], board: Board, hand: Hand, p: Player): Plain[] {
  const out: Plain[] = [];
  const kinds = availableKinds(hand);
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p, rules.values);
    for (const kind of kinds) {
      const lines = pieceLines(raw, kind, rules);
      if (rules.action === "flip" && lines.length === 0) continue;
      out.push({ ch: { r, c, kind }, lines, damage: damageOf(board, lines, rules), heal: healOf(lines, rules.values[kind], rules) });
    }
  }
  return out;
}

/**
 * イージー: 相手の応手を読まず、その手で与えるダメージ + 回復だけで選ぶ。EASY_RANDOM の確率で置ける手から適当に選ぶ。
 * 隠し王は期限内に一様に近いタイミングで、選んだ手の駒をそのまま王にする（王が返されやすいかは読まない）
 */
function chooseEasy(view: PlayerView, rng: () => number): Choice | null {
  if (view.result) return null;
  const moves = plainMoves(view.rules, view.board, view.hands[view.turn], view.turn);
  if (moves.length === 0) return null;
  let pool = moves;
  if (rng() >= EASY_RANDOM) {
    const best = Math.max(...moves.map((m) => m.damage + m.heal));
    pool = moves.filter((m) => m.damage + m.heal === best);
  }
  const ch = pool[Math.floor(rng() * pool.length)].ch;
  const mk = view.myKing;
  if (mk.canDesignate && (mk.forcedNow || rng() < 1 / (view.rules.king.deadline - mk.nextMove + 1))) return { ...ch, king: true };
  return ch;
}

/** board で m を打った後の持ち駒（取るルールでは取った駒が入る） */
function handAfterOf(rules: PlayerView["rules"], board: Board, hand: Hand, m: Plain): Hand {
  const next = { ...hand };
  next[m.ch.kind]--;
  if (rules.action === "capture") for (const [y, x] of targetsOf(m.lines)) next[board[y][x]!.kind]++;
  return next;
}

/** p の最善手を 2 手読みで評価した値（p の得点 − 相手の最善応手の得点）。打てる手がなければ 0 */
function replyAhead(rules: PlayerView["rules"], board: Board, hand: Hand, oppHand: Hand, p: Player): number {
  let best = 0;
  let any = false;
  for (const m of plainMoves(rules, board, hand, p)) {
    const next = applyLines(board, p, m.ch.r, m.ch.c, m.ch.kind, m.lines, rules);
    const v = m.damage + m.heal - bestReply(rules, next, oppHand, other(p)).score;
    if (!any || v > best) best = v;
    any = true;
  }
  return best;
}

/**
 * ハード: 2 手読みの上位 HARD_MOVES 手だけを 3 手目まで読む。
 * 評価 = 自分の得点 − max(相手の応手の得点 − その後の自分の最善の得点)。相手の応手は得点の上位 HARD_REPLIES 手だけを読む。
 * 相手の体力を削り切る手は最優先、相手に削り切られる応手は最悪として読む（2 手読みは決着を区別しない）
 */
export function hardCandidates(view: PlayerView, opts: { designate?: boolean } = {}): { best: number; cands: Choice[] } {
  const { rules } = view;
  const p = view.turn;
  const q = other(p);
  const oppHand = view.hands[q];
  const oppCands = new Set(view.oppKing.candidates.map(([y, x]) => y * SIZE + x));
  const oppPenalty = oppCands.size > 0 ? penaltyOf(view, q) / oppCands.size : 0;
  const myPenalty = rules.king.on ? penaltyOf(view, p) : 0;

  // 2 手読みの評価で全手を並べる（lookaheadCandidates と同じ計算）
  const scored = plainMoves(rules, view.board, view.hands[p], p).map((m) => {
    let own = m.damage + m.heal;
    if (oppPenalty > 0) own += oppPenalty * m.lines.reduce((n, l) => n + l.cells.filter(([y, x]) => oppCands.has(y * SIZE + x)).length, 0);
    const myKing: Cell | null = opts.designate ? [m.ch.r, m.ch.c] : view.myKing.cell;
    const next = applyLines(view.board, p, m.ch.r, m.ch.c, m.ch.kind, m.lines, rules);
    const king = myKing ? { cell: myKing, penalty: myPenalty } : undefined;
    const two = own - bestReply(rules, next, oppHand, q, king).score;
    return { m, own, next, king, two };
  });
  if (scored.length === 0) return { best: -Infinity, cands: [] };
  const top = scored.map((s, i) => ({ s, i })).sort((a, b) => b.s.two - a.s.two || a.i - b.i).slice(0, HARD_MOVES);

  let best = -Infinity;
  let cands: Choice[] = [];
  for (const { s } of top) {
    let v: number;
    if (s.m.damage >= view.hp[q]) {
      v = DECISIVE + s.own;
    } else {
      const myHp = view.hp[p] + s.m.heal;
      const myHand = handAfterOf(rules, view.board, view.hands[p], s.m);
      const replies = plainMoves(rules, s.next, oppHand, q)
        .filter((r) => r.lines.length > 0)
        .map((r) => {
          const hit = s.king && r.lines.some((l) => l.cells.some(([y, x]) => y === s.king!.cell[0] && x === s.king!.cell[1]));
          return { r, score: r.damage + r.heal + (hit ? s.king!.penalty : 0), lethal: r.damage + (hit ? s.king!.penalty : 0) >= myHp };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, HARD_REPLIES);
      let reply: number;
      if (replies.length === 0) {
        // 相手は返せる手がない（パスか、取るルールで何も取らない手）。自分がもう 1 手打つとみなす
        reply = -replyAhead(rules, s.next, myHand, oppHand, p);
      } else {
        reply = -Infinity;
        for (const { r, score, lethal } of replies) {
          if (lethal) {
            reply = DECISIVE;
            break;
          }
          const after = applyLines(s.next, q, r.ch.r, r.ch.c, r.ch.kind, r.lines, rules);
          reply = Math.max(reply, score - replyAhead(rules, after, myHand, handAfterOf(rules, s.next, oppHand, r), p));
        }
      }
      v = s.own - reply;
    }
    if (v > best) {
      best = v;
      cands = [s.m.ch];
    } else if (v === best) {
      cands.push(s.m.ch);
    }
  }
  return { best, cands };
}
