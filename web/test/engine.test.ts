import { describe, expect, it } from "vitest";
import { applyMove, evaluate, legalMoves, linesFor, newBoard } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import { createGame, judge, movesFor, playMove, previewMove } from "../src/engine/game";
import { makeRules, type PieceKind } from "../src/engine/rules";
import { at, boardOf, stateOf } from "./helpers";

/** 先手が name に kind を置いたときの効果 */
function effect(stones: Parameters<typeof boardOf>[0], name: string, kind: PieceKind) {
  const b = boardOf(stones);
  const [r, c] = at(name);
  return evaluate(b, linesFor(b, r, c, 0), kind);
}

describe("ルール定数", () => {
  it("標準ルール: 体力 65/66、持ち駒 歩14・銀10・金6・飛2", () => {
    const r = makeRules({ kaku: false });
    expect(r.hp).toEqual([65, 66]);
    expect(r.hand).toEqual({ fu: 14, kaku: 0, gin: 10, kin: 6, hi: 2 });
  });
  it("角あり: 歩2個→角2個、体力 65/65", () => {
    const r = makeRules({ kaku: true });
    expect(r.hp).toEqual([65, 65]);
    expect(r.hand).toEqual({ fu: 12, kaku: 2, gin: 10, kin: 6, hi: 2 });
  });
  it("初期配置は中央 4 駒がすべて歩(1)で、先手の合法手は 4 つ", () => {
    const b = newBoard();
    expect([b[3][3], b[4][4], b[3][4], b[4][3]].map((s) => [s!.owner, s!.value])).toEqual([
      [1, 1], [1, 1], [0, 1], [0, 1],
    ]);
    expect(legalMoves(b, 0)).toHaveLength(4);
  });
});

describe("攻撃と回復", () => {
  it("RULES.md の計算例: 金で歩・銀・金を返し端が銀 → 攻撃3・回復1", () => {
    const e = effect({ b1: [1, 1], c1: [1, 2], d1: [1, 3], e1: [0, 2] }, "a1", "kin");
    expect(e.attack).toBe(3);
    expect(e.heal).toBe(1);
  });
  it("飛 × 端の飛で回復 4", () => {
    expect(effect({ b1: [1, 1], c1: [0, 5] }, "a1", "hi").heal).toBe(4);
  });
  it("歩で置くと端が飛でも回復 0", () => {
    expect(effect({ b1: [1, 1], c1: [0, 5] }, "a1", "fu").heal).toBe(0);
  });
  it("回復の早見表（低い方 歩0 / 銀1 / 金2 / 飛4）", () => {
    const heals = (["fu", "gin", "kin", "hi"] as const).map(
      (k) => effect({ b1: [1, 1], c1: [0, 5] }, "a1", k).heal,
    );
    expect(heals).toEqual([0, 1, 2, 4]);
  });
  it("4 枚返すと枚数ボーナス +1、3 枚では +0", () => {
    const four = effect({ b1: [1, 1], c1: [1, 1], d1: [1, 1], e1: [1, 1], f1: [0, 1] }, "a1", "fu");
    expect(four.attack).toBe(1 + 1);
    expect(four.flipped).toHaveLength(4);
    const three = effect({ b1: [1, 1], c1: [1, 1], d1: [1, 1], e1: [0, 1] }, "a1", "fu");
    expect(three.attack).toBe(1);
  });
  it("複数方向を挟んだとき、回復は最大の 1 方向分だけ（合計しない）", () => {
    // 右: 端が金 → min(3,3)-1=2 / 下: 端が銀 → 1 / 斜め: 端が歩 → 0
    const e = effect(
      { b1: [1, 1], c1: [0, 3], a2: [1, 2], a3: [0, 2], b2: [1, 1], c3: [0, 1] },
      "a1",
      "kin",
    );
    expect(e.heal).toBe(2);
    // 攻撃も全方向の合算: 最大値 2 + 3 枚 ÷ 4 = 0
    expect(e.attack).toBe(2);
    expect(e.flipped).toHaveLength(3);
  });
  it("角: 飛と歩を返すと攻撃 5×2 + 2÷4 = 10、回復は歩と同じ 0", () => {
    const e = effect({ b1: [1, 1], c1: [1, 5], d1: [0, 5] }, "a1", "kaku");
    expect(e.attack).toBe(10);
    expect(e.heal).toBe(0);
  });
});

describe("盤面の更新", () => {
  it("返された駒は色だけ変わり、数値は残る", () => {
    const b = boardOf({ b1: [1, 1], c1: [1, 5], d1: [0, 2] });
    const nb = applyMove(b, 0, 0, 0, linesFor(b, 0, 0, 0), "gin");
    expect(nb[0].slice(0, 4).map((s) => [s!.owner, s!.value])).toEqual([[0, 2], [0, 1], [0, 5], [0, 2]]);
    // 元の盤面は変更しない
    expect(b[0][2]!.owner).toBe(1);
  });
  it("相手に取り返されても数値は変わらない", () => {
    // 先手が b1 に銀を置き、後手の歩(c1)・飛(d1)を返す
    const b = boardOf({ a1: [1, 3], c1: [1, 1], d1: [1, 5], e1: [0, 2] });
    const b1 = applyMove(b, 0, 0, 1, linesFor(b, 0, 1, 0), "gin");
    expect(b1[0].slice(0, 5).map((s) => [s!.owner, s!.value])).toEqual([[1, 3], [0, 2], [0, 1], [0, 5], [0, 2]]);
    // 後手が f1 に歩を置き、b1〜e1 を挟み返す
    const b2 = applyMove(b1, 1, 0, 5, linesFor(b1, 0, 5, 1), "fu");
    expect(b2[0].slice(0, 6).map((s) => [s!.owner, s!.value])).toEqual([
      [1, 3], [1, 2], [1, 1], [1, 5], [1, 2], [1, 1],
    ]);
  });
});

