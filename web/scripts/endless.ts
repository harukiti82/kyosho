// エンドレスマッチの段階の強さを測る。scripts/endless-run.mjs（npm run balance -- endless）が子プロセスで呼ぶ。
// プレイヤーに見立てた CPU（easy / normal / hard / deep:予算）を、段階の表（engine/endless.ts）の CPU と短い対局で打たせる。
// 局 i は種 i + 1（mulberry32）。偶数局はプレイヤーが先手（サーバーと同じく 1 局ごとに入れ替える）。

import { cpuOf, cpuTurn, newEndlessGame, stageOf } from "../src/engine/endless";
import { pickSkill, rerollSkills } from "../src/engine/game";
import { chooseSkillPick, wantsReroll } from "../src/engine/skillcpu";
import type { Player } from "../src/engine/rules";
import { rng, turn, type Bot } from "./deep.ts";

export interface StageResult {
  stage: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  plies: number;
}

/** プレイヤー bot を段階 stage（それまでの連勝数）と局 from〜to−1 で対局させる */
export function play(bot: Bot, stage: number, from: number, to: number): StageResult {
  const st = stageOf(stage);
  const out: StageResult = { stage, games: 0, wins: 0, draws: 0, losses: 0, plies: 0 };
  for (let i = from; i < to; i++) {
    const rand = rng(i + 1);
    const me: Player = i % 2 === 0 ? 0 : 1;
    const cpu: Player = me === 0 ? 1 : 0;
    let s = newEndlessGame(cpu, st, rand);
    if (wantsReroll(s.skills!.sides[me].offer)) s = rerollSkills(s, me, rand);
    s = pickSkill(s, me, chooseSkillPick(s.skills!.sides[me].offer, rand));
    let steps = 0;
    while (!s.result) {
      if (++steps > 400) throw new Error(`局 ${i} が終わりません`);
      s = s.turn === cpu ? cpuTurn(s, cpu, cpuOf(st, rand), rand) : turn(s, bot, rand).s;
    }
    const w = s.result.winner;
    out.games++;
    if (w === me) out.wins++;
    else if (w === null) out.draws++;
    else out.losses++;
    out.plies += s.ply;
  }
  return out;
}

/** 引数「bot stage from to」（bot は JSON）で対局し、結果を JSON で出す */
export function main(args: string[]) {
  console.log(JSON.stringify(play(JSON.parse(args[0]) as Bot, Number(args[1]), Number(args[2]), Number(args[3]))));
}
