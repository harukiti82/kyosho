// 深く読む CPU（engine/deepcpu.ts）: 同じ view・同じ乱数・同じ予算なら同じ操作、相手の隠し情報に左右されない、
// 予算を守る、終局まで反則手・例外なく打てる（11 枚のカードそれぞれ）、決着の手を逃さない、期限の手で王を決める

import { describe, expect, it } from "vitest";
import { chooseMove } from "../src/engine/cpu";
import { chooseDeep, type DeepBudget } from "../src/engine/deepcpu";
import {
  createGame,
  dealSkills,
  gameFrom,
  pickSkill,
  playMove,
  setSkills,
  useSkill,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { cloneRules, other, presetById, type Player } from "../src/engine/rules";
import { chooseSkillPick, chooseSkillUse, viceWith } from "../src/engine/skillcpu";
import { SKILL_ORDER, type SkillId } from "../src/engine/skills";

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

const HEAVY_MS = 60_000;
const rules = () => cloneRules(presetById("skill").rules);

/** 両者に配って CPU の決まりで選ばせた標準の対局の始め */
function dealt(rand: () => number): GameState {
  let s = dealSkills(createGame(rules()), rand);
  for (const p of [0, 1] as Player[]) s = pickSkill(s, p, chooseSkillPick(s.skills!.sides[p].offer, rand));
  return s;
}

/** ノーマルの 1 手番（スキルを使うか決めて打つ） */
function normalTurn(s: GameState, rand: () => number): GameState {
  const p = s.turn;
  for (let k = 0; k < 2 && !s.result; k++) {
    const use = chooseSkillUse(viewFor(s, p), rand);
    if (!use) break;
    s = useSkill(s, use, rand);
  }
  if (s.result) return s;
  const view = viewFor(s, p);
  const ch = chooseMove(view, "normal", rand)!;
  return playMove(s, ch.r, ch.c, ch.kind, { king: ch.king, vice: viceWith(view, ch, rand) });
}

/** 深く読む CPU の 1 手番（chooseDeep の操作をそのまま当てる。反則なら playMove / useSkill が例外） */
function deepTurn(s: GameState, budget: DeepBudget, rand: () => number): GameState {
  const p = s.turn;
  for (let k = 0; k < 4; k++) {
    const t = chooseDeep(viewFor(s, p), budget, rand);
    if (t.use) s = useSkill(s, t.use, rand);
    if (t.move) return playMove(s, t.move.r, t.move.c, t.move.kind, { king: t.move.king, vice: t.move.vice });
    if (!t.use) throw new Error("手を返しませんでした");
    if (s.result) return s;
  }
  throw new Error("スキルを使い続けました");
}

/** ノーマル同士で打った局面のうち、手番の頭のもの（種ごとに数局面） */
function positions(seed: number, plies: number[]): GameState[] {
  const rand = rng(seed);
  let s = dealt(rand);
  const out: GameState[] = [];
  while (!s.result && out.length < plies.length) {
    if (s.ply >= plies[out.length]) out.push(s);
    s = normalTurn(s, rand);
  }
  return out;
}

describe("深く読む CPU", () => {
  const budget: DeepBudget = { nodes: 1500 };
  const sample = [1, 2, 3].flatMap((seed) => positions(seed, [0, 6, 13, 20, 28]));

  it("同じ view・同じ乱数・同じ予算なら同じ操作を返す（view を写しても同じ）", { timeout: HEAVY_MS }, () => {
    expect(sample.length).toBeGreaterThan(10);
    for (const s of sample) {
      const view = viewFor(s, s.turn);
      const a = chooseDeep(view, budget, rng(7));
      const b = chooseDeep(view, budget, rng(7));
      const c = chooseDeep(structuredClone(view), budget, rng(7));
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });

  it("調べる局面の数は予算を超えず、予算を増やすと深く読む", { timeout: HEAVY_MS }, () => {
    for (const s of sample.slice(0, 6)) {
      const view = viewFor(s, s.turn);
      const small = chooseDeep(view, { nodes: 300 }, rng(1));
      const large = chooseDeep(view, { nodes: 6000 }, rng(1));
      if (!small.move) continue;
      expect(small.nodes).toBeLessThanOrEqual(300);
      expect(large.nodes).toBeLessThanOrEqual(6000);
      expect(large.depth).toBeGreaterThanOrEqual(small.depth);
    }
  });

  it("相手の王の真の場所が違っても、view が同じなら同じ操作", { timeout: HEAVY_MS }, () => {
    let checked = 0;
    for (const s of sample) {
      const q = other(s.turn);
      const v0 = viewFor(s, s.turn);
      const k = s.kings[q];
      // 相手の王が隠れていて、候補が 2 つ以上ある局面で、王を別の候補へ移した局面を作る
      if (!k.cell || k.revealed || v0.oppKing.scouted || v0.oppKing.candidates.length < 2) continue;
      const alt = v0.oppKing.candidates.find(([y, x]) => y !== k.cell![0] || x !== k.cell![1])!;
      const kings: GameState["kings"] = [s.kings[0], s.kings[1]];
      kings[q] = { ...k, cell: alt };
      const t: GameState = { ...s, kings };
      const v1 = viewFor(t, t.turn);
      expect(v1).toEqual(v0);
      expect(chooseDeep(v1, budget, rng(3))).toEqual(chooseDeep(v0, budget, rng(3)));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("11 枚のカードそれぞれを持って、ノーマル相手に終局まで反則手・例外なく打つ", { timeout: HEAVY_MS * 2 }, () => {
    for (const [i, id] of SKILL_ORDER.entries()) {
      const rand = rng(100 + i);
      const deepSide: Player = i % 2 === 0 ? 0 : 1;
      const cards: [SkillId, SkillId] = deepSide === 0 ? [id, SKILL_ORDER[(i + 3) % 11]] : [SKILL_ORDER[(i + 3) % 11], id];
      let s = setSkills(createGame(rules()), cards);
      while (!s.result) s = s.turn === deepSide ? deepTurn(s, { nodes: 400 }, rand) : normalTurn(s, rand);
      expect(s.result.reason).toMatch(/ko|stalled|limit|king/);
    }
  });

  it("深く読む CPU 同士でも終局まで打つ", { timeout: HEAVY_MS }, () => {
    for (let i = 0; i < 3; i++) {
      const rand = rng(200 + i);
      let s = dealt(rand);
      while (!s.result) s = deepTurn(s, { nodes: 300 }, rand);
      expect(s.result).not.toBeNull();
    }
  });

  it("相手の体力を削り切る手があれば打つ", () => {
    // 先手の歩 d4 と e5 で後手の金 d5 を縦に挟める（d6 に先手の歩を置く）。後手の体力 3
    const s = gameFrom(rules(), {
      stones: [
        { at: [3, 3], owner: 0, kind: "fu" },
        { at: [4, 3], owner: 1, kind: "kin" },
        { at: [4, 4], owner: 1, kind: "fu" },
        { at: [3, 4], owner: 1, kind: "fu" },
      ],
      hp: [100, 3],
      skills: [{ card: "strong" }, { card: "wall" }],
    });
    const t = chooseDeep(viewFor(s, 0), { nodes: 500 }, rng(1));
    expect(t.move).not.toBeNull();
    const after = playMove(s, t.move!.r, t.move!.c, t.move!.kind);
    expect(after.result?.winner).toBe(0);
  });

  it("王の指定の期限の手では王を決める", { timeout: HEAVY_MS }, () => {
    const rand = rng(5);
    let s = dealt(rand);
    for (;;) {
      const v = viewFor(s, s.turn);
      if (s.turn === 0 && v.myKing.forcedNow) break;
      // 先手は期限まで王を決めずに打つ（ノーマルの手から王の指定を外す）
      if (s.turn === 0) {
        const ch = chooseMove(v, "normal", rand)!;
        s = playMove(s, ch.r, ch.c, ch.kind);
      } else s = normalTurn(s, rand);
      expect(s.result).toBeNull();
    }
    const t = chooseDeep(viewFor(s, 0), { nodes: 800 }, rng(2));
    expect(t.move?.king).toBe(true);
  });
});
