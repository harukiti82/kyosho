import { describe, expect, it } from "vitest";
import { applyLines, damageOf, healOf, linesFor, newBoard, rawLines } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import {
  canMove,
  createGame,
  judge,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
  threatenedPieces,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { NO_KING, PRESETS, type PieceKind, type RuleSet } from "../src/engine/rules";
import { at, boardOf, rulesOf, stateOf } from "./helpers";

const names = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([r, c]) => `${"abcdefgh"[c]}${r + 1}`).sort();

/** 手番のプレイヤーが name に kind を置く */
function play(s: GameState, name: string, kind: PieceKind = "fu") {
  const [r, c] = at(name);
  return playMove(s, r, c, kind);
}
const lastMove = (s: GameState) => lastMoveOf(s)!;

const FLIP = rulesOf("orig", { heal: "none" }); // 裏返す・制限なし・合計・回復なし
const CAPTURE = rulesOf("v10");

describe("プリセットと初期状態", () => {
  it("5 つのプリセットの値（隠し王は「隠し王」プリセットだけ）", () => {
    const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p.rules]));
    expect(byId.v04).toEqual({
      action: "flip", gate: false, damage: "maxCount", heal: "lowMinus1",
      hp: [65, 66], hand: { fu: 14, gin: 10, kin: 6, hi: 2 }, maxPlies: 0, king: NO_KING,
    });
    expect(byId.v10).toEqual({
      action: "capture", gate: false, damage: "sum", heal: "none",
      hp: [20, 20], hand: { fu: 8, gin: 0, kin: 4, hi: 2 }, maxPlies: 80, king: NO_KING,
    });
    expect(byId.v2).toEqual({
      action: "flip", gate: true, damage: "sum", heal: "none",
      hp: [40, 40], hand: { fu: 20, gin: 0, kin: 8, hi: 4 }, maxPlies: 0, king: NO_KING,
    });
    expect(byId.orig).toEqual({
      action: "flip", gate: false, damage: "sum", heal: "avg",
      hp: [40, 40], hand: { fu: 14, gin: 10, kin: 6, hi: 2 }, maxPlies: 0, king: NO_KING,
    });
    expect(byId.king).toEqual({
      action: "flip", gate: false, damage: "sum", heal: "none",
      hp: [70, 60], hand: { fu: 14, gin: 10, kin: 6, hi: 2 }, maxPlies: 0,
      king: { on: true, penalty: "hp", amount: 20, deadline: 5 },
    });
    expect(NO_KING).toEqual({ on: false, penalty: "hp", amount: 20, deadline: 5 });
  });
  it("初期配置は中央 4 駒がすべて歩で、オセロと同じ並び。体力と持ち駒は設定どおり", () => {
    const b = newBoard();
    expect([b[3][3], b[4][4], b[3][4], b[4][3]]).toEqual([
      { owner: 1, kind: "fu" }, { owner: 1, kind: "fu" }, { owner: 0, kind: "fu" }, { owner: 0, kind: "fu" },
    ]);
    const g = createGame(rulesOf("v04"));
    expect(g.hp).toEqual([65, 66]);
    expect(g.hands[1]).toEqual({ fu: 14, gin: 10, kin: 6, hi: 2 });
    expect(g.turn).toBe(0);
  });
  it("createGame は設定をコピーする（後から元の設定を変えても対局に影響しない）", () => {
    const r = rulesOf("v2");
    const g = createGame(r);
    r.hand.fu = 0;
    r.hp[0] = 5;
    expect(g.rules.hand.fu).toBe(20);
    expect(g.hp).toEqual([40, 40]);
  });
});

