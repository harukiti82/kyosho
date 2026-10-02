// 隠し王（読み合い要素）のテスト: 王の指定・期限での自動指定・罰・公開・候補（CPU に見せる公開情報）・CPU の指定

import { describe, expect, it } from "vitest";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import {
  createGame,
  kingCandidates,
  kingInfo,
  kingRevealed,
  lastMoveOf,
  legalCells,
  playMove,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { type HiddenKing, type PieceKind, type RuleSet } from "../src/engine/rules";
import { at, boardOf, rulesOf, stateOf } from "./helpers";

const names = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([r, c]) => `${"abcdefgh"[c]}${r + 1}`).sort();

const king = (patch: Partial<HiddenKing> = {}): HiddenKing => ({ on: true, penalty: "hp", amount: 20, deadline: 5, ...patch });
/** 裏返す・制限なし・合計・回復なし・隠し王あり */
const KING = (patch: Partial<HiddenKing> = {}, rules: Partial<RuleSet> = {}) =>
  rulesOf("orig", { heal: "none", king: king(patch), ...rules });

function play(s: GameState, name: string, kind: PieceKind = "fu", asKing = false) {
  const [r, c] = at(name);
  return playMove(s, r, c, kind, { king: asKing });
}

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

/**
 * 1 列目の局面: b1 先手、c1 後手、d1 先手。後手番（a7・a8 は対局が続くための駒）。
 * 後手が e1 に置くと d1 を返し、続けて先手が f1 に置くと e1・d1・c1 を返す（王を指定した手の駒が即返される）
 */
function row1(rules: RuleSet, hp?: [number, number]) {
  const board = boardOf({ b1: [0, 1], c1: [1, 1], d1: [0, 1], a7: [0, 1], a8: [1, 1] });
  return stateOf(board, { rules, turn: 1, hp, hands: [{ fu: 3 }, { fu: 3 }] });
}

describe("隠し王: 王の指定", () => {
  it("「この駒を王にする」で置いた駒が王になる。1 人 1 回", () => {
    let s = createGame(rulesOf("king"));
    expect(kingInfo(s, 0)).toMatchObject({ status: "unset", nextMove: 1, canDesignate: true, forcedNow: false });
    s = play(s, "d3", "fu", true);
    expect(kingInfo(s, 0)).toMatchObject({ status: "hidden", cell: [2, 3], auto: false, canDesignate: false });
    // 後手はまだ
    expect(kingInfo(s, 1).status).toBe("unset");
    s = play(s, "c3");
    // 先手の 2 手目: もう指定できない
    expect(() => play(s, "b3", "fu", true)).toThrow("王はもう指定できません");
    expect(kingInfo(s, 0).cell).toEqual([2, 3]);
  });

  it("期限の手までに指定しなければ、期限の手で置いた駒が自動で王になる", () => {
    let s = createGame(KING({ deadline: 3 }));
    const moves: string[] = [];
    // 先手・後手とも王を指定せずに 3 手ずつ打つ（合法手の先頭）
    for (let i = 0; i < 6; i++) {
      const p = s.turn;
      const info = kingInfo(s, p);
      expect(info.forcedNow).toBe(info.nextMove === 3);
      const [r, c] = legalCells(s, "fu")[0];
      if (p === 0) moves.push(`${"abcdefgh"[c]}${r + 1}`);
      s = playMove(s, r, c, "fu");
      if (info.nextMove < 3) expect(kingInfo(s, p).status).toBe("unset");
    }
    expect(kingInfo(s, 0)).toMatchObject({ status: "hidden", auto: true, canDesignate: false });
    expect(names([kingInfo(s, 0).cell!])).toEqual([moves[2]]);
    expect(kingInfo(s, 1)).toMatchObject({ status: "hidden", auto: true });
    // 棋譜には指定の記録を残さない（相手に見えないため）
    expect(JSON.stringify(s.history)).not.toContain("auto");
  });

  it("期限 1 手: 最初に置く駒が王。期限を過ぎたら指定できない", () => {
    let s = createGame(KING({ deadline: 1 }));
    expect(kingInfo(s, 0)).toMatchObject({ canDesignate: true, forcedNow: true });
    s = play(s, "d3");
    expect(kingInfo(s, 0)).toMatchObject({ status: "hidden", cell: [2, 3], auto: true });
    s = play(s, "c3", "fu", true); // 後手は自分で指定（期限の手なので同じ結果）
    expect(kingInfo(s, 1)).toMatchObject({ status: "hidden", cell: [2, 2], auto: false });
  });

  it("隠し王なしでは指定できず、状態も変わらない", () => {
    let s = createGame(rulesOf("orig"));
    expect(kingInfo(s, 0)).toMatchObject({ status: "off", canDesignate: false });
    expect(() => play(s, "d3", "fu", true)).toThrow("王はもう指定できません");
    for (let i = 0; i < 10 && !s.result; i++) {
      const [r, c] = legalCells(s, "fu")[0];
      s = playMove(s, r, c, "fu");
    }
    expect(s.kings).toEqual(createGame(rulesOf("orig")).kings);
    expect(s.history.some((e) => e.type === "move" && "king" in e)).toBe(false);
    expect(kingCandidates(s, 0)).toEqual([]);
  });
});

