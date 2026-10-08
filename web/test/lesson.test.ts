// チュートリアルの局面と判定: 各ステップの正解がエンジンで打てて、教えたい結果（ダメージ・勝ち・上乗せ・回復・王）になること、
// 違う手ではヒントが出ること、誘導の印が局面と合うこと、進み具合の保存が壊れていても始められること。

import { describe, expect, it } from "vitest";
import { cellName, othelloCells, parseCell } from "../src/engine/board";
import {
  gameFrom,
  isLegal,
  kingInfo,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
  threatenedPieces,
  type GameState,
} from "../src/engine/game";
import { kindsByValue, presetById, sameRules, type PieceKind } from "../src/engine/rules";
import type { KeyValueStore } from "../src/net/online";
import {
  illegalHint,
  judgeMove,
  KING_HINT,
  LESSONS,
  loadProgress,
  nextNeed,
  progressAt,
  progressLabel,
  resumeStep,
  saveProgress,
  TUTORIAL_KEY,
  type Lesson,
  type LessonId,
} from "../src/ui/lessons";

const lesson = (id: LessonId) => LESSONS.find((l) => l.id === id)!;
const steps = LESSONS.filter((l) => !l.match);

/** 正解の手を打った後の局面と棋譜の手 */
function solve(l: Lesson) {
  const g = l.start();
  const a = l.answers[0];
  const next = playMove(g, a.at[0], a.at[1], a.kind, { king: a.king });
  return { g, next, m: lastMoveOf(next)! };
}

/** 画面が最初に選ぶ駒（置ける駒のうち数字の小さいもの。App.kindFor と同じ） */
const firstKind = (g: GameState): PieceKind => kindsByValue(g.rules, playableKinds(g))[0];

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe("gameFrom（指定した局面から始める）", () => {
  it("駒・持ち駒・体力・王を指定でき、手数 0・棋譜なしで始まる", () => {
    const r = presetById("std").rules;
    const g = gameFrom(r, {
      stones: [{ at: parseCell("c8"), owner: 0, kind: "fu" }, { at: parseCell("c7"), owner: 1, kind: "kin" }],
      hands: [{ fu: 2, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 }, { fu: 1, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 }],
      hp: [50, 6],
      kings: [parseCell("c8"), null],
    });
    expect(g.ply).toBe(0);
    expect(g.history).toEqual([]);
    expect(g.hp).toEqual([50, 6]);
    expect(g.turn).toBe(0);
    expect(g.board[7][2]).toEqual({ owner: 0, kind: "fu" });
    expect(kingInfo(g, 0)).toMatchObject({ status: "hidden", cell: [7, 2], canDesignate: false });
    expect(kingInfo(g, 1)).toMatchObject({ status: "unset", canDesignate: true });
    // 渡した持ち駒を書き換えない
    const next = playMove(g, 5, 2, "fu");
    expect(next.hands[0].fu).toBe(1);
    expect(g.hands[0].fu).toBe(2);
  });

  it("同じマス・盤の外・持ち主の駒がない王・隠し王なしでの王の指定は例外", () => {
    const r = presetById("std").rules;
    const fu = { owner: 0 as const, kind: "fu" as const };
    expect(() => gameFrom(r, { stones: [{ at: [0, 0], ...fu }, { at: [0, 0], ...fu }] })).toThrow();
    expect(() => gameFrom(r, { stones: [{ at: [8, 0], ...fu }] })).toThrow();
    expect(() => gameFrom(r, { stones: [{ at: [0, 0], ...fu }], kings: [null, [0, 0]] })).toThrow();
    expect(() => gameFrom(presetById("dir").rules, { stones: [{ at: [0, 0], ...fu }], kings: [[0, 0], null] })).not.toThrow();
    expect(() => gameFrom(presetById("v10").rules, { stones: [{ at: [0, 0], ...fu }], kings: [[0, 0], null] })).toThrow();
  });

  it("parseCell は cellName の逆", () => {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) expect(parseCell(cellName(r, c))).toEqual([r, c]);
    expect(() => parseCell("i1")).toThrow();
    expect(() => parseCell("a9")).toThrow();
  });
});