describe("挟んだ駒を: 裏返す", () => {
  it("挟めるマスにしか置けない（初手は 4 マス）", () => {
    const g = createGame(FLIP);
    expect(names(legalCells(g, "fu"))).toEqual(["c4", "d3", "e6", "f5"]);
    expect(() => play(g, "a1")).toThrow();
    expect(previewMove(g, 0, 0, "fu")).toBeNull();
  });
  it("返した駒は色だけ変わり、数字はそのまま。持ち駒は増えない", () => {
    const s = stateOf(boardOf({ b1: [1, 5], c1: [1, 3], d1: [0, 1] }), { rules: FLIP, hands: [{ fu: 2 }, { fu: 1 }] });
    const n = play(s, "a1");
    expect([n.board[0][0], n.board[0][1], n.board[0][2]]).toEqual([
      { owner: 0, kind: "fu" }, { owner: 0, kind: "hi" }, { owner: 0, kind: "kin" },
    ]);
    expect(n.hands[0]).toEqual({ fu: 1, gin: 0, kin: 0, hi: 0 });
    expect(lastMove(n)).toMatchObject({ damage: 8, heal: 0, targets: [{ r: 0, c: 1, kind: "hi" }, { r: 0, c: 2, kind: "kin" }] });
    expect(n.hp).toEqual([40, 32]);
  });
});

describe("挟んだ駒を: 取って持ち駒にする", () => {
  it("挟めない空きマスにも置ける（何も取らずダメージ 0）", () => {
    const n = play(createGame(CAPTURE), "a1", "hi");
    expect(n.board[0][0]).toEqual({ owner: 0, kind: "hi" });
    expect(n.hands[0]).toEqual({ fu: 8, gin: 0, kin: 4, hi: 1 });
    expect(lastMove(n)).toMatchObject({ targets: [], damage: 0, heal: 0 });
    expect(legalCells(createGame(CAPTURE), "fu")).toHaveLength(60);
  });
  it("取った駒は盤から消え、数字そのままで取った側の持ち駒に入る", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 2], d1: [1, 5], e1: [0, 1] }), {
      hands: [{ kin: 1 }, { fu: 1 }],
    });
    const n = play(s, "a1", "kin");
    expect([n.board[0][1], n.board[0][2], n.board[0][3]]).toEqual([null, null, null]);
    expect(n.hands[0]).toEqual({ fu: 1, gin: 1, kin: 0, hi: 1 });
    expect(n.hands[1]).toEqual({ fu: 1, gin: 0, kin: 0, hi: 0 });
  });
  it("挟まれる位置へ自分から置いても取られない", () => {
    const s = stateOf(boardOf({ a1: [1, 1], c1: [1, 1] }));
    const n = play(s, "b1", "hi");
    expect(n.board[0][1]).toEqual({ owner: 0, kind: "hi" });
    expect(n.hp).toEqual([20, 20]);
  });
});

describe("強さ制限", () => {
  // 右: 後手の金3 を挟む / 下: 後手の歩1 を挟む
  const stones = { b1: [1, 3], c1: [0, 1], a2: [1, 1], a3: [0, 1] } as const;
  it("置いた駒より数字が大きい駒を含む列だけ返せない（他の方向は返せる）", () => {
    const rules = rulesOf("v2");
    const s = stateOf(boardOf(stones), { rules, hands: [{ fu: 1, kin: 1 }, { fu: 1 }] });
    expect(names(linesFor(s.board, 0, 0, 0, "fu", rules).flatMap((l) => l.cells))).toEqual(["a2"]);
    expect(names(linesFor(s.board, 0, 0, 0, "kin", rules).flatMap((l) => l.cells))).toEqual(["a2", "b1"]); // 同じ数字は返せる
    const n = play(s, "a1", "fu");
    expect(n.board[0][1]).toEqual({ owner: 1, kind: "kin" });
    expect(n.board[1][0]).toEqual({ owner: 0, kind: "fu" });
    expect(lastMove(n).damage).toBe(1);
  });
  it("制限なしなら同じ手で両方返せる", () => {
    const s = stateOf(boardOf(stones), { rules: FLIP, hands: [{ fu: 1 }, { fu: 1 }] });
    expect(lastMove(play(s, "a1")).damage).toBe(4);
  });
  it("裏返すルールでは、返せる列がない駒ではそのマスに置けない", () => {
    const rules = rulesOf("v2");
    const s = stateOf(boardOf({ b1: [1, 5], c1: [0, 1] }), { rules, hands: [{ fu: 1, hi: 1 }, { fu: 1 }] });
    expect(legalCells(s, "fu")).toEqual([]);
    expect(names(legalCells(s, "hi"))).toEqual(["a1"]);
    expect(playableKinds(s)).toEqual(["hi"]);
    expect(() => play(s, "a1", "fu")).toThrow();
  });
  it("取るルールでも効く（置けるが、強い駒の列は取れない）", () => {
    const rules = rulesOf("v10", { gate: true });
    const s = stateOf(boardOf({ b1: [1, 5], c1: [0, 1] }), { rules, hands: [{ fu: 1 }, { fu: 1 }] });
    const n = play(s, "a1");
    expect(n.board[0][1]).toEqual({ owner: 1, kind: "hi" });
    expect(lastMove(n).damage).toBe(0);
  });
  it("相手の「返されうる駒」は相手の持ち駒で最も大きい駒で判定する", () => {
    const rules = rulesOf("v2");
    // 後手が a1 に置けば先手の飛 b1 を挟めるが、後手の持ち駒が歩だけなら返せない
    const board = boardOf({ b1: [0, 5], c1: [1, 1] });
    expect(threatenedPieces(stateOf(board, { rules, hands: [{ fu: 1 }, { fu: 3 }] }), 0)).toEqual([]);
    expect(names(threatenedPieces(stateOf(board, { rules, hands: [{ fu: 1 }, { fu: 1, hi: 1 }] }), 0))).toEqual(["b1"]);
  });
});

