import { describe, expect, it } from "vitest";
import {
  cpuOf,
  cpuTurn,
  ENDLESS_CPUS,
  ENDLESS_EX_CHANCE,
  endlessReroll,
  ENDLESS_HAND,
  ENDLESS_HP,
  ENDLESS_STAGES,
  ENDLESS_TAIL_HP,
  endlessRules,
  newEndlessGame,
  stageOf,
} from "../src/engine/endless";
import { createGame, dealSkills, gameFrom, isLegal, legalCells, pickSkill, playableKinds, playMove, rerollSkills, skillBlock, skillPool, viewFor, wheelPool, type GameState } from "../src/engine/game";
import { cloneRules, KIND_ORDER, matchPreset, PIECES, presetById, sameRules, type PieceKind, type Player } from "../src/engine/rules";

const PIECE_NAME = Object.fromEntries(KIND_ORDER.map((k) => [k, PIECES[k].name])) as Record<PieceKind, string>;
import { gaugeMax, GAUGE_UNIT, skillLength, SKILL_ORDER, SKILLS, VICE_PENALTY, vicePenalty } from "../src/engine/skills";
import { decodeRules, encodeRules } from "../src/ui/query";
import { at } from "./helpers";
import RULES_MD from "../../RULES.md?raw";

/** 種付きの乱数（mulberry32） */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("短い対局のルール", () => {
  it("標準から体力・持ち駒・王と副将の罰・ゲージ・配るカードだけを変える", () => {
    const r = endlessRules(1);
    const std = presetById("skill").rules;
    expect(r.hp).toEqual([88, 84]);
    expect(r.hand).toEqual({ fu: 6, yoko: 6, gin: 0, kaku: 3, kin: 2, hi: 3 });
    expect(KIND_ORDER.reduce((n, k) => n + r.hand[k], 0)).toBe(20);
    expect(r.king).toEqual({ ...std.king, amount: 19 });
    expect(vicePenalty(r)).toBe(10);
    expect(vicePenalty(std)).toBe(VICE_PENALTY);
    expect(r.gauge).toBe(50);
    expect(r.omit).toEqual(["judge"]);
    expect({ ...r, hp: std.hp, hand: std.hand, king: std.king, vice: undefined, gauge: undefined, omit: undefined }).toEqual({
      ...std,
      vice: undefined,
      gauge: undefined,
      omit: undefined,
    });
  });

  it("CPU の席の体力にだけ段階の値を足す（1 未満にはしない）", () => {
    expect(endlessRules(1, 12).hp).toEqual([88, 96]);
    expect(endlessRules(0, -44).hp).toEqual([44, 84]);
    expect(endlessRules(0, -500).hp).toEqual([1, 84]);
    // 定数を書き換えない
    expect(ENDLESS_HP).toEqual([88, 84]);
    expect(ENDLESS_HAND.fu).toBe(6);
  });

  it("どのプリセットとも別のルールで、URL に載せると倍率・配らないカードが落ちて同じルールに戻らない", () => {
    const r = endlessRules(0);
    expect(matchPreset(r)).toBeNull();
    expect(sameRules(r, { ...r, gauge: 100 })).toBe(false);
    expect(sameRules(r, { ...r, omit: [] })).toBe(false);
    expect(sameRules(r, { ...r, vice: undefined })).toBe(false);
    expect(sameRules(r, cloneRules(r))).toBe(true);
    expect(sameRules({ ...presetById("skill").rules, gauge: 100, omit: [] }, presetById("skill").rules)).toBe(true);
    const back = decodeRules(encodeRules(r)).rules;
    expect(back.gauge).toBeUndefined();
    expect(back.vice).toBeUndefined();
    expect(sameRules(back, r)).toBe(false);
  });

  it("ゲージの長さは倍率を掛けて四捨五入（1 未満は 1）", () => {
    const r = endlessRules(0);
    expect(skillLength("strong", r)).toBe(13); // 26 × 0.5
    expect(skillLength("omni", r)).toBe(16);
    expect(skillLength("bigheal", r)).toBe(90);
    expect(skillLength("wall", r)).toBe(10);
    expect(skillLength("scout", r)).toBe(12);
    expect(gaugeMax("wall", r)).toBe(10 * GAUGE_UNIT);
    expect(skillLength("wall", { gauge: 1 })).toBe(1);
    for (const id of SKILL_ORDER) expect(skillLength(id, presetById("skill").rules)).toBe(SKILLS[id].length);
  });

  it("巻き戻しは配らず、配り直し・運命の輪にも出ない", () => {
    const r = endlessRules(0);
    expect(skillPool(r)).not.toContain("judge");
    expect(skillPool(r)).toHaveLength(10);
    expect(wheelPool(r)).not.toContain("judge");
    expect(wheelPool(r)).toHaveLength(9);
    const rng = mulberry(7);
    for (let i = 0; i < 300; i++) {
      const g = rerollSkills(dealSkills(createGame(r), rng), 0, rng);
      for (const side of g.skills!.sides) expect(side.offer).not.toContain("judge");
    }
  });

  it("同じゲージの値でも、短い対局では満タンで使える（標準ではまだ溜まっていない）", () => {
    const pos = {
      stones: [{ at: at("d4"), owner: 0, kind: "fu" }, { at: at("d5"), owner: 1, kind: "fu" }, { at: at("e5"), owner: 0, kind: "fu" }],
      skills: [{ card: "wall", gauge: 10 * GAUGE_UNIT }, { card: "strong" }],
    } as const;
    const short = gameFrom(endlessRules(1), { ...pos, stones: [...pos.stones], skills: [{ ...pos.skills[0] }, { ...pos.skills[1] }] });
    const std = gameFrom(presetById("skill").rules, { ...pos, stones: [...pos.stones], skills: [{ ...pos.skills[0] }, { ...pos.skills[1] }] });
    expect(skillBlock(viewFor(short, 0))).toBeNull();
    expect(skillBlock(viewFor(std, 0))).toBe("charging");
  });
});

