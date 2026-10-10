import { describe, expect, it } from "vitest";
import { lastMoveOf, playMove, setSkills, createGame, legalCells, playableKinds, type GameState, type MoveEvent } from "../src/engine/game";
import { gaugeMax, GAUGE_UNIT, isZone, type SkillsState, type SkillId } from "../src/engine/skills";
import { animDone, FULL_FLASH_MS, gainText, gaugeGains, growDelay, GROW_AT_MS, GROW_MS, ORB_MS, snapOf, zoneSources, type GaugeGain } from "../src/ui/gauge";
import { rulesOf } from "./helpers";

const U = GAUGE_UNIT;
const NO: [boolean, boolean] = [false, false];

function skills(cards: [SkillId | null, SkillId | null], gauge: [number, number], ready = true): SkillsState {
  return {
    sides: [
      { offer: [], card: cards[0], gauge: gauge[0] },
      { offer: [], card: cards[1], gauge: gauge[1] },
    ],
    ready,
    armed: null,
    shielded: [false, false],
  };
}

const move = (r: number, c: number, targets: [number, number][]): MoveEvent => ({
  type: "move",
  ply: 1,
  player: 0,
  r,
  c,
  kind: "fu",
  targets: targets.map(([tr, tc]) => ({ r: tr, c: tc, kind: "fu" })),
  damage: 0,
  heal: 0,
});