describe("隠し王: 王を返したときの罰と公開", () => {
  it("王を指定した手の駒が即返される: 通常のダメージ＋体力−20。王は公開され、候補もなくなる", () => {
    let s = row1(KING());
    s = play(s, "e1", "fu", true);
    expect(kingInfo(s, 1).cell).toEqual(at("e1"));
    expect(names(kingCandidates(s, 1))).toEqual(["e1"]);
    s = play(s, "f1");
    const m = lastMoveOf(s)!;
    expect(m.damage).toBe(3);
    expect(m.king).toEqual({ r: 0, c: 4, kind: "fu", penalty: 20, lose: false });
    expect(s.hp).toEqual([40 - 1, 40 - 3 - 20]);
    expect(s.result).toBeNull();
    expect(kingInfo(s, 1)).toMatchObject({ status: "revealed", cell: null, canDesignate: false });
    expect(kingRevealed(s, 1)).toBe(true);
    expect(kingCandidates(s, 1)).toEqual([]);
  });

  it("返された王は以後ふつうの駒（同じ駒をもう一度返しても罰はない。王の選び直しもない）", () => {
    let s = play(row1(KING()), "e1", "fu", true);
    s = play(s, "f1"); // 王を返す
    // e1（後手の元・王）が後手の駒に戻った局面を作り、先手がもう一度返す（王の状態は引き継ぐ）
    const again: GameState = {
      ...s,
      board: boardOf({ d1: [0, 1], e1: [1, 1], h8: [1, 1] }),
      turn: 0,
      hands: [{ fu: 3, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 }, { fu: 3, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 }],
    };
    const n = play(again, "f1");
    expect(lastMoveOf(n)!.targets.map((t) => [t.r, t.c])).toEqual([at("e1")]);
    expect(lastMoveOf(n)!.king).toBeUndefined();
    expect(n.hp[1]).toBe(again.hp[1] - 1);
    // 後手は王を選び直せない
    expect(kingInfo(n, 1).canDesignate).toBe(false);
  });

  it("罰が即負けなら、王を返した時点で勝ち（体力は通常のダメージだけ減る）", () => {
    let s = play(row1(KING({ penalty: "lose" })), "e1", "fu", true);
    s = play(s, "f1");
    expect(s.result).toEqual({ winner: 0, reason: "king", byDiscs: false });
    expect(s.hp).toEqual([39, 37]);
    expect(lastMoveOf(s)!.king).toMatchObject({ penalty: 0, lose: true });
  });

  it("罰で体力 0 以下になったら即終局（体力 0 の負け）", () => {
    let s = play(row1(KING(), [40, 23]), "e1", "fu", true);
    s = play(s, "f1");
    expect(s.hp[1]).toBe(0);
    expect(s.result).toEqual({ winner: 0, reason: "ko", byDiscs: false });
  });

  it("王でない駒を返しても罰はない", () => {
    let s = play(row1(KING()), "e1"); // 王にしない
    s = play(s, "f1");
    expect(lastMoveOf(s)!.king).toBeUndefined();
    expect(s.hp[1]).toBe(37);
  });

  it("強さ制限あり・王が飛: 飛より小さい駒では王を返せず、飛なら返せて罰が入る", () => {
    const rules = KING({}, { gate: true });
    const base = stateOf(boardOf({ b1: [0, 1], c1: [1, 1], d1: [0, 1] }), {
      rules,
      turn: 1,
      hands: [{ fu: 2, hi: 1 }, { hi: 1 }],
    });
    const s = play(base, "e1", "hi", true);
    expect(kingInfo(s, 1).cell).toEqual(at("e1"));
    // 歩では e1（飛）を含む列は返せない
    expect(() => play(s, "f1", "fu")).toThrow();
    const n = play(s, "f1", "hi");
    expect(lastMoveOf(n)!.king).toMatchObject({ kind: "hi", penalty: 20 });
    expect(n.hp[1]).toBe(40 - (5 + 1 + 1) - 20);
  });

  it("取るルール: 王を取ったら罰。取った王は持ち駒（ふつうの駒）になる", () => {
    const rules = rulesOf("v10", { king: king() });
    let s = stateOf(boardOf({ c1: [0, 1], h8: [0, 1] }), { rules, turn: 1, hands: [{ fu: 1 }, { kin: 1, fu: 1 }] });
    s = play(s, "c2", "kin", true); // 後手の王（金）。挟まれる位置に自分から置いても取られない
    const n = play(s, "c3"); // 先手が c3 に置いて c2 を挟んで取る
    expect(lastMoveOf(n)!.king).toMatchObject({ r: 1, c: 2, kind: "kin", penalty: 20 });
    expect(n.board[1][2]).toBeNull();
    expect(n.hands[0].kin).toBe(1);
    expect(n.hp[1]).toBe(20 - 3 - 20);
    expect(n.result).toEqual({ winner: 0, reason: "ko", byDiscs: false });
  });
});

