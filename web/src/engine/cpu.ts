// CPU の打ち手。sim/kyosho.py の bot_lookahead（2 手読み）の移植。
// 評価 = 自分の (攻撃 + 回復) − 相手の最善応手の (攻撃 + 回復)。同点はランダム。

import { applyMove, evaluate, legalMoves } from "./board";
import { availableKinds, type GameState } from "./game";
import { PIECES, type PieceKind, type Player } from "./rules";

export interface Choice {
  r: number;
  c: number;
  kind: PieceKind;
}

/** 最善スコアと、そのスコアを取る候補手すべて */
export function lookaheadCandidates(state: GameState): { best: number; cands: Choice[] } {
  const p = state.turn;
  const q: Player = p === 0 ? 1 : 0;
  const myKinds = availableKinds(state.hands[p]);
  const oppKinds = availableKinds(state.hands[q]);
  let best = -Infinity;
  let cands: Choice[] = [];
  if (myKinds.length === 0) return { best, cands };

  for (const m of legalMoves(state.board, p)) {
    // 相手の最善応手は置いた駒の数値だけで決まるので、数値ごとに使い回す
    const replyByValue = new Map<number, number>();
    for (const kind of myKinds) {
      const eff = evaluate(state.board, m.lines, kind);
      const value = PIECES[kind].value;
      let reply = replyByValue.get(value);
      if (reply === undefined) {
        reply = 0;
        if (oppKinds.length > 0) {
          const nb = applyMove(state.board, p, m.r, m.c, m.lines, kind);
          for (const m2 of legalMoves(nb, q)) {
            for (const k2 of oppKinds) {
              const e2 = evaluate(nb, m2.lines, k2);
              reply = Math.max(reply, e2.attack + e2.heal);
            }
          }
        }
        replyByValue.set(value, reply);
      }
      const s = eff.attack + eff.heal - reply;
      if (s > best) {
        best = s;
        cands = [{ r: m.r, c: m.c, kind }];
      } else if (s === best) {
        cands.push({ r: m.r, c: m.c, kind });
      }
    }
  }
  return { best, cands };
}

/** 2 手読みで 1 手選ぶ。打てる手がなければ null */
export function chooseLookahead(state: GameState, rng: () => number = Math.random): Choice | null {
  const { cands } = lookaheadCandidates(state);
  if (cands.length === 0) return null;
  return cands[Math.floor(rng() * cands.length)];
}
