// 決着の演出の中身のテスト: 勝ち・負け・引き分け × 決着の理由（体力 0・体力判定・石数・王の手）の副題、接戦の励ましの境界、2 人対戦

import { describe, expect, it } from "vitest";
import type { Board } from "../src/engine/board";
import { createGame, legalCells, playableKinds, playMove, type GameEvent, type GameResult, type GameState, type MoveEvent } from "../src/engine/game";
import type { Player } from "../src/engine/rules";
import { CLOSE_PERCENT, isClose, outcomeOf, type OutcomeView } from "../src/ui/outcome";
import { boardOf, rulesOf } from "./helpers";

const CPU0: OutcomeView = { mode: "cpu", human: 0 };
const CPU1: OutcomeView = { mode: "cpu", human: 1 };
const PVP: OutcomeView = { mode: "pvp", human: 0 };

/** 石数 先手 a・後手 b の盤（歩を左上から並べる） */
function discs(a: number, b: number): Board {
  const stones: Record<string, readonly [Player, number]> = {};
  for (let i = 0; i < a + b; i++) stones[`${String.fromCharCode(97 + (i % 8))}${Math.floor(i / 8) + 1}`] = [i < a ? 0 : 1, 1];
  return boardOf(stones);
}

function move(player: Player, patch: Partial<MoveEvent> = {}): MoveEvent {
  return { type: "move", ply: 10, player, r: 0, c: 0, kind: "fu", targets: [{ r: 0, c: 1, kind: "fu" }], damage: 3, heal: 0, ...patch };
}

/** 体力上限 maxHp（両者）・終局の体力 hp・結果 result の局面 */
function ended(
  result: GameResult,
  hp: [number, number],
  opts: { maxHp?: [number, number]; board?: Board; history?: GameEvent[] } = {},
): Pick<GameState, "rules" | "history" | "hp" | "board" | "result"> {
  return {
    rules: rulesOf("orig", { hp: opts.maxHp ?? [100, 100] }),
    history: opts.history ?? [move(result.winner ?? 0)],
    hp,
    board: opts.board ?? discs(10, 6),
    result,
  };
}

const KO = (winner: Player): GameResult => ({ winner, reason: "ko", byDiscs: false });
const LIMIT = (winner: Player | null, byDiscs = false): GameResult => ({ winner, reason: "limit", byDiscs });

describe("CPU 対戦: 勝ち・負けと決着の理由", () => {
  it("体力 0 で勝ち: 勝利・暖色・励ましなし", () => {
    const o = outcomeOf(ended(KO(0), [40, 0]), CPU0)!;
    expect(o).toMatchObject({ kind: "win", tone: "warm", title: "勝利！", subtitle: "体力 0 で撃破", cheer: null, urgeRematch: false, winner: null });
  });

  it("体力 0 で負け: 敗北・再戦を強調", () => {
    const o = outcomeOf(ended(KO(1), [0, 60]), CPU0)!;
    expect(o).toMatchObject({ kind: "lose", tone: "gloom", title: "敗北…", subtitle: "体力 0 で撃破された", cheer: null, urgeRematch: true });
  });

  it("体力判定で勝ち・負け（数字は自分 対 相手の順）", () => {
    expect(outcomeOf(ended(LIMIT(0), [30, 12]), CPU0)!.subtitle).toBe("体力判定で勝利（体力 30 対 12）");
    expect(outcomeOf(ended(LIMIT(0), [30, 12]), CPU1)).toMatchObject({ kind: "lose", subtitle: "体力判定で敗北（体力 12 対 30）" });
    // 両者打てずに終局（stalled）も同じ
    expect(outcomeOf(ended({ winner: 1, reason: "stalled", byDiscs: false }, [5, 9]), CPU1)!.subtitle).toBe("体力判定で勝利（体力 9 対 5）");
  });

  it("石数で勝ち・負け", () => {
    const g = ended(LIMIT(0, true), [20, 20], { board: discs(12, 9) });
    expect(outcomeOf(g, CPU0)).toMatchObject({ kind: "win", subtitle: "石数で勝利（体力は同じ・石 12 対 9）" });
    expect(outcomeOf(g, CPU1)).toMatchObject({ kind: "lose", subtitle: "石数で敗北（体力は同じ・石 9 対 12）", cheer: "惜しい！ 体力は互角、石の差はあと 3 個だった" });
  });

  it("王の即負けで決着: 王の文言", () => {
    const g = ended({ winner: 0, reason: "king", byDiscs: false }, [50, 50], { history: [move(0, { king: { r: 0, c: 1, kind: "fu", penalty: 0, lose: true } })] });
    expect(outcomeOf(g, CPU0)!.subtitle).toBe("王を討って勝利");
    expect(outcomeOf(g, CPU1)).toMatchObject({ kind: "lose", subtitle: "王を討たれて敗北", cheer: null });
  });

  it("王の罰を含む一手で体力 0: 体力 0 より王の文言を優先", () => {
    const king = move(1, { king: { r: 0, c: 1, kind: "fu", penalty: 20, lose: false } });
    const g = ended(KO(1), [-5, 3], { history: [king] });
    expect(outcomeOf(g, CPU1)!.subtitle).toBe("王を討って勝利");
    expect(outcomeOf(g, CPU0)!.subtitle).toBe("王を討たれて敗北");
    // 王を討たれた手のあと、別の手で体力 0 になったときは体力 0 の文言
    const later = ended(KO(1), [-5, 3], { history: [king, move(0, { ply: 11 }), move(1, { ply: 12 })] });
    expect(outcomeOf(later, CPU1)!.subtitle).toBe("体力 0 で撃破");
  });

  it("引き分け: 体力と石数", () => {
    const o = outcomeOf(ended(LIMIT(null), [20, 20], { board: discs(8, 8) }), CPU0)!;
    expect(o).toMatchObject({ kind: "draw", tone: "calm", title: "引き分け", subtitle: "体力も石数も同じ（体力 20・石 8）", cheer: null, urgeRematch: false });
  });

  it("終局していなければ null", () => {
    expect(outcomeOf(createGame(rulesOf("orig")), CPU0)).toBeNull();
  });
});

