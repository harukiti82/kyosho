// sim/capture.py（Python エンジン、RULES.md v1.0）との整合テスト。
// fixtures/replays.json は `python3 sim/export_replays.py` で生成する。

import { describe, expect, it } from "vitest";
import { applyMove, capturesAt, damageOf, emptyCells, newBoard, type Board } from "../src/engine/board";
import { lookaheadCandidates } from "../src/engine/cpu";
import { availableKinds, createGame, playMove, type GameState } from "../src/engine/game";
import { INITIAL_HAND, INITIAL_HP, KIND_ORDER, MAX_PLIES, PIECES, type Hand, type PieceKind, type Player } from "../src/engine/rules";
import replays from "./fixtures/replays.json";

type PyEvent =
  | { t: "pass"; p: Player }
  | {
      t: "move";
      p: Player;
      r: number;
      c: number;
      kind: PieceKind;
      cap: [number, number][];
      dmg: number;
      /** 着手後の盤面（64 文字。空き '.'、先手 a/c/e、後手 A/C/E = 1/3/5） */
      board: string;
      /** 着手後の持ち駒 [[歩, 金, 飛], [歩, 金, 飛]] */
      hands: [number[], number[]];
      best?: number;
      /** 2 手読みの同点候補。"行 列 数字" の 3 文字を連結 */
      cands?: string;
    };
interface PyGame {
  bots: string[];
  events: PyEvent[];
  plies: number;
  winner: -1 | 0 | 1;
  ko_ply: number | null;
  end_hp: [number, number];
}
const data = replays as unknown as { hp: number; max_plies: number; games: PyGame[] };
const games = data.games;

const CH: Record<number, string> = { 1: "a", 3: "c", 5: "e" };
const dump = (b: Board) =>
  b.flat().map((s) => (s ? (s.owner === 0 ? CH[PIECES[s.kind].value] : CH[PIECES[s.kind].value].toUpperCase()) : ".")).join("");
const dumpHands = (hs: Hand[]) => hs.map((h) => KIND_ORDER.map((k) => h[k]));
const choiceKey = (r: number, c: number, k: PieceKind) => `${r}${c}${PIECES[k].value}`;
const splitCands = (s: string) => (s.match(/.{3}/g) ?? []).sort();

describe("Python エンジン（sim/capture.py）との整合", () => {
  it("ルール定数と棋譜の量・種類", () => {
    expect([data.hp, data.max_plies]).toEqual([INITIAL_HP, MAX_PLIES]);
    expect(games.length).toBeGreaterThanOrEqual(40);
    const bots = new Set(games.flatMap((g) => g.bots));
    expect([...bots].sort()).toEqual(["greedy", "lookahead", "random"]);
    // 体力 0 決着・持ち駒切れ（両者パス）決着・引き分け・途中のパスを含む
    expect(games.some((g) => g.ko_ply !== null)).toBe(true);
    expect(games.some((g) => g.ko_ply === null)).toBe(true);
    expect(games.some((g) => g.winner === -1)).toBe(true);
    expect(games.some((g) => g.events.some((e) => e.t === "pass"))).toBe(true);
  });

  it.each(games.map((g, i) => [i, g.bots.join(" vs "), g] as const))(
    "局 %i（%s）: 全手の取った駒・ダメージ・盤面・持ち駒が一致",
    (_, __, g) => {
      // 体力を見ない低レベル再生（Python の play() と同じく打ち切りまで）
      let b = newBoard();
      const hands: Hand[] = [{ ...INITIAL_HAND }, { ...INITIAL_HAND }];
      let expectedTurn: Player = 0;
      let ply = 0;
      for (const ev of g.events) {
        expect(ev.p).toBe(expectedTurn);
        const canMove = availableKinds(hands[ev.p]).length > 0 && emptyCells(b).length > 0;
        if (ev.t === "pass") {
          expect(canMove).toBe(false);
        } else {
          expect(canMove).toBe(true);
          expect(b[ev.r][ev.c]).toBeNull();
          expect(hands[ev.p][ev.kind]).toBeGreaterThan(0);
          const cap = capturesAt(b, ev.r, ev.c, ev.p);
          expect(cap.map(([y, x]) => [y, x])).toEqual(ev.cap);
          expect(damageOf(b, cap)).toBe(ev.dmg);
          const res = applyMove(b, ev.p, ev.r, ev.c, ev.kind);
          hands[ev.p][ev.kind]--;
          for (const k of res.capturedKinds) hands[ev.p][k]++;
          b = res.board;
          expect(dump(b)).toBe(ev.board);
          expect(dumpHands(hands)).toEqual(ev.hands);
          ply++;
        }
        expectedTurn = ev.p === 0 ? 1 : 0;
      }
      expect(ply).toBe(g.plies);
      // 終わり方: 手数上限か、両者が続けてパス
      const last2 = g.events.slice(-2).map((e) => e.t);
      expect(ply === MAX_PLIES || (last2[0] === "pass" && last2[1] === "pass")).toBe(true);
    },
  );

  it.each(games.map((g, i) => [i, g.bots.join(" vs "), g] as const))(
    "局 %i（%s）: 対局進行（体力・パス・終局判定）が一致",
    (_, __, g) => {
      let s: GameState = createGame();
      const pyPasses: Player[] = [];
      for (const ev of g.events) {
        if (s.result) break;
        if (ev.t === "pass") {
          pyPasses.push(ev.p);
          continue;
        }
        expect(s.turn).toBe(ev.p);
        s = playMove(s, ev.r, ev.c, ev.kind);
        const last = s.history.at(-1)?.type === "move" ? s.history.at(-1) : s.history.at(-2);
        expect(last?.type === "move" && last.captured.map((x) => [x.r, x.c])).toEqual(ev.cap);
        expect(last?.type === "move" && last.damage).toBe(ev.dmg);
        expect(dump(s.board)).toBe(ev.board);
        expect(dumpHands(s.hands)).toEqual(ev.hands);
      }
      expect(s.result).not.toBeNull();
      // 終局までのパスが一致する。Python が終局時に記録する両者のパス 2 回は、
      // TS が終局した後のイベントなので pyPasses に入らない（TS は記録せず終局する）
      const tsPasses = s.history.filter((e) => e.type === "pass").map((e) => e.player);
      expect(tsPasses).toEqual(pyPasses);
      expect(s.result!.winner ?? -1).toBe(g.winner);
      if (g.ko_ply !== null) {
        expect(s.result!.reason).toBe("ko");
        expect(s.ply).toBe(g.ko_ply);
      } else {
        expect(s.result!.reason).toBe(g.plies === MAX_PLIES ? "limit" : "stalled");
        expect(s.ply).toBe(g.plies);
      }
      expect(s.hp).toEqual(g.end_hp);
    },
  );

  it("2 手読みボットの最善スコアと同点候補が一致", () => {
    let checked = 0;
    for (const g of games) {
      if (!g.bots.includes("lookahead")) continue;
      let s: GameState = createGame();
      for (const ev of g.events) {
        if (s.result) break;
        if (ev.t === "pass") continue;
        expect(s.turn).toBe(ev.p);
        if (ev.cands !== undefined) {
          const { best, cands } = lookaheadCandidates(s);
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