describe("RULES.md の短い対局の節", () => {
  const section = RULES_MD.slice(RULES_MD.indexOf("## エンドレスマッチ（短い対局）"));
  const cell = (name: string) => Number(section.match(new RegExp(`\\| ${name} \\| (\\d+) \\|`))?.[1]);

  it("体力・持ち駒・ゲージの長さ・配らないカードがコードと同じ", () => {
    const r = endlessRules(0);
    expect(section).toContain(`体力は先手 ${ENDLESS_HP[0]}・後手 ${ENDLESS_HP[1]}`);
    expect(section).toContain(`王を返されたら体力 −${r.king.amount}、副将を返されたら体力 −${vicePenalty(r)}`);
    expect(section).toContain(`持ち駒は 1 人 ${KIND_ORDER.reduce((n, k) => n + ENDLESS_HAND[k], 0)} 個`);
    for (const k of KIND_ORDER) if (ENDLESS_HAND[k] > 0) expect(cell(PIECE_NAME[k]), k).toBe(ENDLESS_HAND[k]);
    for (const id of skillPool(r)) expect(cell(SKILLS[id].name), id).toBe(skillLength(id, r));
    expect(section).not.toMatch(/\| 巻き戻し \|/);
    expect(section).toContain(`運命の輪以外の ${wheelPool(r).length} 枚`);
    expect(section).toContain(`CPU の体力を ${ENDLESS_TAIL_HP} ずつ増やし続ける`);
    expect(section).toContain(`CPU の体力を ${-stageOf(0).hp} 減らしたイージー`);
    expect(section).toContain(`ゲージの長さは標準の ${(r.gauge ?? 100) / 100} 倍`);
  });
});

