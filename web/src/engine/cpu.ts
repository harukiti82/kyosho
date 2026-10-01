// CPU の打ち手。sim/kyosho.py・sim/capture.py・sim/gate.py の bot_lookahead（2 手読み）を全設定共通にしたもの。
// 評価 = 自分の (ダメージ + 回復) − 相手の最善応手の (ダメージ + 回復)。同点はランダム。

import { applyLines, damageOf, emptyCells, gateLines, healOf, rawLines } from "./board";
import { availableKinds, bestReply, type GameState } from "./game";
import { other, PIECES, type PieceKind } from "./rules";

export interface Choice {
  r: number;
  c: number;
  kind: PieceKind;
}

/** 最善スコアと、そのスコアを取る候補手すべて */
export function lookaheadCandidates(state: GameState): { best: number; cands: Choice[] } {
  const { rules, board } = state;
  const p = state.turn;
  const q = other(p);
  const myKinds = availableKinds(state.hands[p]);
  // 相手の持ち駒は自分の着手で変わらない（取った駒は自分の持ち駒に入る）
  const oppHand = state.hands[q];
  let best = -Infinity;
  let cands: Choice[] = [];

  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p);
    for (const kind of myKinds) {
      const v = PIECES[kind].value;
      const lines = gateLines(raw, v, rules.gate);
      if (rules.action === "flip" && lines.length === 0) continue;
      const own = damageOf(board, lines, rules) + healOf(lines, v, rules);
      // 置いた駒の数字によって相手の返せる量が変わるので、駒種ごとに読む
      const reply = bestReply(rules, applyLines(board, p, r, c, kind, lines, rules), oppHand, q).score;
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

/** 2 手読みで 1 手選ぶ。打てる手がなければ null */
export function chooseLookahead(state: GameState, rng: () => number = Math.random): Choice | null {
  if (state.result) return null;
  const { cands } = lookaheadCandidates(state);
  if (cands.length === 0) return null;
  return cands[Math.floor(rng() * cands.length)];
}