describe("ダメージ", () => {
  // a1 に置くと右に 歩1・金3・飛5、下に 歩1・歩1 を挟む（5 枚）
  const board = boardOf({ b1: [1, 1], c1: [1, 3], d1: [1, 5], e1: [0, 1], a2: [1, 1], a3: [1, 1], a4: [0, 1] });
  const lines = (r: RuleSet) => linesFor(board, 0, 0, 0, "fu", r);
  it("合計: 1+3+5+1+1 = 11", () => {
    const r = rulesOf("orig", { damage: "sum" });
    expect(damageOf(board, lines(r), r)).toBe(11);
  });
  it("最大値＋枚数÷4: 5 + floor(5/4) = 6。3 枚以下なら最大値のまま", () => {
    const r = rulesOf("orig", { damage: "maxCount" });
    expect(damageOf(board, lines(r), r)).toBe(6);
    const b3 = boardOf({ b1: [1, 1], c1: [1, 3], d1: [1, 2], e1: [0, 1] });
    expect(damageOf(b3, linesFor(b3, 0, 0, 0, "fu", r), r)).toBe(3);
  });
  it("何も返さなければ 0", () => {
    const r = rulesOf("v10", { damage: "maxCount" });
    expect(damageOf(board, [], r)).toBe(0);
  });
});

describe("回復", () => {
  // a1 に置くと右は金3 の自駒で、下は歩1 の自駒で挟む
  const board = boardOf({ b1: [1, 1], c1: [0, 3], a2: [1, 1], a3: [0, 1] });
  const raw = rawLines(board, 0, 0, 0);
  const heal = (placed: number, h: RuleSet["heal"]) => healOf(raw, placed, rulesOf("orig", { heal: h }));
  it("平均（切り捨て）: 最も大きい 1 方向分", () => {
    expect(heal(5, "avg")).toBe(4); // (5+3)/2=4、(5+1)/2=3 → 4
    expect(heal(2, "avg")).toBe(2); // (2+3)/2=2.5→2、(2+1)/2=1.5→1
    expect(heal(1, "avg")).toBe(2); // (1+3)/2=2、(1+1)/2=1
  });
  it("低い方−1（0 未満は 0）: 最も大きい 1 方向分", () => {
    expect(heal(5, "lowMinus1")).toBe(2); // min(5,3)-1=2、min(5,1)-1=0
    expect(heal(1, "lowMinus1")).toBe(0); // min(1,3)-1=0
    expect(healOf(raw.slice(1), 5, rulesOf("orig", { heal: "lowMinus1" }))).toBe(0); // 歩の端だけ → 0
  });
  it("回復なし・返せない手は 0", () => {
    expect(heal(5, "none")).toBe(0);
    expect(healOf([], 5, rulesOf("orig"))).toBe(0);
  });
  it("回復は置いた側の体力に足す（初期体力を超えてもよい）", () => {
    const s = stateOf(board, { rules: rulesOf("orig"), hands: [{ hi: 1 }, { fu: 1 }] });
    const n = play(s, "a1", "hi");
    expect(lastMove(n)).toMatchObject({ damage: 2, heal: 4 });
    expect(n.hp).toEqual([44, 38]);
  });
});

