// 深く読む CPU（engine/deepcpu.ts）の強さと 1 手の時間を測る。scripts/deep-run.mjs（npm run balance -- deep）が子プロセスで呼ぶ。
// 局 i は種 i + 1（mulberry32）で、配るカード・CPU の乱数とも毎回同じになる。先手・後手は 1 局ごとに入れ替える。

import { chooseMove, type CpuLevel } from "../src/engine/cpu";
import { chooseDeep, type DeepBudget, type DeepWeights, DEEP_WEIGHTS } from "../src/engine/deepcpu";
import { createGame, dealSkills, pickSkill, playMove, rerollSkills, useSkill, viewFor, type GameState } from "../src/engine/game";
import { chooseSkillPick, chooseSkillUse, viceWith, wantsReroll } from "../src/engine/skillcpu";
import { cloneRules, presetById, type Player, type PresetId } from "../src/engine/rules";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 対局する CPU: 今の強さか、深く読む CPU（予算と係数） */
export type Bot = { level: CpuLevel } | { deep: DeepBudget; w?: DeepWeights };

/** 両者に配り、CPU の決まり（3 枚とも弱ければ配り直し・一様に選ぶ）で選ばせる */
export function deal(s: GameState, rand: () => number): GameState {
  if (!s.skills) return s;
  s = dealSkills(s, rand);
  for (const p of [0, 1] as Player[]) {
    if (wantsReroll(s.skills!.sides[p].offer)) s = rerollSkills(s, p, rand);
    s = pickSkill(s, p, chooseSkillPick(s.skills!.sides[p].offer, rand));
  }
  return s;
}

/** 1 手番（スキルを使う → 打つ）。かかった時間（ms）も返す */
export function turn(s: GameState, bot: Bot, rand: () => number): { s: GameState; ms: number } {
  const p = s.turn;
  const t0 = performance.now();
  if ("deep" in bot) {
    for (let k = 0; k < 4; k++) {
      const t = chooseDeep(viewFor(s, p), bot.deep, rand, bot.w ?? DEEP_WEIGHTS);
      if (t.use) s = useSkill(s, t.use, rand);
      if (t.move) {
        const ms = performance.now() - t0;
        return { s: playMove(s, t.move.r, t.move.c, t.move.kind, { king: t.move.king, vice: t.move.vice }), ms };
      }
      if (!t.use) throw new Error("深く読む CPU が手を返しませんでした");
      if (s.result) return { s, ms: performance.now() - t0 };
    }
    throw new Error("スキルを使い続けました");
  }
  for (let k = 0; k < 2 && !s.result; k++) {
    const use = chooseSkillUse(viewFor(s, p), rand);
    if (!use) break;
    s = useSkill(s, use, rand);
  }
  if (s.result) return { s, ms: performance.now() - t0 };
  const view = viewFor(s, p);
  const ch = chooseMove(view, bot.level, rand)!;
  const vice = viceWith(view, ch, rand);
  const ms = performance.now() - t0;
  return { s: playMove(s, ch.r, ch.c, ch.kind, { king: ch.king, vice }), ms };
}

export interface MatchResult {
  /** a から見た得点（勝ち 1・引き分け 0.5） */
  score: number;
  games: number;
  plies: number[];
  msA: number[];
  msB: number[];
}

/** a と b を局 from〜to−1 で対戦させる（偶数局は a が先手） */
export function match(a: Bot, b: Bot, from: number, to: number, preset: PresetId = "skill"): MatchResult {
  const rules = cloneRules(presetById(preset).rules);
  const out: MatchResult = { score: 0, games: 0, plies: [], msA: [], msB: [] };
  for (let i = from; i < to; i++) {
    const rand = rng(i + 1);
    const aSeat: Player = i % 2 === 0 ? 0 : 1;
    let s = deal(createGame(rules), rand);
    while (!s.result) {
      const isA = s.turn === aSeat;
      const r = turn(s, isA ? a : b, rand);
      (isA ? out.msA : out.msB).push(r.ms);
      s = r.s;
    }
    const w = s.result.winner;
    out.score += w === aSeat ? 1 : w === null ? 0.5 : 0;
    out.games++;
    out.plies.push(s.ply);
  }
  return out;
}

/** 引数「a b from to [preset]」の Bot を JSON で受けて対戦し、結果を JSON で出す（並列の子プロセス用） */
export function main(args: string[]) {
  const [a, b] = [JSON.parse(args[0]) as Bot, JSON.parse(args[1]) as Bot];
  const r = match(a, b, Number(args[2]), Number(args[3]), (args[4] ?? "skill") as PresetId);
  console.log(JSON.stringify(r));
}
