// CPU の打ち手。sim/kyosho.py・sim/capture.py・sim/gate.py の bot_lookahead（2 手読み）を全設定共通にしたもの。
// 評価 = 自分の (ダメージ + 回復) − 相手の最善応手の (ダメージ + 回復)。同点はランダム。
// 隠し王ありでは、相手の王の「候補」（公開情報）と自分の王だけを見て罰を評価に足す（PlayerView は相手の王の正体を持たない）。

import { applyLines, damageOf, emptyCells, healOf, pieceLines, rawLines, SIZE, type Cell } from "./board";
import { availableKinds, bestReply, type PlayerView } from "./game";
import { other, type PieceKind, type Player } from "./rules";

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
  if (view.result) return null;
  const pick = (cs: Choice[]) => cs[Math.floor(rng() * cs.length)];
  const normal = lookaheadCandidates(view);
  if (normal.cands.length === 0) return null;
  const mk = view.myKing;
  if (mk.canDesignate) {
    const remaining = view.rules.king.deadline - mk.nextMove + 1;
    if (mk.forcedNow || rng() < 1 / remaining) {
      const withKing = lookaheadCandidates(view, { designate: true });
      if (mk.forcedNow || withKing.best >= normal.best) return { ...pick(withKing.cands), king: true };
    }
  }
  return pick(normal.cands);
}