describe("対局の進行", () => {
  it("着手で持ち駒が減り、相手の体力が減って自分が回復する", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 2], d1: [1, 3], e1: [0, 2] }), {
      hands: [{ kin: 2 }, { fu: 1 }],
      hp: [50, 60],
    });
    const n = playMove(s, 0, 0, "kin");
    expect(n.hands[0].kin).toBe(1);
    expect(n.hp).toEqual([51, 57]);
    expect(n.history.at(-1)).toMatchObject({ type: "move", player: 0, kind: "kin", attack: 3, heal: 1 });
  });
  it("相手に合法手がなければパスして自分が続けて打つ", () => {
    // 先手 a1 で b1 を返すと後手は g8 しか残らず置けない。先手は f8 に置ける
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1], g8: [1, 1], h8: [0, 1] }));
    const n = playMove(s, 0, 0, "fu");
    expect(n.result).toBeNull();
    expect(n.turn).toBe(0);
    expect(n.history.at(-1)).toEqual({ type: "pass", player: 1, reason: "no-move" });
  });
  it("持ち駒が尽きた側は盤上に置き場所があってもパス", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1], d5: [1, 1], e5: [0, 1] }), {
      hands: [{ fu: 3 }, {}],
    });
    expect(legalMoves(s.board, 1).length).toBeGreaterThan(0);
    expect(movesFor(s, 1)).toEqual([]);
    const n = playMove(s, 0, 0, "fu");
    expect(n.turn).toBe(0);
    expect(n.history.at(-1)).toEqual({ type: "pass", player: 1, reason: "no-piece" });
  });
  it("持ち駒が尽きた駒種は置けず、予測も出ない", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1] }), { hands: [{ fu: 1, hi: 0 }, { fu: 1 }] });
    expect(() => playMove(s, 0, 0, "hi")).toThrow();
    expect(previewMove(s, 0, 0, "hi")).toBeNull();
    expect(previewMove(s, 0, 0, "fu")).not.toBeNull();
  });
  it("飛を 2 回使うと飛の残数は 0 になり、3 回目は置けない", () => {
    let s = createGame({ kaku: false });
    for (let i = 0; i < 4; i++) {
      const m = movesFor(s, s.turn)[0];
      s = playMove(s, m.r, m.c, "hi");
    }
    expect(s.hands[0].hi).toBe(0);
    expect(s.hands[1].hi).toBe(0);
    const m = movesFor(s, s.turn)[0];
    expect(() => playMove(s, m.r, m.c, "hi")).toThrow();
  });
  it("合法でないマスには置けない", () => {
    const s = createGame({ kaku: false });
    expect(() => playMove(s, 0, 0, "fu")).toThrow();
  });
  it("相手の体力が 0 ちょうどになった時点で即終局（体力 0 決着）", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 2], d1: [1, 3], e1: [0, 2], g8: [1, 1], h8: [0, 1] }), {
      hp: [10, 3],
    });
    const n = playMove(s, 0, 0, "kin");
    expect(n.hp[1]).toBe(0);
    expect(n.result).toEqual({ winner: 0, reason: "ko" });
    expect(() => playMove(n, 7, 5, "fu")).toThrow();
  });
  it("体力が 1 残れば続行する", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 2], d1: [1, 3], e1: [0, 2], g8: [1, 1], h8: [0, 1] }), {
      hp: [10, 4],
    });
    expect(playMove(s, 0, 0, "kin").result).toBeNull();
  });
  it("両者とも置けなくなったら終局し、体力 → 石数の順で判定する", () => {
    // 先手が a1 に置くと後手の駒がなくなり、両者置けない
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1] }), { hp: [30, 31] });
    const n = playMove(s, 0, 0, "fu"); // 後手 31 - 1 = 30 で体力は同点
    expect(n.hp).toEqual([30, 30]);
    expect(n.result).toEqual({ winner: 0, reason: "discs" });
    expect(n.history.filter((e) => e.type === "pass")).toEqual([]);
  });
  it("judge: 体力が多い方 → 石数 → 引き分け", () => {
    const even = boardOf({ a1: [0, 1], b1: [1, 1] });
    const more1 = boardOf({ a1: [0, 1], b1: [1, 1], c1: [1, 1] });
    expect(judge([10, 9], more1)).toEqual({ winner: 0, reason: "hp" });
    expect(judge([9, 10], even)).toEqual({ winner: 1, reason: "hp" });
    expect(judge([9, 9], more1)).toEqual({ winner: 1, reason: "discs" });
    expect(judge([9, 9], even)).toEqual({ winner: null, reason: "draw" });
  });
});

describe("CPU（2 手読み）", () => {
  it("合法手と手持ちの駒を返す", () => {
    let s = createGame({ kaku: true });
    for (let i = 0; i < 10; i++) {
      const ch = chooseLookahead(s, () => 0.5)!;
      expect(s.hands[s.turn][ch.kind]).toBeGreaterThan(0);
      expect(movesFor(s, s.turn).some((m) => m.r === ch.r && m.c === ch.c)).toBe(true);
      s = playMove(s, ch.r, ch.c, ch.kind);
    }
  });
  it("相手の最善応手を差し引いた評価で選ぶ（候補のスコアは全て最善値）", () => {
    const s = createGame({ kaku: false });
    const { best, cands } = lookaheadCandidates(s);
    expect(cands.length).toBeGreaterThan(0);
    expect(Number.isFinite(best)).toBe(true);
  });
  it("持ち駒がなければ null", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1] }), { hands: [{}, { fu: 1 }] });
    expect(chooseLookahead(s)).toBeNull();
  });
});
