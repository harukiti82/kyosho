// 着手の手応えのテスト: 段階の判定（閾値の境界・受けた側の体力上限で割る・王を返した手）、内訳、成績の集計、演出の長さ

import { describe, expect, it } from "vitest";
import type { GameEvent, MoveEvent } from "../src/engine/game";
import { createGame, lastMoveOf, playMove } from "../src/engine/game";
import type { RuleSet } from "../src/engine/rules";
import { fxTiming, MAX_HOLD_MS } from "../src/ui/fx";
import { hitOf, shownHp, statsOf, TIER_THRESHOLDS, tierOf, tierText } from "../src/ui/impact";
import { boardOf, rulesOf, stateOf } from "./helpers";

/** 先手（player 0）が後手を攻めた手 */
function move(patch: Partial<MoveEvent> = {}): MoveEvent {
  return { type: "move", ply: 1, player: 0, r: 0, c: 0, kind: "fu", targets: [{ r: 0, c: 1, kind: "fu" }], damage: 0, heal: 0, ...patch };
}

/** 体力 [先手, 後手] だけ変えたルール */
const hpRules = (hp: [number, number]): RuleSet => rulesOf("orig", { hp });

describe("段階の判定", () => {
  const r = hpRules([100, 100]);
  it.each([
    [0, "small"],
    [4, "small"],
    [5, "mid"],
    [9, "mid"],
    [10, "big"],
    [19, "big"],
    [20, "huge"],
    [60, "huge"],
  ] as const)("体力 100 に %i ダメージ → %s", (damage, tier) => {
    expect(tierOf(r, move({ damage }))).toBe(tier);
  });

  it("閾値は 1 か所の定数（5% / 10% / 20%）", () => {
    expect(TIER_THRESHOLDS).toEqual({ mid: 0.05, big: 0.1, huge: 0.2 });
  });

  it("割る体力は受けた側の上限（攻めた側・現在の体力ではない）", () => {
    // 先手 20・後手 200: 先手が 10 与えても後手には 5% → 中。後手が 10 与えると先手には 50% → 特大
    const r2 = hpRules([20, 200]);
    expect(tierOf(r2, move({ player: 0, damage: 10 }))).toBe("mid");
    expect(tierOf(r2, move({ player: 1, damage: 10 }))).toBe("huge");
  });

  it("端の駒の上乗せと隠し王の罰も合計に入る", () => {
    const anchor = rulesOf("anchor", { hp: [100, 100] });
    // 返した駒 1 ＋ 端の金5 ＝ 6 → 中
    const m = move({ damage: 6, anchors: [{ r: 0, c: 2, kind: "kin" }] });
    expect(hitOf(anchor, m)).toEqual({ total: 6, base: 1, anchor: 5, penalty: 0 });
    expect(tierOf(anchor, m)).toBe("mid");
    // 罰だけでも合計に入る（王の手は特大だが、内訳としての合計を確かめる）
    expect(hitOf(anchor, move({ damage: 3, king: { r: 0, c: 1, kind: "fu", penalty: 20, lose: false } })).total).toBe(23);
  });

  it("王を返した手はダメージが小さくても特大（即負けの罰でも）", () => {
    const king = { r: 0, c: 1, kind: "fu" as const, penalty: 0, lose: true };
    expect(tierOf(r, move({ damage: 1, king }))).toBe("huge");
    expect(tierText("huge", move({ damage: 1, king }), "attack")).toBe("王を討った！");
    expect(tierText("huge", move({ damage: 1, king }), "hurt")).toBe("王を討たれた！");
  });

  it("文言は段階ごとに 1 つ。小はなし", () => {
    expect(tierText("small", move(), "attack")).toBeNull();
    expect(tierText("mid", move(), "attack")).toBe("ナイス！");
    expect(tierText("big", move(), "attack")).toBe("会心！");
    expect(tierText("huge", move(), "attack")).toBe("痛恨！");
  });

  it("実際の着手（エンジンの棋譜）でも判定できる: v1.0 の体力 20 に歩1 を 1 枚取る → 5% で中", () => {
    const s0 = createGame(rulesOf("v10"));
    // d3 に歩を置くと d4 の後手の歩を取る（初期配置）
    const s1 = playMove(s0, 2, 3, "fu");
    const m = lastMoveOf(s1)!;
    expect(m.damage).toBe(1);
    expect(tierOf(s1.rules, m)).toBe("mid");
  });
});

