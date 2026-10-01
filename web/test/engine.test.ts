import { describe, expect, it } from "vitest";
import { applyMove, bestCapture, capturesAt, newBoard } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import { createGame, judge, playMove, previewMove, threatenedPieces } from "../src/engine/game";
import { INITIAL_HAND, INITIAL_HP, MAX_PLIES } from "../src/engine/rules";
import { at, boardOf, stateOf } from "./helpers";

const names = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([r, c]) => `${"abcdefgh"[c]}${r + 1}`).sort();

/** 先手が name に kind を置く */
function play(s: ReturnType<typeof stateOf>, name: string, kind: "fu" | "kin" | "hi" = "fu") {
  const [r, c] = at(name);
  return playMove(s, r, c, kind);
}

describe("ルール定数", () => {
  it("体力 20・80 手・持ち駒 歩8・金4・飛2（両者同じ）", () => {
    const g = createGame();
    expect(INITIAL_HP).toBe(20);
    expect(MAX_PLIES).toBe(80);
    expect(g.hp).toEqual([20, 20]);
    expect(g.hands).toEqual([{ fu: 8, kin: 4, hi: 2 }, { fu: 8, kin: 4, hi: 2 }]);
    expect(INITIAL_HAND).toEqual({ fu: 8, kin: 4, hi: 2 });
  });
  it("初期配置は中央 4 駒がすべて歩で、オセロと同じ並び", () => {
    const b = newBoard();
    expect([b[3][3], b[4][4], b[3][4], b[4][3]]).toEqual([
      { owner: 1, kind: "fu" }, { owner: 1, kind: "fu" }, { owner: 0, kind: "fu" }, { owner: 0, kind: "fu" },
    ]);
  });
});

describe("置く・取る", () => {
  it("挟めない空きマスにも置ける（何も取らずダメージ 0）", () => {
    const n = play(createGame(), "a1", "hi");
    expect(n.board[0][0]).toEqual({ owner: 0, kind: "hi" });
    expect(n.hands[0]).toEqual({ fu: 8, kin: 4, hi: 1 });
    expect(n.hp).toEqual([20, 20]);
    expect(n.history.at(-1)).toMatchObject({ type: "move", captured: [], damage: 0 });
    expect(n.turn).toBe(1);
  });
  it("埋まっているマスには置けない", () => {
    expect(() => play(createGame(), "d4")).toThrow();
  });
  it("1 方向で挟んだ列をすべて取る（盤から消える）", () => {
    // a1 に置くと b1・c1（後手）を d1（先手）と挟む
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 3], d1: [0, 1] }));
    const n = play(s, "a1");
    expect(names(capturesAt(s.board, 0, 0, 0))).toEqual(["b1", "c1"]);
    expect(n.board[0][1]).toBeNull();
    expect(n.board[0][2]).toBeNull();
    expect(n.board[0][3]).toEqual({ owner: 0, kind: "fu" });
  });
  it("複数方向を同時に取る", () => {
    // 右・下・斜めの 3 方向
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1], a2: [1, 3], a3: [0, 1], b2: [1, 5], c3: [0, 3] }));
    expect(names(capturesAt(s.board, 0, 0, 0))).toEqual(["a2", "b1", "b2"]);
    const n = play(s, "a1");
    expect([n.board[0][1], n.board[1][0], n.board[1][1]]).toEqual([null, null, null]);
  });
  it("端が空き・相手の駒・盤外なら取れない", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 1], a2: [1, 1], a3: [1, 3] }));
    expect(capturesAt(s.board, 0, 0, 0)).toEqual([]);
  });
  it("取った駒は数字そのままで取った側の持ち駒に入る", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 3], d1: [1, 5], e1: [0, 1] }), {
      hands: [{ fu: 1, kin: 1 }, { fu: 1 }],
    });
    const n = play(s, "a1", "kin");
    expect(n.hands[0]).toEqual({ fu: 2, kin: 1, hi: 1 }); // 金 1 個使って 歩・金・飛 を 1 個ずつ得る
    expect(n.hands[1]).toEqual({ fu: 1, kin: 0, hi: 0 }); // 取られた側の持ち駒は変わらない
  });
  it("ダメージ = 取った駒の数字の合計", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [1, 3], d1: [0, 1], a2: [1, 5], a3: [0, 1] }));
    const n = play(s, "a1");
    expect(n.history.at(-1)).toMatchObject({ damage: 1 + 3 + 5 });
    expect(n.hp).toEqual([20, 11]);
  });
  it("挟まれる位置へ自分から置いても取られない（取るのは置いた側だけ）", () => {
    // 先手が b1 に置くと a1・c1 の後手に挟まれる形になるが、何も起きない
    const s = stateOf(boardOf({ a1: [1, 1], c1: [1, 1] }));
    const n = play(s, "b1", "hi");
    expect(n.board[0][1]).toEqual({ owner: 0, kind: "hi" });
    expect(n.hp).toEqual([20, 20]);
    expect(n.hands[1]).toEqual(s.hands[1]);
  });
  it("取った飛を自分の駒として置ける", () => {
    // 先手が a1 で後手の飛(b1)を取る → 先手の持ち駒の飛が 3 個に
    let s = stateOf(boardOf({ b1: [1, 5], c1: [0, 1] }), { hands: [{ fu: 1 }, { fu: 1 }] });
    s = play(s, "a1");
    expect(s.hands[0].hi).toBe(1);
    // 後手が b1 に歩を置く（a1 と c1 の間。挟まれても取られない）
    s = playMove(s, 0, 1, "fu");
    // 先手は取った飛を置ける
    s = playMove(s, 5, 5, "hi");
    expect(s.board[5][5]).toEqual({ owner: 0, kind: "hi" });
  });
  it("applyMove は元の盤面を変更しない", () => {
    const b = boardOf({ b1: [1, 1], c1: [0, 1] });
    applyMove(b, 0, 0, 0, "fu");
    expect(b[0][0]).toBeNull();
    expect(b[0][1]).toEqual({ owner: 1, kind: "fu" });
  });
});

