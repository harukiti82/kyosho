// CPU の強さ（イージー / ノーマル / ハード）: ノーマルは従来の 2 手読みと同じ手、どの強さも合法手だけを打つ、
// 対戦させると ハード > ノーマル > イージー の順に勝つ、ハードは決着の手を逃さない

import { describe, expect, it } from "vitest";
import { chooseLookahead, chooseMove, CPU_LEVELS, type CpuLevel } from "../src/engine/cpu";
import { createGame, isLegal, kingInfo, playMove, viewFor, type GameState } from "../src/engine/game";
import { cloneRules, presetById, type Player, type PresetId } from "../src/engine/rules";
import { boardOf, stateOf } from "./helpers";

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

/** 強さ a と b を games 局対戦させた a の勝ち数（偶数局は a が先手。局 i は種 i + 1） */
function wins(preset: PresetId, a: CpuLevel, b: CpuLevel, games: number): number {
  let n = 0;
  for (let i = 0; i < games; i++) {
    const rand = rng(i + 1);
    const levelOf = (p: Player): CpuLevel => ((p === 0) === (i % 2 === 0) ? a : b);
    let s: GameState = createGame(presetById(preset).rules);
    while (!s.result) {
      const ch = chooseMove(viewFor(s, s.turn), levelOf(s.turn), rand)!;
      s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
    }
    if (s.result.winner !== null && levelOf(s.result.winner) === a) n++;
  }
  return n;
}

describe("CPU の強さ", () => {
  it("ノーマルは従来の 2 手読み（chooseLookahead）と同じ乱数で同じ手", () => {
    for (const preset of ["std", "v10", "king"] as PresetId[]) {
      const [ra, rb] = [rng(5), rng(5)];
      let s = createGame(presetById(preset).rules);
      for (let ply = 0; ply < 30 && !s.result; ply++) {
        const a = chooseMove(viewFor(s, s.turn), "normal", ra);
        const b = chooseLookahead(viewFor(s, s.turn), rb);
        expect(a).toEqual(b);
        s = playMove(s, a!.r, a!.c, a!.kind, { king: a!.king });
      }
    }
  });

  it("どの強さも合法手だけを打ち、隠し王は期限までに必ず決める", () => {
    for (const level of CPU_LEVELS) {
      for (const preset of ["std", "v10", "v04", "v2"] as PresetId[]) {
        const rand = rng(11);
        let s = createGame(presetById(preset).rules);
        while (!s.result) {
          const p = s.turn;
          const ch = chooseMove(viewFor(s, p), level, rand)!;
          expect(isLegal(s, ch.r, ch.c, ch.kind)).toBe(true);
          s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
          const k = kingInfo(s, p);
          if (s.rules.king.on && k.nextMove > s.rules.king.deadline) expect(k.status).not.toBe("unset");
        }
      }
    }
  });

  it("打てる手がなければ null", () => {
    const s = stateOf(boardOf({ c1: [0, 1] }), { hands: [{}, { fu: 1 }] });
    for (const level of CPU_LEVELS) expect(chooseMove(viewFor(s, 0), level)).toBeNull();
  });

  it("対戦させると ハード > ノーマル > イージー（標準・30 局ずつ、先手・後手を入れ替え）", () => {
    // npm run balance -- vs 400 std の結果: ノーマル対イージー 87.5%、ハード対ノーマル 67.0%
    expect(wins("std", "normal", "easy", 30)).toBeGreaterThanOrEqual(22);
    expect(wins("std", "hard", "normal", 30)).toBeGreaterThanOrEqual(18);
  });

  it("ハードは相手の体力を削り切る手があれば必ず打つ", () => {
    // 後手の体力 1: 1 枚でも取れば勝ち。ハードはどの種でも取って勝つ
    const rules = { ...cloneRules(presetById("v10").rules), hp: [50, 1] as [number, number] };
    for (let seed = 1; seed <= 20; seed++) {
      const s0 = createGame(rules);
      const ch = chooseMove(viewFor(s0, 0), "hard", rng(seed))!;
      const s1 = playMove(s0, ch.r, ch.c, ch.kind, { king: ch.king });
      expect(s1.result?.winner).toBe(0);
    }
  });
});