describe("段階", () => {
  it("1 戦目は体力の少ないイージー。CPU は段階が進むほど弱くならない（体力の差、混ぜる確率、強さの順）", () => {
    expect(stageOf(0)).toEqual({ base: "easy", next: "easy", mix: 0, hp: -27 });
    expect(stageOf(1)).toEqual({ base: "easy", next: "easy", mix: 0, hp: -24 });
    expect(stageOf(9)).toEqual({ base: "easy", next: "easy", mix: 0, hp: 0 });
    expect(stageOf(10)).toEqual({ base: "easy", next: "normal", mix: 1 / 8, hp: 0 });
    expect(ENDLESS_STAGES).toHaveLength(36);
    const rank = (c: string) => ENDLESS_CPUS.indexOf(c as never);
    for (let i = 1; i < ENDLESS_STAGES.length + 5; i++) {
      const a = stageOf(i - 1);
      const b = stageOf(i);
      const strength = (s: typeof a) => rank(s.base) + (rank(s.next) - rank(s.base)) * s.mix;
      expect(strength(b) > strength(a) || (strength(b) === strength(a) && b.hp > a.hp), `段階 ${i}`).toBe(true);
    }
  });

  it("表の後ろは最後の CPU のまま体力を増やし続ける。負の数・小数は丸める", () => {
    const last = ENDLESS_STAGES[ENDLESS_STAGES.length - 1];
    expect(last.base).toBe("d10000");
    expect(stageOf(ENDLESS_STAGES.length)).toEqual({ ...last, hp: last.hp + ENDLESS_TAIL_HP });
    expect(stageOf(ENDLESS_STAGES.length + 9).hp).toBe(last.hp + ENDLESS_TAIL_HP * 10);
    expect(stageOf(-3)).toEqual(stageOf(0));
    expect(stageOf(2.7)).toEqual(stageOf(2));
  });

  it("混ぜる段階は確率どおりに強い方を使う", () => {
    const st = { base: "easy", next: "normal", mix: 1 / 3, hp: 0 } as const;
    const rng = mulberry(11);
    let strong = 0;
    for (let i = 0; i < 3000; i++) if (cpuOf(st, rng) === "normal") strong++;
    expect(strong / 3000).toBeGreaterThan(0.3);
    expect(strong / 3000).toBeLessThan(0.37);
    expect(cpuOf({ ...st, mix: 0 }, () => 0)).toBe("easy");
    expect(cpuOf({ ...st, mix: 1 }, () => 0.999)).toBe("normal");
  });
});