describe("予測と警告", () => {
  it("previewMove: 取れる駒とダメージ。取れなければ空", () => {
    const s = stateOf(boardOf({ b1: [1, 3], c1: [0, 1] }));
    expect(previewMove(s, 0, 0, "fu")).toMatchObject({ captured: [[0, 1]], damage: 3 });
    expect(previewMove(s, 7, 7, "fu")).toMatchObject({ captured: [], damage: 0 });
    expect(previewMove(s, 0, 2, "fu")).toBeNull(); // 埋まっている
  });
  it("previewMove: 置いた後に相手が取れる自分の駒（置いた駒を含む）", () => {
    // 先手が b1 に飛を置くと、後手は c1 に置けば a1 と挟んで飛を取れる
    const s = stateOf(boardOf({ a1: [1, 1] }));
    const pv = previewMove(s, 0, 1, "hi")!;
    expect(names(pv.exposed)).toEqual(["b1"]);
    expect(pv.exposedDamage).toBe(5);
  });
  it("previewMove: 相手に持ち駒がなければ取られうる駒はない", () => {
    const s = stateOf(boardOf({ a1: [1, 1] }), { hands: [{ hi: 1 }, {}] });
    expect(previewMove(s, 0, 1, "hi")).toMatchObject({ exposed: [], exposedDamage: 0 });
  });
  it("threatenedPieces: 相手が次の 1 手で取れる駒", () => {
    // 先手の b1・d1 は後手に c1 へ置かれると両方取られる。h8 は周りに後手がいないので無事
    const s = stateOf(boardOf({ a1: [1, 1], b1: [0, 5], d1: [0, 3], e1: [1, 1], h8: [0, 1] }));
    expect(names(threatenedPieces(s, 0))).toEqual(["b1", "d1"]);
    expect(bestCapture(s.board, 1)).toBe(8);
  });
});

