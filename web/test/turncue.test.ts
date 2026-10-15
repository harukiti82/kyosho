import { describe, expect, it } from "vitest";
import { createGame, playMove, randomMove, type GameState } from "../src/engine/game";
import { isNewTurn, TurnWatch, turnCueMs, TURN_CUE_MS, TURN_CUE_REDUCED_MS, type TurnPoint } from "../src/ui/turncue";
import { rulesOf } from "./helpers";

const pt = (o: Partial<TurnPoint> = {}): TurnPoint => ({ game: 1, ply: 0, turn: 0, second: false, over: false, ...o });
const pointOf = (g: GameState, game = 1): TurnPoint => ({ game, ply: g.ply, turn: g.turn, second: !!g.skills?.second, over: !!g.result });

describe("isNewTurn", () => {
  it("最初に見た局面・別の対局・手番の人が替わったら新しい手番", () => {
    expect(isNewTurn(null, pt())).toBe(true);
    expect(isNewTurn(pt({ game: 1 }), pt({ game: 2 }))).toBe(true);
    expect(isNewTurn(pt({ turn: 0, ply: 0 }), pt({ turn: 1, ply: 1 }))).toBe(true);
  });

  it("相手がパスして同じ人が続けて打つ（手数だけ進む）のも新しい手番", () => {
    expect(isNewTurn(pt({ turn: 0, ply: 4 }), pt({ turn: 0, ply: 5 }))).toBe(true);
  });

  it("連続行動の 2 手目・同じ局面の描き直し・スキルを使っただけは同じ手番", () => {
    expect(isNewTurn(pt({ turn: 0, ply: 4 }), pt({ turn: 0, ply: 5, second: true }))).toBe(false);
    expect(isNewTurn(pt({ turn: 0, ply: 4 }), pt({ turn: 0, ply: 4 }))).toBe(false);
  });

  it("待った・巻き戻しで手数が戻っても同じ手番", () => {
    expect(isNewTurn(pt({ turn: 0, ply: 6 }), pt({ turn: 0, ply: 4 }))).toBe(false);
  });
});

describe("TurnWatch", () => {
  it("知らせる人の新しい手番は、出せるようになった 1 回だけ出す", () => {
    const w = new TurnWatch();
    w.see(pt(), true);
    // 演出・抽選の間は待つ
    expect(w.take(false)).toBe(false);
    expect(w.take(false)).toBe(false);
    expect(w.take(true)).toBe(true);
    // 同じ手番では 2 回出さない
    w.see(pt(), true);
    expect(w.take(true)).toBe(false);
  });

  it("知らせない人（CPU・オンラインの相手・遊び方のステップ）の手番では出さない", () => {
    const w = new TurnWatch();
    expect(w.see(pt({ turn: 1 }), false)).toBe(true);
    expect(w.take(true)).toBe(false);
    // 相手が打ち終えて自分の番
    w.see(pt({ turn: 0, ply: 1 }), true);
    expect(w.take(true)).toBe(true);
  });

  it("出せないうちに手番が終わったら、その分は出さない", () => {
    const w = new TurnWatch();
    w.see(pt({ turn: 0 }), true);
    w.see(pt({ turn: 1, ply: 1 }), false);
    expect(w.take(true)).toBe(false);
  });

  it("終局した局面では出さない", () => {
    const w = new TurnWatch();
    w.see(pt({ turn: 0, ply: 3, over: true }), true);
    expect(w.take(true)).toBe(false);
  });

  it("hush の後に見た局面で始まっていた手番は出さず、次の手番からまた出す", () => {
    const w = new TurnWatch();
    w.hush();
    w.see(pt({ turn: 0, ply: 8 }), true);
    expect(w.take(true)).toBe(false);
    w.see(pt({ turn: 1, ply: 9 }), false);
    w.see(pt({ turn: 0, ply: 10 }), true);
    expect(w.take(true)).toBe(true);
  });

  it("hush の後に見た局面が同じ手番の続きなら、出す予定はそのまま", () => {
    const w = new TurnWatch();
    w.see(pt({ turn: 0, ply: 2 }), true);
    w.hush();
    w.see(pt({ turn: 0, ply: 2 }), true);
    expect(w.take(true)).toBe(true);
  });

  it("reset で前の対局の手番を忘れる", () => {
    const w = new TurnWatch();
    w.see(pt(), true);
    expect(w.take(true)).toBe(true);
    w.reset();
    w.see(pt(), true);
    expect(w.take(true)).toBe(true);
  });

  it("エンジンの局面: 打つたびに手番が替わり、2 人対戦は毎手、CPU 対戦は自分の番だけ出す", () => {
    let g = createGame(rulesOf("std"));
    const pvp = new TurnWatch();
    const cpu = new TurnWatch();
    const shown: [number[], number[]] = [[], []];
    for (let i = 0; i < 6; i++) {
      pvp.see(pointOf(g), true);
      cpu.see(pointOf(g), g.turn === 0);
      if (pvp.take(true)) shown[0].push(g.ply);
      if (cpu.take(true)) shown[1].push(g.ply);
      const m = randomMove(g, () => 0)!;
      g = playMove(g, m.r, m.c, m.kind);
    }
    expect(shown[0]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(shown[1]).toEqual([0, 2, 4]);
  });
});

describe("turnCueMs", () => {
  it("動きを減らす設定では短く、どちらも 1.5 秒以内", () => {
    expect(turnCueMs(false)).toBe(TURN_CUE_MS);
    expect(turnCueMs(true)).toBe(TURN_CUE_REDUCED_MS);
    expect(TURN_CUE_REDUCED_MS).toBeLessThan(TURN_CUE_MS);
    expect(TURN_CUE_MS).toBeLessThanOrEqual(1500);
  });
});
