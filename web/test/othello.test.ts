// 普通のオセロの合法手（画面の参考表示）のテスト: 初期配置・合法手なし・盤の端・方向の重複・駒ごとの置けるマスとの違い

import { describe, expect, it } from "vitest";
import { newBoard, othelloCells } from "../src/engine/board";
import { createGame, legalCells } from "../src/engine/game";
import { at, boardOf, rulesOf, stateOf } from "./helpers";

const names = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([r, c]) => `${"abcdefgh"[c]}${r + 1}`).sort();

describe("othelloCells", () => {
  it("初期配置では普通のオセロと同じく 4 か所", () => {
    const b = newBoard();
    expect(names(othelloCells(b, 0))).toEqual(["c4", "d3", "e6", "f5"]);
    expect(names(othelloCells(b, 1))).toEqual(["c5", "d6", "e3", "f4"]);
  });

  it("相手の駒を挟めなければ合法手はない", () => {
    // 自分の駒しかない
    expect(othelloCells(boardOf({ d4: [0, 1], e5: [0, 1] }), 0)).toEqual([]);
    // 相手の駒はあるが、反対端に自分の駒がない
    expect(othelloCells(boardOf({ d4: [1, 1], e5: [1, 1] }), 0)).toEqual([]);
  });

  it("盤の端で列が切れたら挟めない。端に自分の駒があれば挟める", () => {
    // 1 行目: b1〜h1 が相手の駒で、反対端に自分の駒がない
    const open = boardOf({ b1: [1, 1], c1: [1, 1], d1: [1, 1], e1: [1, 1], f1: [1, 1], g1: [1, 1], h1: [1, 1] });
    expect(othelloCells(open, 0)).toEqual([]);
    // h1 が自分の駒なら a1 から 6 つ挟める
    const closed = boardOf({ b1: [1, 1], c1: [1, 1], d1: [1, 1], e1: [1, 1], f1: [1, 1], g1: [1, 1], h1: [0, 1] });
    expect(names(othelloCells(closed, 0))).toEqual(["a1"]);
  });

  it("挟める石が 1 つでも置ける。複数の方向で挟めるマスも 1 回だけ", () => {
    // d4 は c3（斜め）・d3（縦）・c4（横）の 3 方向から 1 つずつ挟める
    const b = boardOf({ c3: [1, 1], d3: [1, 1], c4: [1, 1], b2: [0, 1], d2: [0, 1], b4: [0, 1] });
    const cells = names(othelloCells(b, 0));
    expect(cells.filter((n) => n === "d4")).toHaveLength(1);
    expect(cells).toContain("d4");
  });

  it("空きマスだけを返す", () => {
    const b = newBoard();
    for (const [r, c] of othelloCells(b, 0)) expect(b[r][c]).toBeNull();
  });

  it("駒の方向・強さ制限・持ち駒を見ない（駒ごとの置けるマスとは別）", () => {
    // 標準（方向駒）: 歩は縦にしか挟めないので、初期配置で置けるのは d3・e6 だけ
    const g = createGame(rulesOf("std"));
    expect(names(legalCells(g, "fu"))).toEqual(["d3", "e6"]);
    expect(names(othelloCells(g.board, 0))).toEqual(["c4", "d3", "e6", "f5"]);
    // 強さ制限あり（v2 案）で、歩では金を返せなくてもオセロとしては置ける
    const gated = stateOf(boardOf({ d4: [1, 3], d5: [0, 1] }), { rules: rulesOf("v2"), hands: [{ fu: 1 }, { fu: 1 }] });
    expect(legalCells(gated, "fu")).toEqual([]);
    expect(names(othelloCells(gated.board, 0))).toEqual(["d3"]);
    expect(othelloCells(gated.board, 0)).toEqual([at("d3")]);
  });
});
