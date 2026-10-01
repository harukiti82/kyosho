// sim/kyosho.py（v0.4）・sim/capture.py（v1.0）・sim/gate.py（v2 案）との整合テスト。
// 各プリセットの設定で Python の棋譜を再生し、全手の結果が一致することを確かめる。
// fixtures/replays.json は `python3 sim/export_replays.py` で生成する。

import { describe, expect, it } from "vitest";
import type { Board } from "../src/engine/board";
import { lookaheadCandidates } from "../src/engine/cpu";
import { createGame, lastMoveOf, playMove, viewFor, type GameState } from "../src/engine/game";
import { KIND_ORDER, PIECES, presetById, type Hand, type PieceKind, type Player, type PresetId } from "../src/engine/rules";
import replays from "./fixtures/replays.json";

type PyEvent =
  | { t: "pass"; p: Player }
  | {
      t: "move";
      p: Player;
      r: number;
      c: number;
      kind: PieceKind;
      /** 返した（取った）駒。方向順・置いたマスに近い順 */
      cells: [number, number][];
      dmg: number;
      heal: number;
      /** 着手後の盤面（64 文字。空き '.'、先手 a/b/c/e = 1/2/3/5、後手は大文字） */
      board: string;
      /** 着手後の持ち駒 [[歩, 銀, 金, 飛], [歩, 銀, 金, 飛]] */
      hands: [number[], number[]];
      best?: number;
      /** 2 手読みの同点候補。"行 列 数字" の 3 文字を連結 */
      cands?: string;
    };
interface PyGame {
  bots: string[];
  events: PyEvent[];
  plies: number;
  /** Python の判定。-1 は引き分け（v1.0・v2 案のシミュレーターは体力が同じなら引き分け） */
  winner: -1 | 0 | 1;
  ko_ply: number | null;
  end_hp: [number, number];
  /** 最終盤面の石数 */
  discs: [number, number];
}
interface PySet {
  preset: PresetId;
  hp: [number, number];
  hand: number[];
  max_plies: number;
  games: PyGame[];
}
const sets = (replays as unknown as { sets: PySet[] }).sets;

const CH: Record<number, string> = { 1: "a", 2: "b", 3: "c", 5: "e" };
const dump = (b: Board) =>
  b.flat().map((s) => (s ? (s.owner === 0 ? CH[PIECES[s.kind].value] : CH[PIECES[s.kind].value].toUpperCase()) : ".")).join("");
const dumpHands = (hs: Hand[]) => hs.map((h) => KIND_ORDER.map((k) => h[k]));
const choiceKey = (r: number, c: number, k: PieceKind) => `${r}${c}${PIECES[k].value}`;
const splitCands = (s: string) => (s.match(/.{3}/g) ?? []).sort();
const lastMove = (s: GameState) => lastMoveOf(s)!;

/** Python の勝者。体力が同じで引き分けにした局は、Web 版の規則（石数の多い方の勝ち）に読み替える */
function expectedWinner(g: PyGame): -1 | 0 | 1 {
  if (g.winner !== -1 || g.ko_ply !== null) return g.winner;
  const [a, b] = g.discs;
  return a === b ? -1 : a > b ? 0 : 1;
}

describe.each(sets.map((s) => [s.preset, s] as const))("Python との整合: %s", (preset, set) => {
  const rules = presetById(preset).rules;
  const games = set.games;

  it("プリセットとシミュレーターの設定・棋譜の量と種類", () => {
    expect(rules.hp).toEqual(set.hp);
    expect(KIND_ORDER.map((k) => rules.hand[k])).toEqual(set.hand);
    expect(rules.maxPlies).toBe(set.max_plies);
    expect(games.length).toBeGreaterThanOrEqual(20);
    expect(games.flatMap((g) => g.bots)).toContain("lookahead");
    // 体力 0 決着・それ以外の決着・途中のパスを含む
    expect(games.some((g) => g.ko_ply !== null)).toBe(true);
    expect(games.some((g) => g.ko_ply === null)).toBe(true);
    expect(games.some((g) => g.events.slice(0, -2).some((e) => e.t === "pass"))).toBe(true);
  });

  it.each(games.map((g, i) => [i, g.bots.join(" vs "), g] as const))(
    "局 %i（%s）: 全手の返した駒・ダメージ・回復・盤面・持ち駒・パスが一致",
    (_, __, g) => {
      // 体力で止めずに Python の play() と同じく最後まで再生する
      let s = createGame({ ...rules, hp: [1e9, 1e9] });
      const pyPasses: Player[] = [];
      for (const ev of g.events) {
        if (s.result) break;
        if (ev.t === "pass") {
          pyPasses.push(ev.p);
          continue;
        }
        expect(s.turn).toBe(ev.p);
        s = playMove(s, ev.r, ev.c, ev.kind);
        const m = lastMove(s);
        expect(m.targets.map((x) => [x.r, x.c])).toEqual(ev.cells);
        expect([m.damage, m.heal]).toEqual([ev.dmg, ev.heal]);
        expect(dump(s.board)).toBe(ev.board);
        expect(dumpHands(s.hands)).toEqual(ev.hands);
      }
      expect(s.result).not.toBeNull();
      expect(s.ply).toBe(g.plies);
      // 終局時の両者のパス 2 回は、TS では記録せずに終局する（TS が終局した後のイベントなので pyPasses に入らない）
      const tail = g.events.slice(-2).map((e) => e.t);
      const ended = tail[0] === "pass" && tail[1] === "pass";
      expect(s.history.filter((e) => e.type === "pass").map((e) => e.player)).toEqual(pyPasses);
      expect(s.result!.reason).toBe(ended ? "stalled" : "limit");
    },
  );

  it.each(games.map((g, i) => [i, g.bots.join(" vs "), g] as const))(
    "局 %i（%s）: 体力・終局判定が一致",
    (_, __, g) => {
      let s = createGame(rules);
      for (const ev of g.events) {
        if (s.result) break;
        if (ev.t === "move") s = playMove(s, ev.r, ev.c, ev.kind);
      }
      expect(s.result).not.toBeNull();
      expect(s.result!.winner ?? -1).toBe(expectedWinner(g));
      if (g.ko_ply !== null) {
        expect(s.result!.reason).toBe("ko");
        expect(s.ply).toBe(g.ko_ply);
      } else {
        expect(s.result!.reason).not.toBe("ko");
        expect(s.ply).toBe(g.plies);
        expect(s.result!.byDiscs).toBe(g.end_hp[0] === g.end_hp[1] && g.discs[0] !== g.discs[1]);
      }
      expect(s.hp).toEqual(g.end_hp);
    },
  );

  it("2 手読みボットの最善スコアと同点候補が一致", () => {
    let checked = 0;
    for (const g of games) {
      let s = createGame({ ...rules, hp: [1e9, 1e9] });
      for (const ev of g.events) {
        if (s.result) break;
        if (ev.t === "pass") continue;
        if (ev.cands !== undefined) {
          const { best, cands } = lookaheadCandidates(viewFor(s, s.turn));
          expect(best).toBe(ev.best);
          expect(cands.map((x) => choiceKey(x.r, x.c, x.kind)).sort()).toEqual(splitCands(ev.cands));
          // Python が実際に選んだ手も候補に入っている
          expect(splitCands(ev.cands)).toContain(choiceKey(ev.r, ev.c, ev.kind));
          checked++;
        }
        s = playMove(s, ev.r, ev.c, ev.kind);
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});