describe("ゲージが溜まった量（前回描いたゲージとの差）", () => {
  it("1 手進んだら人ごとの前後の値を返し、増えていない人は null", () => {
    const snap = snapOf(3, 4, skills(["strong", "wall"], [2 * U, 5 * U]), NO);
    const [a, b] = gaugeGains(snap, 3, 5, skills(["strong", "wall"], [6 * U, 5 * U]), NO);
    expect(a).toEqual({ from: 2 * U, to: 6 * U, max: gaugeMax("strong"), full: false });
    expect(b).toBeNull();
  });

  it("使えるようになった手だけ full。満タンでも使えない・前から使えた・満タンでない手は full でない", () => {
    const max = gaugeMax("firstaid");
    const snap = snapOf(1, 0, skills(["firstaid", "firstaid"], [max - U, max - 3 * U]), NO);
    const [a, b] = gaugeGains(snap, 1, 1, skills(["firstaid", "firstaid"], [max, max - U]), [true, false]);
    expect(a!.full).toBe(true);
    expect(b!.full).toBe(false);
    // 満タンになったが使えない（応急手当で体力が満タンなど）: 伸びるが光らない
    const [held] = gaugeGains(snap, 1, 1, skills(["firstaid", "firstaid"], [max, max - U]), NO);
    expect(held).toEqual({ from: max - U, to: max, max, full: false });
    // 前の手から使えた: 光らない（増えていなければ何も出さない）
    expect(gaugeGains(snapOf(1, 1, skills(["firstaid", null], [max, 0]), [true, false]), 1, 2, skills(["firstaid", null], [max, 0]), [true, false])).toEqual([null, null]);
  });

  it("満タンのまま使えない理由がなくなった手（補充で戻せる駒ができた・相手が王を決め終えたなど）は、増えていなくても光る", () => {
    const max = gaugeMax("refill");
    const snap = snapOf(4, 9, skills(["refill", "wall"], [max, 0]), NO);
    const [a, b] = gaugeGains(snap, 4, 10, skills(["refill", "wall"], [max, 0]), [true, false]);
    expect(a).toEqual({ from: max, to: max, max, full: true });
    expect(gainText(a!)).toBeNull();
    expect(zoneSources(move(2, 2, []), a)).toEqual([]);
    expect(b).toBeNull();
  });

  it("演出しない: 前回の描画がない・別の対局・2 手以上進んだ・戻った（待った）・減った（使って 0）・選び終える前", () => {
    const sk = skills(["strong", "wall"], [4 * U, 4 * U]);
    const snap = snapOf(2, 6, skills(["strong", "wall"], [U, U]), NO);
    expect(gaugeGains(null, 2, 7, sk, NO)).toEqual([null, null]);
    expect(gaugeGains(snap, 3, 7, sk, NO)).toEqual([null, null]);
    expect(gaugeGains(snap, 2, 8, sk, NO)).toEqual([null, null]);
    expect(gaugeGains(snap, 2, 5, sk, NO)).toEqual([null, null]);
    expect(gaugeGains(snap, 2, 6, sk, NO)).toEqual([null, null]);
    expect(gaugeGains(snapOf(2, 6, sk, NO), 2, 7, skills(["strong", "wall"], [0, 4 * U]), NO)).toEqual([null, null]);
    expect(gaugeGains(snap, 2, 7, skills(["strong", "wall"], [4 * U, 4 * U], false), NO)).toEqual([null, null]);
    expect(gaugeGains(snap, 2, 7, undefined, NO)).toEqual([null, null]);
  });

  it("「+N」は四捨五入した整数。1 に満たない微増は出さない", () => {
    const g = (from: number, to: number): GaugeGain => ({ from, to, max: 100 * U, full: false });
    expect(gainText(g(0, 7 * U))).toBe("+7");
    // 受けたダメージ 6 点 = 0.9 点 → +1、3 点 = 0.45 点 → 出さない、10 点 = 1.5 点 → +2
    expect(gainText(g(0, 18))).toBe("+1");
    expect(gainText(g(0, 9))).toBeNull();
    expect(gainText(g(0, 30))).toBe("+2");
    // 満タンで頭打ちになった分は、実際に増えた分だけ
    expect(gainText(g(19 * U + 11, 20 * U))).toBeNull();
    expect(gainText(g(17 * U + 11, 20 * U))).toBe("+2");
  });

  it("溜めマスの光は、置いたマスと返した駒のうち溜めマス（c3・f3・c6・f6）から。打った人が増えていなければ出さない", () => {
    const gain: GaugeGain = { from: 0, to: 8 * U, max: 26 * U, full: false };
    expect(zoneSources(move(2, 2, [[3, 3], [5, 5]]), gain)).toEqual([[2, 2], [5, 5]]);
    expect(zoneSources(move(2, 3, [[3, 3]]), gain)).toEqual([]);
    expect(zoneSources(move(2, 2, []), null)).toEqual([]);
  });

  it("伸び始め: 溜めマスの光が着いてから・特大の溜めが弾けてから・ほかは返す駒がめくれてから", () => {
    expect(growDelay(0, 0)).toBe(GROW_AT_MS);
    expect(growDelay(1, 0)).toBeGreaterThan(GROW_AT_MS);
    expect(growDelay(1, 0)).toBeLessThan(ORB_MS);
    expect(growDelay(3, 0)).toBeGreaterThan(growDelay(1, 0));
    expect(growDelay(0, 850)).toBe(850);
    const a = { from: 0, to: 20 * U, max: 20 * U, full: true, key: 1, start: 1000 };
    expect(animDone(a, 1000 + GROW_MS)).toBe(false);
    expect(animDone(a, 1000 + GROW_MS + FULL_FLASH_MS)).toBe(true);
    expect(animDone({ ...a, full: false }, 1000 + GROW_MS)).toBe(true);
  });
});

describe("engine の局面で: 打った手の差がそのまま engine の足した点になる", () => {
  it("溜めマスに置いた手は、カードの溜めマス点を含む差になる", () => {
    let g: GameState = setSkills(createGame(rulesOf("skill", { dirs: "all" })), ["strong", "wall"]);
    // 溜めマスに置けるまで、置けるマスの先頭に打つ（双方）
    for (let i = 0; i < 40 && !g.result; i++) {
      const before = snapOf(1, g.ply, g.skills!, NO);
      const kind = playableKinds(g)[0];
      const cells = legalCells(g, kind);
      const zone = cells.find(([r, c]) => isZone(r, c));
      const [r, c] = zone ?? cells[0];
      g = playMove(g, r, c, kind);
      const m = lastMoveOf(g)!;
      const gains = gaugeGains(before, 1, g.ply, g.skills, NO);
      const mover = gains[m.player];
      if (zone && mover && !mover.full && mover.to < mover.max) {
        expect(zoneSources(m, mover).length).toBeGreaterThan(0);
        expect(mover.to - mover.from).toBeGreaterThanOrEqual(4 * U);
        return;
      }
    }
    throw new Error("溜めマスに置けなかった");
  });
});