describe("対局の進行", () => {
  it("手数上限で打ち切り、体力の多い方の勝ち（limit）。0 なら上限なし", () => {
    const rules = rulesOf("v10", { maxPlies: 3 });
    const s = stateOf(boardOf({}), { rules, ply: 2, hp: [5, 6] });
    expect(play(s, "a1").result).toEqual({ winner: 1, reason: "limit", byDiscs: false });
    expect(play(stateOf(boardOf({}), { rules, ply: 1 }), "a1").result).toBeNull();
    const none = rulesOf("v10", { maxPlies: 0 });
    expect(play(stateOf(boardOf({ h8: [1, 1] }), { rules: none, ply: 500 }), "a1").result).toBeNull();
  });
  it("体力が同じなら石数、石数も同じなら引き分け", () => {
    const b = boardOf({ a1: [0, 1], a2: [0, 1], h8: [1, 5] });
    expect(judge(b, [10, 9], "limit")).toEqual({ winner: 0, reason: "limit", byDiscs: false });
    expect(judge(b, [9, 9], "stalled")).toEqual({ winner: 0, reason: "stalled", byDiscs: true });
    expect(judge(boardOf({ a1: [0, 1], h8: [1, 5] }), [9, 9], "limit")).toEqual({ winner: null, reason: "limit", byDiscs: false });
  });
  it("体力 5 の設定で 5 ダメージを受けると即終局（ko）、その後は置けない", () => {
    const rules = rulesOf("v10", { hp: [5, 5] });
    const s = stateOf(boardOf({ b1: [1, 5], c1: [0, 1] }), { rules });
    const n = play(s, "a1");
    expect(n.hp).toEqual([5, 0]);
    expect(n.result).toEqual({ winner: 0, reason: "ko", byDiscs: false });
    expect(() => play(n, "h8")).toThrow();
    expect(previewMove(n, 7, 7, "fu")).toBeNull();
    expect(threatenedPieces(n, 0)).toEqual([]);
  });
  it("持ち駒切れはパス（noPieces）し、相手が続けて打つ", () => {
    const s = stateOf(boardOf({ d4: [0, 1], e5: [1, 1] }), { hands: [{ fu: 2 }, { fu: 1 }], turn: 1 });
    const n = playMove(s, 0, 0, "fu");
    const n2 = playMove(n, 0, 7, "fu");
    expect(n2.turn).toBe(0);
    expect(n2.history.at(-1)).toEqual({ type: "pass", player: 1, reason: "noPieces" });
    expect(n2.result).toBeNull();
  });
  it("強さ制限で置けるマスが尽きたらパス（noMoves）。両者打てなければ終局", () => {
    const rules = rulesOf("v2");
    // 先手が a1 で後手の歩を返すと、後手は持ち駒が歩だけで先手の飛を返せない → パス
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 5], d1: [1, 1], h8: [1, 5], g8: [0, 5] }), {
      rules,
      hands: [{ fu: 2 }, { fu: 5 }],
    });
    expect(s.hands[1].fu).toBe(5); // 持ち駒はあるが置ける所がない
    const n = play(s, "a1");
    expect(n.history.at(-1)).toEqual({ type: "pass", player: 1, reason: "noMoves" });
    expect(n.turn).toBe(0);
    expect(canMove(n, 1)).toBe(false);
    expect(names(legalCells(n, "fu"))).toEqual(["e1"]);
    // 先手も置ける所がなくなれば終局（体力 → 石数で判定）
    const done = stateOf(boardOf({ a1: [0, 5], b1: [1, 5] }), { rules, hands: [{ fu: 1 }, { fu: 1 }] });
    expect(canMove(done, 0)).toBe(false);
    expect(canMove(done, 1)).toBe(false);
  });
  it("駒の数がすべて 0 なら、始まった時点で終局（体力も石数も同じなので引き分け）", () => {
    const g = createGame(rulesOf("v2", { hand: { fu: 0, gin: 0, kin: 0, hi: 0 } }));
    expect(g.result).toEqual({ winner: null, reason: "stalled", byDiscs: false });
    expect(g.ply).toBe(0);
    const g2 = createGame(rulesOf("v10", { hand: { fu: 0, gin: 0, kin: 0, hi: 0 }, hp: [30, 20] }));
    expect(g2.result).toEqual({ winner: 0, reason: "stalled", byDiscs: false });
  });
  it("applyLines は元の盤面を変更しない", () => {
    const b = boardOf({ b1: [1, 1], c1: [0, 1] });
    applyLines(b, 0, 0, 0, "fu", rawLines(b, 0, 0, 0), CAPTURE);
    expect(b[0][0]).toBeNull();
    expect(b[0][1]).toEqual({ owner: 1, kind: "fu" });
  });
});