describe("チュートリアルの各ステップ", () => {
  it("標準ルールの要素を易しい順に足し、最後は標準の実戦", () => {
    expect(LESSONS.map((l) => l.id)).toEqual(["flank", "damage", "dirs", "hand", "anchor", "heal", "king", "kingHit", "read", "match"]);
    const std = presetById("std").rules;
    expect(sameRules(lesson("match").rules, std)).toBe(true);
    expect(sameRules(lesson("read").rules, std)).toBe(true);
    expect(lesson("flank").rules).toMatchObject({ dirs: "all", anchor: "none", heal: "none", king: { on: false } });
    expect(lesson("dirs").rules.dirs).toBe("piece");
    expect(lesson("anchor").rules.anchor).toBe("attack");
    expect(lesson("heal").rules.heal).toBe("lowMinus1");
    expect(lesson("king").rules.king).toEqual(std.king);
    // 目標は 1〜2 文で短く
    for (const l of LESSONS) {
      expect(l.goal.length, l.id).toBeGreaterThan(0);
      expect(l.goal.split("。").filter(Boolean).length, l.id).toBeLessThanOrEqual(2);
    }
  });

  for (const l of steps) {
    it(`${l.title}: 先手の手番で始まり、正解は打てる手で、誘導するマスは打てるマス`, () => {
      const g = l.start();
      expect(g.turn).toBe(0);
      expect(g.result).toBeNull();
      expect(l.answers.length).toBeGreaterThan(0);
      for (const a of l.answers) expect(isLegal(g, a.at[0], a.at[1], a.kind), `${l.id} ${cellName(...a.at)}`).toBe(true);
      for (const [r, c] of l.guide) expect(g.board[r][c], `${l.id} ${cellName(r, c)}`).toBeNull();
      // 誘導するマスはどれも、持ち駒のどれかで打てる（光っているのに置けないマスを作らない）
      for (const [r, c] of l.guide) expect(playableKinds(g).some((k) => isLegal(g, r, c, k)), `${l.id} ${cellName(r, c)}`).toBe(true);
      for (const a of l.answers) expect(l.guide.some(([r, c]) => r === a.at[0] && c === a.at[1])).toBe(true);
      expect(judgeMove(l, g, { r: l.answers[0].at[0], c: l.answers[0].at[1], kind: l.answers[0].kind, king: !!l.answers[0].king })).toBeNull();
    });
  }

  it("「予測を読む」より前のステップは、始めの局面で自分の駒に「!」が出ない（警告を習う前に気を散らさない）", () => {
    for (const l of steps.slice(0, steps.indexOf(lesson("read")))) expect(threatenedPieces(l.start(), 0), l.id).toEqual([]);
  });

  it("挟む: 歩で 2 つ裏返す。ほかに置けるマスはない", () => {
    const { g, m } = solve(lesson("flank"));
    expect(legalCells(g, "fu").map(([r, c]) => cellName(r, c))).toEqual(["d5"]);
    expect(m.targets).toHaveLength(2);
    expect(lesson("flank").done(m, g)).toBe("相手の歩 2 つを挟んで、自分の駒に裏返した。");
  });

  it("ダメージ: 正解は 6 ダメージで相手の体力が 0 になって勝ち。もう一方は 2 ダメージでヒント", () => {
    const l = lesson("damage");
    const { g, next, m } = solve(l);
    expect(g.hp[1]).toBe(6);
    expect(m.damage).toBe(6);
    expect(next.result).toEqual({ winner: 0, reason: "ko", byDiscs: false });
    expect(l.done(m, g)).toBe("歩1＋金5で 6 ダメージ。相手の体力が 0 になって勝ち。");
    expect(judgeMove(l, g, { r: 4, c: 1, kind: "fu", king: false })).toBe("そこは 2 ダメージ。マスに触れると、置く前に数字が出る。");
  });

  it("駒の向き: 正解のマスは点線の枠（オセロなら置ける）で、最初に選ばれる歩では置けず、飛なら置ける", () => {
    const l = lesson("dirs");
    const g = l.start();
    const e4 = parseCell("e4");
    expect(firstKind(g)).toBe("fu");
    expect(isLegal(g, e4[0], e4[1], "fu")).toBe(false);
    expect(othelloCells(g.board, 0)).toContainEqual(e4);
    // 歩のまま押した・飛で違うマスに置いた
    expect(illegalHint(l, g, { r: e4[0], c: e4[1], kind: "fu", king: false })).toBe("歩は↕ 縦（上下）にしか挟めない。駒台で飛を選んでから置こう。");
    expect(judgeMove(l, g, { r: 5, c: 6, kind: "hi", king: false })).toBe("光っているマスに、飛で横に挟もう。");
    expect(nextNeed(l, "fu", false)).toEqual({ kind: "hi" });
    expect(nextNeed(l, "hi", false)).toEqual({});
    expect(solve(l).m.targets).toHaveLength(2);
  });

  it("持ち駒: 残り 1 つの金で 3 方向まとめて返し、金が 0 になる", () => {
    const l = lesson("hand");
    const { g, next, m } = solve(l);
    expect(g.hands[0].kin).toBe(1);
    expect(m.targets).toHaveLength(3);
    expect(next.hands[0].kin).toBe(0);
    // 同じマスに歩でも置けるが、正解は金
    expect(isLegal(g, 2, 2, "fu")).toBe(true);
    expect(judgeMove(l, g, { r: 2, c: 2, kind: "fu", king: false })).toBe("歩は↕ 縦（上下）にしか挟めない。駒台で金を選んでから置こう。");
  });

  it("端の駒: 正解は 返した歩1 ＋ 端の金5 ＝ 6。もう一方は端が歩で 2", () => {
    const l = lesson("anchor");
    const { g, m } = solve(l);
    expect(m.damage).toBe(6);
    expect(m.anchors).toEqual([{ r: 7, c: 3, kind: "kin" }]);
    expect(l.done(m, g)).toBe("返した歩1に端の金5が足されて、6 ダメージ。");
    expect(judgeMove(l, g, { r: 5, c: 6, kind: "fu", king: false })).toBe("そこは端が歩1で 2 ダメージ。金を端にできるマスへ。");
  });

  it("回復: 飛3 と端の金5 で挟むと 2 回復。歩で金を挟むと回復 0 でヒント", () => {
    const l = lesson("heal");
    const { g, next, m } = solve(l);
    expect(m.heal).toBe(2);
    expect(next.hp[0]).toBe(g.hp[0] + 2);
    expect(l.done(m, g)).toBe("飛3と端の金5で挟んで、体力が 2 回復した。");
    expect(previewMove(g, 5, 6, "fu")?.heal).toBe(0);
    expect(judgeMove(l, g, { r: 5, c: 6, kind: "fu", king: false })).toContain("回復 0");
    expect(firstKind(g)).toBe("fu");
    expect(nextNeed(l, "fu", false)).toEqual({ kind: "hi" });
  });

  it("王を決める: 王にしないで置くとヒント。王にして置くと自分の王になる", () => {
    const l = lesson("king");
    const g = l.start();
    expect(kingInfo(g, 0)).toMatchObject({ canDesignate: true, forcedNow: false });
    expect(judgeMove(l, g, { r: 5, c: 4, kind: "fu", king: false })).toBe(KING_HINT);
    expect(nextNeed(l, "fu", false)).toEqual({ king: true });
    expect(nextNeed(l, "fu", true)).toEqual({});
    const { next, m } = solve(l);
    expect(kingInfo(next, 0)).toMatchObject({ status: "hidden", cell: [5, 4], auto: false });
    expect(l.done(m, g)).toBe("この歩1があなたの王になった（相手には見えず、返されると体力−30）。");
    expect(l.goal).toContain("最初の 7 手");
  });

  it("王を返す: 「?」の金が相手の王で、返すと 6 ダメージ＋体力−30", () => {
    const l = lesson("kingHit");
    const { g, next, m } = solve(l);
    expect(l.marks?.map((x) => cellName(...x.at))).toEqual(["c7"]);
    expect(kingInfo(g, 0).status).toBe("hidden");
    expect(m.king).toMatchObject({ r: 6, c: 2, kind: "kin", penalty: 30, lose: false });
    expect(next.hp[1]).toBe(g.hp[1] - m.damage - 30);
    expect(l.done(m, g)).toBe("相手の王を返して、6 ダメージに −30 が上乗せされた。");
    expect(l.goal).toContain("体力−30");
  });

  it("予測を読む: 大きいダメージのマスは置いた駒が次に返され、正解のマスは返されない。点線だけのマスもある", () => {
    const l = lesson("read");
    const { g, m } = solve(l);
    const [bad, good] = [parseCell("d6"), parseCell("g6")];
    const pb = previewMove(g, bad[0], bad[1], "fu")!;
    const pg = previewMove(g, good[0], good[1], "fu")!;
    expect(pb.damage).toBeGreaterThan(pg.damage);
    expect(pb.exposed).toContainEqual(bad);
    expect(pg.exposed).not.toContainEqual(good);
    expect(judgeMove(l, g, { r: bad[0], c: bad[1], kind: "fu", king: false })).toContain("返される");
    expect(m.damage).toBe(pg.damage);
    expect(l.done(m, g)).toBe(`置いた駒を返されない手で、${pg.damage} ダメージ。`);
    // 王は決まっている（王の駒の操作を出さない）
    expect(kingInfo(g, 0).canDesignate).toBe(false);
    // 普通のオセロなら置けるが、持ち駒では置けないマス
    const legal = new Set(legalCells(g, "fu").map(([r, c]) => cellName(r, c)));
    expect(othelloCells(g.board, 0).map(([r, c]) => cellName(r, c)).filter((n) => !legal.has(n))).toContain("c4");
  });

  it("実戦は標準の初期局面", () => {
    const g = lesson("match").start();
    expect(g.ply).toBe(0);
    expect(sameRules(g.rules, presetById("std").rules)).toBe(true);
  });
});