describe("CPU の手番", () => {
  it("新しい対局は CPU だけが選び終えている（プレイヤーは配られた 3 枚から選ぶ）", () => {
    const g = newEndlessGame(1, stageOf(3), mulberry(5));
    expect(g.rules.hp).toEqual([88, 84 + stageOf(3).hp]);
    expect(g.skills!.ready).toBe(false);
    expect(g.skills!.sides[0].card).toBeNull();
    expect(g.skills!.sides[0].offer).toHaveLength(3);
    expect(g.skills!.sides[1].card).not.toBeNull();
    expect(g.skills!.sides[1].offer).toContain(g.skills!.sides[1].card);
  });

  it("CPU の手番でなければ例外", () => {
    let g = newEndlessGame(1, stageOf(0), mulberry(5));
    g = pickSkill(g, 0, g.skills!.sides[0].offer[0]);
    expect(g.turn).toBe(0);
    expect(() => cpuTurn(g, 1, "easy", mulberry(1))).toThrow("CPU の手番ではありません");
  });

  it.each(["easy", "normal", "hard", "d300"] as const)("%s で終局まで打つ（反則手なし。プレイヤーは置ける手から適当に）", (cpu) => {
    const rng = mulberry(cpu.length * 17);
    for (let i = 0; i < 4; i++) {
      const me: Player = i % 2 === 0 ? 0 : 1;
      const seat: Player = me === 0 ? 1 : 0;
      let s: GameState = newEndlessGame(seat, stageOf(i * 3), rng);
      s = pickSkill(s, me, s.skills!.sides[me].offer[0]);
      let steps = 0;
      while (!s.result) {
        expect(++steps).toBeLessThan(300);
        if (s.turn !== me) {
          const before = s.history.length;
          s = cpuTurn(s, seat, cpu, rng);
          expect(s.history.length).toBeGreaterThan(before);
          continue;
        }
        const kinds = playableKinds(s);
        const kind = kinds[Math.floor(rng() * kinds.length)];
        const cells = legalCells(s, kind);
        const [r, c] = cells[Math.floor(rng() * cells.length)];
        expect(isLegal(s, r, c, kind)).toBe(true);
        s = playMove(s, r, c, kind);
      }
      expect(s.result.reason).toBeTruthy();
    }
  });

  it("極はプレイヤーにだけ、配る 3 枚に約 ENDLESS_EX_CHANCE の確率で付く（CPU には付かない）。配り直しにも同じ確率", () => {
    const rng = mulberry(11);
    let first = 0;
    let rerolled = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const cpu: Player = i % 2 === 0 ? 1 : 0;
      const me: Player = cpu === 0 ? 1 : 0;
      const g = newEndlessGame(cpu, stageOf(0), rng);
      expect(g.skills!.sides[cpu].exOffer).toBeUndefined();
      expect(g.skills!.sides[cpu].ex).toBeUndefined();
      if (g.skills!.sides[me].exOffer) first++;
      if (endlessReroll(g, me, rng).skills!.sides[me].exOffer) rerolled++;
    }
    // 5% ± 1%（4000 局の標準誤差は約 0.34%）
    expect(Math.abs(first / n - ENDLESS_EX_CHANCE)).toBeLessThan(0.01);
    expect(Math.abs(rerolled / n - ENDLESS_EX_CHANCE)).toBeLessThan(0.01);
    // 確率 0 なら付かない・1 なら必ず付く
    expect(newEndlessGame(1, stageOf(0), rng, 0).skills!.sides[0].exOffer).toBeUndefined();
    expect(newEndlessGame(1, stageOf(0), rng, 1).skills!.sides[0].exOffer).toBeDefined();
  });

  it("同じ局面・同じ乱数なら同じ手（サーバーの手を再現できる）", () => {
    let g = newEndlessGame(0, stageOf(13), mulberry(9));
    g = pickSkill(g, 1, g.skills!.sides[1].offer[1]);
    const a = cpuTurn(g, 0, "d300", mulberry(4));
    const b = cpuTurn(g, 0, "d300", mulberry(4));
    expect(a.history).toEqual(b.history);
  });

  it("CPU は見えない情報を使わない（プレイヤーの王の場所だけ違う 2 局面で同じ手）", () => {
    const r = endlessRules(1);
    const stones = [
      { at: at("d4"), owner: 0, kind: "fu" },
      { at: at("e4"), owner: 0, kind: "yoko" },
      { at: at("d5"), owner: 1, kind: "fu" },
      { at: at("e5"), owner: 1, kind: "kaku" },
      { at: at("c3"), owner: 0, kind: "fu" },
      { at: at("f6"), owner: 1, kind: "fu" },
    ] as const;
    const pos = (king: string) =>
      gameFrom(r, {
        stones: [...stones],
        turn: 1,
        kings: [at(king), null],
        skills: [{ card: "strong" }, { card: "omni" }],
      });
    for (const cpu of ["normal", "hard", "d1000"] as const) {
      // 打った手（王を返したかは盤の答え合わせなので棋譜の king は比べない）
      const move = (g: GameState) => {
        const m = g.history.at(-1)!;
        return m.type === "move" ? { r: m.r, c: m.c, kind: m.kind } : m;
      };
      expect(move(cpuTurn(pos("d4"), 1, cpu, mulberry(8))), cpu).toEqual(move(cpuTurn(pos("c3"), 1, cpu, mulberry(8))));
    }
  });
});
