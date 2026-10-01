// sim/kyosho.py（Python エンジン）との整合テスト。
// fixtures/replays.json は `python3 sim/export_replays.py` で生成する。

import { describe, expect, it } from "vitest";
import { applyMove, evaluate, legalMoves, newBoard, type Board } from "../src/engine/board";
import { lookaheadCandidates } from "../src/engine/cpu";
import { createGame, playMove, type GameState } from "../src/engine/game";
import { makeRules, type PieceKind, type Player } from "../src/engine/rules";
import replays from "./fixtures/replays.json";

type PyCell = [number, number] | null;
type PyEvent =
  | { t: "pass"; p: Player }
  | {
      t: "move";
      p: Player;
      r: number;
      c: number;
      kind: PieceKind;
      attack: number;
      heal: number;
      n: number;
      best?: number;
      cands?: [number, number, PieceKind][];
    };
interface PyGame {
  bots: string[];
  events: PyEvent[];
  final_board: PyCell[][];
  winner: -1 | 0 | 1;
  ko_ply: number | null;
  end_board: PyCell[][];
  end_hp: [number, number];
}

const dump = (b: Board): PyCell[][] => b.map((row) => row.map((s) => (s ? [s.owner, s.value] : null)));
const key = (r: number, c: number, k: string) => `${r},${c},${k}`;

const data = replays as unknown as Record<"standard" | "kaku", PyGame[]>;

describe.each(["standard", "kaku"] as const)("Python エンジンとの整合（%s）", (name) => {
  const rules = makeRules({ kaku: name === "kaku" });
  const games = data[name];

  it("棋譜が十分にある", () => {
    expect(games.length).toBeGreaterThanOrEqual(30);
  });

  it.each(games.map((g, i) => [i, g] as const))("局 %i: 全手の攻撃・回復と最終盤面が一致", (_, g) => {
    // 体力を見ない低レベル再生（Python の play() と同じく盤が尽きるまで）
    let b = newBoard();
    const hands = [{ ...rules.hand }, { ...rules.hand }];
    let expectedTurn: Player = 0;
    for (const ev of g.events) {
      expect(ev.p).toBe(expectedTurn);
      const hasPiece = Object.values(hands[ev.p]).some((n) => n > 0);
      const moves = hasPiece ? legalMoves(b, ev.p) : [];
      if (ev.t === "pass") {
        expect(moves).toEqual([]);
      } else {
        const m = moves.find((x) => x.r === ev.r && x.c === ev.c);
        expect(m, `${ev.r},${ev.c} が合法手`).toBeDefined();
        expect(hands[ev.p][ev.kind]).toBeGreaterThan(0);
        const e = evaluate(b, m!.lines, ev.kind);
        expect([e.attack, e.heal, e.flipped.length]).toEqual([ev.attack, ev.heal, ev.n]);
        hands[ev.p][ev.kind]--;
        b = applyMove(b, ev.p, ev.r, ev.c, m!.lines, ev.kind);
      }
      expectedTurn = ev.p === 0 ? 1 : 0;
    }
    expect(dump(b)).toEqual(g.final_board);
  });

  it.each(games.map((g, i) => [i, g] as const))("局 %i: 対局進行（体力・パス・終局判定）が一致", (_, g) => {
    let s: GameState = createGame({ kaku: name === "kaku" });
    const pyPasses: Player[] = [];
    for (const ev of g.events) {
      if (s.result) break;
      if (ev.t === "pass") {
        pyPasses.push(ev.p);
        continue;
      }
      expect(s.turn).toBe(ev.p);
      s = playMove(s, ev.r, ev.c, ev.kind);
    }
    expect(s.result).not.toBeNull();
    // Python は終局時に両者のパスを 2 回記録するが、TS は記録せず終局する
    const tsPasses = s.history.filter((e) => e.type === "pass").map((e) => e.player);
    const pyMidPasses = g.ko_ply === null ? pyPasses.slice(0, -2) : pyPasses;
    expect(tsPasses).toEqual(pyMidPasses);
    expect(s.result!.winner ?? -1).toBe(g.winner);
    if (g.ko_ply !== null) {
      expect(s.result!.reason).toBe("ko");
      expect(s.ply).toBe(g.ko_ply);
    } else {
      expect(s.result!.reason).not.toBe("ko");
    }
    expect(s.hp).toEqual(g.end_hp);
    expect(dump(s.board)).toEqual(g.end_board);
  });

  it("2 手読みボットの最善スコアと同点候補が一致", () => {
    let checked = 0;
    for (const g of games) {
      if (!g.bots.includes("lookahead")) continue;
      let s: GameState = createGame({ kaku: name === "kaku" });
      for (const ev of g.events) {
        if (s.result) break;
        if (ev.t === "pass") continue;
        expect(s.turn).toBe(ev.p);
        if (ev.cands) {
          const { best, cands } = lookaheadCandidates(s);
          expect(best).toBe(ev.best);
          expect(cands.map((x) => key(x.r, x.c, x.kind)).sort()).toEqual(
            ev.cands.map(([r, c, k]) => key(r, c, k)).sort(),
          );
          checked++;
        }
        s = playMove(s, ev.r, ev.c, ev.kind);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