describe("進み具合の保存", () => {
  it("保存がない・壊れている・範囲外なら はじめて（null）", () => {
    expect(loadProgress(memStore())).toBeNull();
    expect(loadProgress(memStore({ [TUTORIAL_KEY]: "{" }))).toBeNull();
    expect(loadProgress(memStore({ [TUTORIAL_KEY]: "[]" }))).toBeNull();
    expect(loadProgress(memStore({ [TUTORIAL_KEY]: JSON.stringify({ step: 99 }) }))).toBeNull();
    expect(loadProgress(memStore({ [TUTORIAL_KEY]: JSON.stringify({ step: 1.5 }) }))).toBeNull();
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    // ストレージが使えない（読むと例外）ときも はじめて として始める
    expect(loadProgress(throwing)).toBeNull();
  });

  it("保存して読み戻せる。reached は step より小さくならない", () => {
    const s = memStore();
    saveProgress(s, progressAt(null, 3));
    expect(loadProgress(s)).toEqual({ step: 3, reached: 3, done: false });
    saveProgress(s, progressAt(loadProgress(s), 1));
    expect(loadProgress(s)).toEqual({ step: 1, reached: 3, done: false });
    s.data[TUTORIAL_KEY] = JSON.stringify({ step: 4, reached: 2, done: "yes" });
    expect(loadProgress(s)).toEqual({ step: 4, reached: 4, done: false });
  });

  it("メニューの表示と再開の位置", () => {
    expect(progressLabel(null)).toBe("はじめての方に");
    expect(progressLabel({ step: 3, reached: 3, done: false })).toBe(`つづき 4/${LESSONS.length}`);
    expect(progressLabel({ step: 9, reached: 9, done: true })).toBe("クリア済み");
    expect(resumeStep(null)).toBe(0);
    expect(resumeStep({ step: 3, reached: 5, done: false })).toBe(3);
    expect(resumeStep({ step: 9, reached: 9, done: true })).toBe(0);
  });
});