describe("隠し王: 候補（公開情報）と CPU の視点", () => {
  it("候補 = 期限内に置き、まだ一度も返されていない駒。期限内の途中でも、それまでに置いた駒を候補にする", () => {
    let s = createGame(KING({ deadline: 2 }));
    s = play(s, "d3"); // 先手 1 手目
    expect(names(kingCandidates(s, 0))).toEqual(["d3"]);
    s = play(s, "c3"); // 後手 1 手目（d4 を返す。d3 は返していない）
    s = play(s, "b3"); // 先手 2 手目（期限）
    expect(names(kingCandidates(s, 0))).toEqual(["b3", "d3"]);
    // 期限を過ぎた手は候補に入らない
    const moves = legalCells(s, "fu");
    s = playMove(s, moves[0][0], moves[0][1], "fu"); // 後手 2 手目
    const before = names(kingCandidates(s, 0));
    const [r, c] = legalCells(s, "fu")[0];
    s = playMove(s, r, c, "fu"); // 先手 3 手目
    expect(names(kingCandidates(s, 0)).every((x) => before.includes(x))).toBe(true);
    // 返された駒は候補から外れる
    const flipped = s.history.filter((e) => e.type === "move" && e.player === 1).flatMap((e) => (e.type === "move" ? e.targets : []));
    for (const t of flipped) expect(kingCandidates(s, 0).some(([y, x]) => y === t.r && x === t.c)).toBe(false);
  });

  it("CPU 用の視点には相手の王の正体がない（王の場所だけが違う 2 局面で視点が同じ → CPU の手も同じ）", () => {
    // 後手が 3 手打ち、王を 2 手目にした局面と 3 手目にした局面
    const run = (kingAt: number) => {
      let s = createGame(rulesOf("king"));
      const seq = ["d3", "c3", "c4", "e3"];
      seq.forEach((name, i) => (s = play(s, name, "fu", i === kingAt)));
      return s;
    };
    const a = run(1); // 後手 1 手目 c3
    const b = run(3); // 後手 2 手目 e3
    expect(kingInfo(a, 1).cell).not.toEqual(kingInfo(b, 1).cell);
    const va = viewFor(a, 0);
    const vb = viewFor(b, 0);
    expect("kings" in va).toBe(false);
    expect(va).toEqual(vb);
    expect(names(va.oppKing.candidates)).toEqual(["c3", "e3"]);
    expect(chooseLookahead(va, rng(7))).toEqual(chooseLookahead(vb, rng(7)));
    // 自分の視点には自分の王だけが入る
    expect(viewFor(a, 1).myKing.cell).toEqual(at("c3"));
    expect(viewFor(b, 1).myKing.cell).toEqual(at("e3"));
  });

  it("UI と CPU のコードは GameState.kings を直接読まない（kingInfo / viewFor を通す）", () => {
    const sources = import.meta.glob(["../src/ui/*.ts", "../src/engine/cpu.ts"], { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(6);
    for (const [f, src] of Object.entries(sources)) expect(src as string, f).not.toMatch(/[\w)\]]\.kings\b/);
  });
});