describe("接戦の励まし（自分の体力上限の 10% 以下・境界を含む）", () => {
  it("判定は整数で（小数の誤差なし）", () => {
    expect(CLOSE_PERCENT).toBe(10);
    expect(isClose(7, 70)).toBe(true);
    expect(isClose(8, 70)).toBe(false);
    expect(isClose(13, 130)).toBe(true);
    expect(isClose(14, 130)).toBe(false);
  });

  it.each([
    [10, "惜しい！ 相手の体力はあと 10 だった"],
    [11, null],
    [1, "惜しい！ 相手の体力はあと 1 だった"],
  ] as const)("体力 0 で負け・相手の残り %i（自分の上限 100）", (left, cheer) => {
    expect(outcomeOf(ended(KO(1), [0, left]), CPU0)!.cheer).toBe(cheer);
  });

  it("体力 0 の励ましは自分の体力上限で測る（相手の上限ではない）", () => {
    // 自分（先手）の上限 40・相手の上限 200: 相手の残り 4 は 10% 以下、5 は超える
    expect(outcomeOf(ended(KO(1), [0, 4], { maxHp: [40, 200] }), CPU0)!.cheer).toBe("惜しい！ 相手の体力はあと 4 だった");
    expect(outcomeOf(ended(KO(1), [0, 5], { maxHp: [40, 200] }), CPU0)!.cheer).toBeNull();
  });

  it.each([
    [[30, 40], "惜しい！ あと 10 点だった"],
    [[29, 40], null],
    [[39, 40], "惜しい！ あと 1 点だった"],
  ] as const)("体力判定で負け %j（自分の上限 100）", (hp, cheer) => {
    expect(outcomeOf(ended(LIMIT(1), [...hp]), CPU0)!.cheer).toBe(cheer);
  });

  it("勝ったとき・引き分けには励ましを出さない", () => {
    expect(outcomeOf(ended(LIMIT(0), [40, 39]), CPU0)!.cheer).toBeNull();
    expect(outcomeOf(ended(KO(0), [1, 0]), CPU0)!.cheer).toBeNull();
    expect(outcomeOf(ended(LIMIT(null), [20, 20], { board: discs(8, 8) }), CPU0)!.cheer).toBeNull();
  });
});

describe("2 人対戦: 敗北の演出にならない", () => {
  it.each([
    [KO(0), "先手の勝ち！", "black", "後手の体力を 0 にして撃破"],
    [KO(1), "後手の勝ち！", "white", "先手の体力を 0 にして撃破"],
    [LIMIT(1), "後手の勝ち！", "white", "体力判定で決着（先手 20 対 後手 25）"],
  ] as const)("%j → %s", (result, title, tone, subtitle) => {
    const o = outcomeOf(ended(result, [20, 25]), PVP)!;
    expect(o).toMatchObject({ kind: "win", title, tone, subtitle, winner: result.winner, cheer: null, urgeRematch: false });
  });

  it("human の値に関係なく、どちらが勝っても勝利の演出", () => {
    for (const human of [0, 1] as const) {
      for (const w of [0, 1] as const) expect(outcomeOf(ended(KO(w), [10, 10]), { mode: "pvp", human })!.kind).toBe("win");
    }
  });

  it("石数・王・引き分け", () => {
    expect(outcomeOf(ended(LIMIT(0, true), [20, 20], { board: discs(12, 9) }), PVP)!.subtitle).toBe("体力が同じ — 石数で決着（先手 12 対 後手 9）");
    const king = ended({ winner: 1, reason: "king", byDiscs: false }, [50, 50], { history: [move(1, { king: { r: 0, c: 1, kind: "fu", penalty: 0, lose: true } })] });
    expect(outcomeOf(king, PVP)!.subtitle).toBe("後手が先手の王を討って決着");
    expect(outcomeOf(ended(LIMIT(null), [20, 20], { board: discs(8, 8) }), PVP)!.kind).toBe("draw");
  });
});

describe("エンジンの実際の終局から作る", () => {
  it("体力 5 の後手を先手が倒す（両者とも最初に見つかる合法手）", () => {
    let g = createGame(rulesOf("orig", { hp: [200, 5] }));
    while (!g.result) {
      const kind = playableKinds(g)[0];
      const [r, c] = legalCells(g, kind)[0];
      g = playMove(g, r, c, kind);
    }
    expect(g.result).toEqual(KO(0));
    expect(outcomeOf(g, CPU0)).toMatchObject({ kind: "win", subtitle: "体力 0 で撃破" });
    expect(outcomeOf(g, CPU1)).toMatchObject({ kind: "lose", subtitle: "体力 0 で撃破された", urgeRematch: true });
    expect(outcomeOf(g, PVP)).toMatchObject({ kind: "win", title: "先手の勝ち！" });
  });
});