describe("対局の進行", () => {
  it("持ち駒が尽きた側はパスし、相手が続けて打つ", () => {
    const s = stateOf(boardOf({ d4: [0, 1], e5: [1, 1] }), { hands: [{ fu: 2 }, { fu: 1 }], turn: 1 });
    const n = playMove(s, 0, 0, "fu"); // 後手が最後の 1 個を置く
    expect(n.hands[1]).toEqual({ fu: 0, kin: 0, hi: 0 });
    expect(n.turn).toBe(0);
    const n2 = playMove(n, 0, 7, "fu"); // 先手が打つと、後手は持ち駒がないのでパス
    expect(n2.turn).toBe(0);
    expect(n2.history.at(-1)).toEqual({ type: "pass", player: 1 });
    expect(n2.result).toBeNull();
  });
  it("取って持ち駒が増えれば、尽きかけていても打ち続けられる", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1] }), { hands: [{ fu: 1 }, { fu: 1 }] });
    const n = play(s, "a1");
    expect(n.hands[0]).toEqual({ fu: 1, kin: 0, hi: 0 });
  });
  it("両者とも持ち駒が尽きたら終局し、体力で判定（stalled）", () => {
    const s = stateOf(boardOf({ b1: [1, 3], c1: [0, 1] }), { hands: [{ fu: 1 }, {}], hp: [20, 20] });
    // 先手が最後の歩で金を取る → 先手の持ち駒は金 1 個、後手は 0 個 → 後手パス・先手が打つ
    const n = play(s, "a1");
    expect(n.turn).toBe(0);
    expect(n.history.at(-1)).toEqual({ type: "pass", player: 1 });
    const n2 = playMove(n, 7, 7, "kin");
    expect(n2.result).toEqual({ winner: 0, reason: "stalled" });
    expect(n2.hp).toEqual([20, 17]);
  });
  it("80 手目で打ち切り、体力の多い方の勝ち（limit）", () => {
    const s = stateOf(boardOf({ b1: [1, 1], c1: [0, 1] }), { ply: MAX_PLIES - 1, hp: [5, 6] });
    const n = play(s, "a1"); // 後手 6 → 5 で同点 → 引き分け
    expect(n.ply).toBe(80);
    expect(n.result).toEqual({ winner: null, reason: "limit" });
    const s2 = stateOf(boardOf({}), { ply: MAX_PLIES - 1, hp: [5, 6] });
    expect(play(s2, "a1").result).toEqual({ winner: 1, reason: "limit" });
    // 79 手目まではまだ続く
    expect(play(stateOf(boardOf({}), { ply: MAX_PLIES - 2 }), "a1").result).toBeNull();
  });
  it("体力 0 ちょうどで即終局（ko）、その後は置けない", () => {
    const s = stateOf(boardOf({ b1: [1, 3], c1: [0, 1] }), { hp: [10, 3] });
    const n = play(s, "a1");
    expect(n.hp[1]).toBe(0);
    expect(n.result).toEqual({ winner: 0, reason: "ko" });
    expect(() => playMove(n, 7, 7, "fu")).toThrow();
    expect(previewMove(n, 7, 7, "fu")).toBeNull();
    expect(threatenedPieces(n, 0)).toEqual([]);
  });
  it("体力が 0 未満になっても ko。80 手目の ko は手数切れより優先", () => {
    const s = stateOf(boardOf({ b1: [1, 5], c1: [0, 1] }), { hp: [1, 2], ply: MAX_PLIES - 1 });
    const n = play(s, "a1");
    expect(n.hp[1]).toBe(-3);
    expect(n.result).toEqual({ winner: 0, reason: "ko" });
  });
  it("体力が 1 残れば続行する", () => {
    expect(play(stateOf(boardOf({ b1: [1, 3], c1: [0, 1] }), { hp: [10, 4] }), "a1").result).toBeNull();
  });
  it("judge: 体力が多い方の勝ち、同じなら引き分け", () => {
    expect(judge([10, 9], "limit")).toEqual({ winner: 0, reason: "limit" });
    expect(judge([9, 10], "stalled")).toEqual({ winner: 1, reason: "stalled" });
    expect(judge([9, 9], "limit")).toEqual({ winner: null, reason: "limit" });
  });
  it("持ち駒にない駒種は置けない", () => {
    const s = stateOf(boardOf({}), { hands: [{ fu: 1 }, { fu: 1 }] });
    expect(() => play(s, "a1", "hi")).toThrow();
    expect(previewMove(s, 0, 0, "hi")).toBeNull();
  });
});

describe("CPU（2 手読み）", () => {
  it("空きマスと手持ちの駒を返し、終局まで打てる", () => {
    let s = createGame();
    let n = 0;
    while (!s.result) {
      const ch = chooseLookahead(s, () => 0.5)!;
      expect(s.hands[s.turn][ch.kind]).toBeGreaterThan(0);
      expect(s.board[ch.r][ch.c]).toBeNull();
      s = playMove(s, ch.r, ch.c, ch.kind);
      n++;
    }
    expect(n).toBeLessThanOrEqual(MAX_PLIES);
  });
  it("取れる手があれば取る（相手の応手がないとき）", () => {
    const s = stateOf(boardOf({ b1: [1, 5], c1: [0, 1] }), { hands: [{ fu: 1 }, {}] });
    expect(lookaheadCandidates(s)).toEqual({ best: 5, cands: [{ r: 0, c: 0, kind: "fu" }] });
  });
  it("取られる位置に飛を置かない（駒選びで差がつく）", () => {
    // a1 は後手。b1 に置くと c1 に置かれて取られる。歩なら -1、飛なら -5
    const s = stateOf(boardOf({ a1: [1, 1], h8: [1, 1] }), { hands: [{ fu: 1, hi: 1 }, { fu: 1 }] });
    const { cands } = lookaheadCandidates(s);
    expect(cands.some((x) => x.r === 0 && x.c === 1 && x.kind === "hi")).toBe(false);
  });
  it("持ち駒がなければ null", () => {
    expect(chooseLookahead(stateOf(boardOf({ c1: [0, 1] }), { hands: [{}, { fu: 1 }] }))).toBeNull();
  });
});