describe("隠し王: CPU", () => {
  it("同じダメージなら、相手の王の候補を返す手を選ぶ（罰 × 返す候補 ÷ 候補の数）", () => {
    // b1 は後手が期限内に置いた駒（候補）、b8 は候補でない。c1・c8 はどちらも歩 1 枚を返し、相手の応手は 0
    const base = stateOf(boardOf({ a1: [0, 1], b1: [1, 1], a8: [0, 1], b8: [1, 1] }), { rules: KING(), hands: [{ fu: 2 }, { fu: 2 }] });
    const s: GameState = {
      ...base,
      history: [{ type: "move", ply: 1, player: 1, r: 0, c: 1, kind: "fu", targets: [], damage: 0, heal: 0 }],
    };
    expect(names(viewFor(s, 0).oppKing.candidates)).toEqual(["b1"]);
    expect(lookaheadCandidates(viewFor(s, 0))).toEqual({ best: 1 + 20, cands: [{ r: 0, c: 2, kind: "fu" }] });
    // 候補が 2 つなら罰の期待値は半分
    const two: GameState = {
      ...s,
      history: [...s.history, { type: "move", ply: 2, player: 1, r: 7, c: 1, kind: "fu", targets: [], damage: 0, heal: 0 }],
    };
    expect(lookaheadCandidates(viewFor(two, 0)).best).toBe(1 + 10);
    // 隠し王なしなら同点
    expect(lookaheadCandidates(viewFor({ ...s, rules: rulesOf("orig", { heal: "none" }) }, 0)).cands).toHaveLength(2);
  });

  it("自分の王が次に返されうる手を避ける（相手の応手に罰を足す）", () => {
    // 先手の王 a2 は a3 が空いていると後手に返される。a3 に置けば（b3 を返して）塞げる。h5 も 1 枚返す手
    const board = boardOf({ a1: [1, 1], a2: [0, 1], a4: [0, 1], a5: [0, 1], a6: [0, 1], a7: [0, 1], a8: [0, 1], b3: [1, 1], c3: [0, 1], h3: [0, 1], h4: [1, 1] });
    const base = stateOf(board, { rules: KING(), hands: [{ fu: 3 }, { fu: 3 }] });
    const withKing: GameState = { ...base, kings: [{ cell: at("a2"), auto: false, revealed: false }, base.kings[1]] };
    const key = (cs: { r: number; c: number }[]) => names(cs.map((x) => [x.r, x.c] as const));
    expect(key(lookaheadCandidates(viewFor(base, 0)).cands)).toContain("h5");
    const { cands } = lookaheadCandidates(viewFor(withKing, 0));
    expect(key(cands)).toContain("a3");
    expect(key(cands)).not.toContain("h5");
  });

  it("CPU 同士: 期限までに必ず王を決め、決める手はランダムにばらける。合法手だけで終局する", () => {
    const rules = rulesOf("king");
    const turns: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      let s = createGame(rules);
      while (!s.result) {
        const p = s.turn;
        const before = kingInfo(s, p);
        const ch = chooseLookahead(viewFor(s, p), rand)!;
        expect(legalCells(s, ch.kind).some(([r, c]) => r === ch.r && c === ch.c)).toBe(true);
        if (ch.king) expect(before.canDesignate).toBe(true);
        s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
        const after = kingInfo(s, p);
        if (before.status === "unset" && after.status !== "unset") {
          turns.push(before.nextMove);
          // CPU は自分で指定する（期限の手でも king: true を渡す）
          expect(after.auto).toBe(false);
        }
        if (before.nextMove >= rules.king.deadline) expect(after.status).not.toBe("unset");
      }
    }
    expect(turns.length).toBeGreaterThanOrEqual(20);
    expect(new Set(turns).size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...turns)).toBeLessThanOrEqual(5);
  });
});