describe("成績の集計", () => {
  const r = rulesOf("anchor", { hp: [100, 100] });
  const kingHit = { r: 3, c: 3, kind: "kin" as const, penalty: 20, lose: false };
  const history: GameEvent[] = [
    move({ ply: 1, player: 0, damage: 3 }),
    move({ ply: 2, player: 1, damage: 12 }),
    // 上乗せ 5 を含む 11 → 会心（big）
    move({ ply: 3, player: 0, damage: 11, anchors: [{ r: 0, c: 2, kind: "kin" }] }),
    { type: "pass", player: 1, reason: "noMoves" },
    // 同じ 11 でも先の手を最大とする。王の罰 20 で合計 31
    move({ ply: 4, player: 0, damage: 11, anchors: [{ r: 0, c: 3, kind: "hi" }, { r: 1, c: 3, kind: "fu" }], king: kingHit }),
    move({ ply: 5, player: 1, damage: 4 }),
  ];
  const [p0, p1] = statsOf({ rules: r, history });

  it("最大ダメージは罰を含む合計で選び、内訳を持つ", () => {
    expect(p0.best?.move.ply).toBe(4);
    expect(p0.best?.hit).toEqual({ total: 31, base: 7, anchor: 4, penalty: 20 });
    expect(p1.best?.move.ply).toBe(2);
    expect(p1.best?.hit.total).toBe(12);
  });

  it("会心（大）以上の回数・上乗せの合計・王を返したか", () => {
    // 先手: 11（大）と王の手（特大）で 2 回。後手: 12（大）で 1 回
    expect([p0.bigHits, p1.bigHits]).toEqual([2, 1]);
    expect([p0.anchorTotal, p1.anchorTotal]).toEqual([5 + 4, 0]);
    expect([p0.kingHit, p1.kingHit]).toEqual([true, false]);
  });

  it("ダメージを与えていなければ最大ダメージはなし", () => {
    const [a, b] = statsOf({ rules: r, history: [move({ damage: 0, targets: [] })] });
    expect(a).toEqual({ best: null, bigHits: 0, anchorTotal: 0, kingHit: false });
    expect(b.best).toBeNull();
  });

  it("同じ最大ダメージが複数あれば早い手", () => {
    const [a] = statsOf({ rules: r, history: [move({ ply: 1, damage: 7 }), move({ ply: 3, damage: 7 })] });
    expect(a.best?.move.ply).toBe(1);
  });

  it("実際の盤面: 1 手で体力 0 にした手も成績に入る", () => {
    const board = boardOf({ a2: [1, 5], a3: [1, 5], a4: [0, 3], h8: [1, 1] });
    const s = stateOf(board, { rules: rulesOf("orig", { hp: [40, 8] }), hands: [{ fu: 1 }, { fu: 1 }] });
    const end = playMove(s, 0, 0, "fu");
    expect(end.result?.reason).toBe("ko");
    const m = lastMoveOf(end)!;
    expect(tierOf(end.rules, m)).toBe("huge");
    expect(statsOf(end)[0].best?.hit.total).toBe(10);
  });
});

describe("演出の長さ", () => {
  it("小・中は待たせない（CPU の待ち時間に収める）", () => {
    expect(fxTiming("small", 3, false).hold).toBe(0);
    expect(fxTiming("mid", 3, false).hold).toBe(0);
  });

  it("特大は駒を順にめくってから弾ける。待たせるのは最大 1.5 秒", () => {
    for (const n of [1, 2, 5, 12, 30]) {
      const t = fxTiming("huge", n, false);
      expect(t.burstAt).toBeLessThanOrEqual(700);
      expect(t.hold).toBeLessThanOrEqual(MAX_HOLD_MS);
      expect(t.hold).toBeGreaterThan(t.burstAt);
    }
    expect(fxTiming("huge", 5, false).step).toBeGreaterThan(0);
    expect(fxTiming("big", 5, false)).toMatchObject({ step: 0, burstAt: 0 });
  });

  it("動きを減らす設定では溜めを省く", () => {
    expect(fxTiming("huge", 8, true)).toMatchObject({ step: 0, burstAt: 0 });
    expect(fxTiming("big", 8, true).hold).toBeLessThanOrEqual(MAX_HOLD_MS);
  });
});

describe("画面に出す体力", () => {
  it("決着の一手で 0 を下回った体力は 0 と出し、0 以上はそのまま", () => {
    expect(shownHp(-2)).toBe(0);
    expect(shownHp(-35)).toBe(0);
    expect(shownHp(0)).toBe(0);
    expect(shownHp(129)).toBe(129);
  });
});
