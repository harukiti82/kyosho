// CPU の打ち手。sim/capture.py の bot_lookahead（2 手読み）の移植。
// 評価 = 自分のダメージ − 相手の最善応手のダメージ。同点はランダム。

import { applyMove, bestCapture, damageOf, emptyCells, capturesAt } from "./board";
import { availableKinds, type GameState } from "./game";
import { other, type PieceKind } from "./rules";

export interface Choice {
  r: number;
  c: number;
  kind: PieceKind;
}

/** 最善スコアと、そのスコアを取る候補手すべて */
export function lookaheadCandidates(state: GameState): { best: number; cands: Choice[] } {
  const p = state.turn;
  const q = other(p);
  const myKinds = availableKinds(state.hands[p]);
  // 相手の持ち駒は自分の着手で変わらない（取った駒は自分に入る）
  const oppHasPiece = availableKinds(state.hands[q]).length > 0;
  let best = -Infinity;
  let cands: Choice[] = [];

  for (const [r, c] of emptyCells(state.board)) {
    const d = damageOf(state.board, capturesAt(state.board, r, c, p));
    for (const kind of myKinds) {
      // 置いた駒の数字によって相手の取れる量が変わるので、駒種ごとに読む
      const reply = oppHasPiece ? bestCapture(applyMove(state.board, p, r, c, kind).board, q) : 0;
      const s = d - reply;
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
