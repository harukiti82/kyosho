// 待った（ui/undo.ts）: 人間が打つ前の局面に戻す・回数・押せないとき・王の指定と罰・パス・CPU が先手

import { describe, expect, it } from "vitest";
import { chooseMove } from "../src/engine/cpu";
import { createGame, kingInfo, playMove, randomMove, viewFor, type GameState } from "../src/engine/game";
import { presetById, type Player } from "../src/engine/rules";
import { Undo, UNDO_LIMIT } from "../src/ui/undo";

/** 種付き乱数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const std = () => presetById("std").rules;

/**
 * 画面の流れ（App.advance）と同じく、打つ前に undo.record してから 1 手進める。
 * 人間は乱数で置ける手から選ぶ（designate なら最初の手で王にする）。CPU はイージー
 */
function step(g: GameState, human: Player, undo: Undo, rand: () => number, designate = false): GameState {
  undo.record(g, human);
  if (g.turn === human) {
    const m = randomMove(g, rand)!;
    return playMove(g, m.r, m.c, m.kind, { king: designate && kingInfo(g, human).canDesignate });
  }
  const ch = chooseMove(viewFor(g, g.turn), "easy", rand)!;
  return playMove(g, ch.r, ch.c, ch.kind, { king: ch.king });
}

/** 人間の手番まで進める（CPU の手は続けて打つ） */
function toHumanTurn(g: GameState, human: Player, undo: Undo, rand: () => number): GameState {
  while (!g.result && g.turn !== human) g = step(g, human, undo, rand);
  return g;
}

describe("待った", () => {
  it("自分の直前の手と CPU の応手をまとめて戻し、盤・体力・持ち駒・王・棋譜が手の前と同じになる。回数は 3 回まで", () => {
    const rand = rng(1);
    const undo = new Undo();
    let g = createGame(std());
    const before: GameState[] = [];
    for (let i = 0; i < 4; i++) {
      before.push(g);
      g = toHumanTurn(step(g, 0, undo, rand), 0, undo, rand);
    }
    expect(undo.left).toBe(UNDO_LIMIT);
    for (let i = 0; i < UNDO_LIMIT; i++) {
      expect(undo.canUndo(g, 0)).toBe(true);
      const back = undo.undo(g, 0)!;
      const want = before.pop()!;
      expect(back).toBe(want);
      expect(back.board).toEqual(want.board);
      expect(back.hp).toEqual(want.hp);
      expect(back.hands).toEqual(want.hands);
      expect(back.kings).toEqual(want.kings);
      expect(back.history).toEqual(want.history);
      expect(back.turn).toBe(0);
      expect(undo.left).toBe(UNDO_LIMIT - 1 - i);
      g = back;
    }
    // 使い切ったら押せない（戻る局面が残っていても）
    expect(undo.canUndo(g, 0)).toBe(false);
    expect(undo.undo(g, 0)).toBeNull();
    expect(g.ply).toBe(2);
  });

  it("CPU の手番・終局後・まだ 1 手も打っていないときは押せない", () => {
    const rand = rng(2);
    const undo = new Undo();
    let g = createGame(std());
    expect(undo.canUndo(g, 0)).toBe(false);
    g = step(g, 0, undo, rand);
    expect(g.turn).toBe(1);
    expect(undo.canUndo(g, 0)).toBe(false);
    // 終局まで打つ
    while (!g.result) g = step(g, 0, undo, rand);
    expect(undo.canUndo(g, 0)).toBe(false);
    expect(undo.left).toBe(UNDO_LIMIT);
  });

  it("CPU が先手なら、CPU の初手は戻さない", () => {
    const rand = rng(3);
    const undo = new Undo();
    let g = toHumanTurn(createGame(std()), 1, undo, rand);
    expect(g.ply).toBe(1);
    const first = g;
    g = toHumanTurn(step(g, 1, undo, rand), 1, undo, rand);
    const back = undo.undo(g, 1)!;
    expect(back).toBe(first);
    expect(back.ply).toBe(1);
    // CPU の初手の前には戻らない
    expect(undo.canUndo(back, 1)).toBe(false);
  });

  it("王を指定した手を戻すと、王の指定と期限の数え方も手の前に戻る", () => {
    const rand = rng(4);
    const undo = new Undo();
    const g0 = createGame(std());
    const g1 = toHumanTurn(step(g0, 0, undo, rand, true), 0, undo, rand);
    expect(kingInfo(g1, 0).cell).not.toBeNull();
    expect(kingInfo(g1, 0).canDesignate).toBe(false);
    const back = undo.undo(g1, 0)!;
    const ki = kingInfo(back, 0);
    expect(ki.cell).toBeNull();
    expect(ki.canDesignate).toBe(true);
    expect(ki.nextMove).toBe(1);
    expect(back.kings).toEqual(g0.kings);
  });

  it("王を返された手を戻すと、王の罰の体力も王の公開も戻る", () => {
    // 人間が王を指定し、CPU に王を返される局面を種で探す
    for (let seed = 1; seed < 400; seed++) {
      const rand = rng(seed);
      const undo = new Undo(99);
      let g = createGame(std());
      while (!g.result) {
        const before = g;
        const next = toHumanTurn(step(g, 0, undo, rand, true), 0, undo, rand);
        const hit = next.history.slice(before.history.length).find((e) => e.type === "move" && e.player === 1 && e.king);
        if (hit && !next.result) {
          expect(next.kings[0].revealed).toBe(true);
          const back = undo.undo(next, 0)!;
          expect(back).toBe(before);
          expect(back.hp).toEqual(before.hp);
          expect(back.kings[0].revealed).toBe(false);
          expect(kingInfo(back, 0).status).not.toBe("revealed");
          return;
        }
        g = next;
      }
    }
    throw new Error("王を返される局面が見つからない");
  });

  it("CPU がパスした後でも、自分の直前の手の前に戻る", () => {
    for (let seed = 1; seed < 400; seed++) {
      const rand = rng(seed);
      const undo = new Undo(99);
      let g = createGame(std());
      while (!g.result) {
        const before = g;
        const next = toHumanTurn(step(g, 0, undo, rand), 0, undo, rand);
        const passed = next.history.slice(before.history.length).some((e) => e.type === "pass" && e.player === 1);
        if (passed && !next.result) {
          const back = undo.undo(next, 0)!;
          expect(back).toBe(before);
          expect(back.history).toEqual(before.history);
          expect(back.turn).toBe(0);
          return;
        }
        g = next;
      }
    }
    throw new Error("CPU がパスする局面が見つからない");
  });
});