describe("予測と警告", () => {
  it("previewMove: 返せる駒・ダメージ・回復", () => {
    const s = stateOf(boardOf({ b1: [1, 3], c1: [0, 3] }), { rules: rulesOf("orig"), hands: [{ hi: 1 }, { fu: 1 }] });
    expect(previewMove(s, 0, 0, "hi")).toMatchObject({ targets: [[0, 1]], damage: 3, heal: 4 });
  });
  it("previewMove: 置いた後に相手が返せる自分の駒（置いた駒を含む）", () => {
    const s = stateOf(boardOf({ a1: [1, 1] }));
    const pv = previewMove(s, 0, 1, "hi")!;
    expect(names(pv.exposed)).toEqual(["b1"]);
    expect(pv.exposedDamage).toBe(5);
  });
  it("threatenedPieces: 相手が次の 1 手で返せる駒", () => {
    const s = stateOf(boardOf({ a1: [1, 1], b1: [0, 5], d1: [0, 3], e1: [1, 1], h8: [0, 1] }));
    expect(names(threatenedPieces(s, 0))).toEqual(["b1", "d1"]);
  });
});

describe("CPU（2 手読み）", () => {
  it.each(PRESETS.map((p) => [p.name, p.rules] as const))("%s: 合法手だけを打って終局まで進む", (_, rules) => {
    let s = createGame(rules);
    let n = 0;
    while (!s.result) {
      const ch = chooseLookahead(viewFor(s, s.turn), () => 0.5)!;
      expect(legalCells(s, ch.kind).some(([r, c]) => r === ch.r && c === ch.c)).toBe(true);
      s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
      n++;
    }
    expect(n).toBeGreaterThan(0);
    if (rules.maxPlies > 0) expect(n).toBeLessThanOrEqual(rules.maxPlies);
  });
  it("回復も評価に入れる", () => {
    // a1（返して回復 4）と h1（返して回復 1）は同じダメージ。回復の多い a1 を選ぶ
    const rules = rulesOf("orig");
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 5], g1: [1, 1], f1: [0, 1] }), { rules, hands: [{ kin: 1 }, {}] });
    expect(lookaheadCandidates(viewFor(s, s.turn))).toEqual({ best: 1 + 4, cands: [{ r: 0, c: 0, kind: "kin" }] });
  });
  it("取られる位置に飛を置かない（駒選びで差がつく）", () => {
    const s = stateOf(boardOf({ a1: [1, 1], h8: [1, 1] }), { hands: [{ fu: 1, hi: 1 }, { fu: 1 }] });
    const { cands } = lookaheadCandidates(viewFor(s, s.turn));
    expect(cands.some((x) => x.r === 0 && x.c === 1 && x.kind === "hi")).toBe(false);
  });
  it("持ち駒がなければ null", () => {
    expect(chooseLookahead(viewFor(stateOf(boardOf({ c1: [0, 1] }), { hands: [{}, { fu: 1 }] }), 0))).toBeNull();
  });
});
