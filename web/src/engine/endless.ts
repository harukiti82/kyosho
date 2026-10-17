// エンドレスマッチ: CPU に勝つたびに CPU が強くなり、負けたら終わる。DOM・時計・乱数の直接参照なし（乱数は引数）。
// 対局は標準（id skill）をもとにした「短い対局」（体力・駒の数を減らし、ゲージを短くし、巻き戻しを配らない）。
// 強くなり方は段階の表（ENDLESS_STAGES）: 最初は CPU の体力の差、途中から読みの強さ。段階のあいだは CPU の手番ごとに
// 強い方を確率で混ぜて細かく刻む。表の後ろは深く読む CPU（予算 10000）のまま CPU の体力を増やし続ける。
// サーバー（server/src/endless.ts）が段階を決めて CPU の手を打つ。測定は scripts/endless.ts（npm run balance -- endless）。

import { chooseMove, type CpuLevel } from "./cpu";
import { chooseDeep } from "./deepcpu";
import { createGame, dealSkills, pickSkill, playMove, rerollSkills, useSkill, viewFor, type GameState } from "./game";
import { chooseSkillPick, chooseSkillUse, viceWith, wantsReroll } from "./skillcpu";
import { cloneRules, presetById, type Hand, type Player, type RuleSet } from "./rules";
import type { SkillId } from "./skills";

/** 短い対局の体力 [先手, 後手]（CPU の側には段階の hp を足す） */
export const ENDLESS_HP: readonly [number, number] = [88, 84];
/** 短い対局の持ち駒（両者同じ。20 個） */
export const ENDLESS_HAND: Readonly<Hand> = { fu: 6, yoko: 6, gin: 0, kaku: 3, kin: 2, hi: 3 };
/** 短い対局のゲージの長さの倍率（百分率） */
export const ENDLESS_GAUGE = 50;
/** 短い対局の王と副将の罰（標準の 30・15 を体力の比 88 ÷ 135 で下げた） */
export const ENDLESS_KING_PENALTY = 19;
export const ENDLESS_VICE_PENALTY = 10;
/** 短い対局で配らないカード（巻き戻しは短いゲージで応酬になり対局が進まない） */
export const ENDLESS_OMIT: readonly SkillId[] = ["judge"];
/** CPU の体力の下限（段階の hp を引いても 1 は残す） */
const MIN_HP = 1;

/**
 * 短い対局のルール。cpu は CPU の席、cpuHp は CPU の体力に足す段階の値（負なら減る）。
 * 隠し王・副将の決まり・回復・方向駒・反対側の駒の力は標準のまま（罰だけ下げる）
 */
export function endlessRules(cpu: Player, cpuHp = 0): RuleSet {
  const r = cloneRules(presetById("skill").rules);
  r.hp = [ENDLESS_HP[0], ENDLESS_HP[1]];
  r.hp[cpu] = Math.max(MIN_HP, r.hp[cpu] + cpuHp);
  r.hand = { ...ENDLESS_HAND };
  r.king = { ...r.king, amount: ENDLESS_KING_PENALTY };
  r.vice = ENDLESS_VICE_PENALTY;
  r.gauge = ENDLESS_GAUGE;
  r.omit = [...ENDLESS_OMIT];
  return r;
}

/** 短い対局のルールか（ゲージの倍率と配らないカードで見分ける。プリセット・URL のルールにはない項目） */
export const isEndlessRules = (r: RuleSet): boolean => r.gauge === ENDLESS_GAUGE && ENDLESS_OMIT.every((id) => r.omit?.includes(id));

/** 段階に使う CPU。easy / normal / hard は cpu.ts の chooseMove、dN は深く読む CPU（予算 N） */
export type EndlessCpu = CpuLevel | "d300" | "d1000" | "d3000" | "d10000";
export const ENDLESS_CPUS: readonly EndlessCpu[] = ["easy", "normal", "hard", "d300", "d1000", "d3000", "d10000"];

/** 深く読む CPU の予算（調べる局面の数） */
const DEEP_NODES: Partial<Record<EndlessCpu, number>> = { d300: 300, d1000: 1000, d3000: 3000, d10000: 10000 };

export interface EndlessStage {
  /** 弱い方の CPU */
  base: EndlessCpu;
  /** 強い方の CPU（混ぜないなら base と同じ） */
  next: EndlessCpu;
  /** CPU の手番ごとに next を使う確率（0〜1） */
  mix: number;
  /** CPU の体力に足す値 */
  hp: number;
}

const st = (base: EndlessCpu, hp = 0, next: EndlessCpu = base, mix = 0): EndlessStage => ({ base, next, mix, hp });

/** a から b へ n 段で混ぜる（1/n, 2/n, …、最後の段は b だけ） */
const mixes = (a: EndlessCpu, b: EndlessCpu, n: number): EndlessStage[] =>
  Array.from({ length: n }, (_, i) => (i === n - 1 ? st(b) : st(a, 0, b, (i + 1) / n)));

/**
 * 段階の表（添字 = それまでの連勝数。1 戦目は 0）。値の根拠は .agent/endless.md の測定
 * （短い対局で、2 手読み（normal）・ハード・深く読む CPU をプレイヤーに見立てて各段階と対局させた勝率）
 */
export const ENDLESS_STAGES: readonly EndlessStage[] = [
  // イージーの体力を −44 から 0 まで 6 段で戻す
  ...Array.from({ length: 6 }, (_, i) => st("easy", Math.round(-44 + (44 * i) / 5))),
  // イージー → ノーマル → ハードを 1/8 ずつ混ぜる（各 8 段。最後の段は混ぜない）
  ...mixes("easy", "normal", 8),
  ...mixes("normal", "hard", 8),
  // ハード → 深く読む CPU（予算 300）を 1/4 ずつ、その先は予算 1000・3000・10000 へ半分ずつ
  ...mixes("hard", "d300", 4),
  ...mixes("d300", "d1000", 2),
  ...mixes("d1000", "d3000", 2),
  ...mixes("d3000", "d10000", 2),
];

/** 表の後ろで 1 段階ごとに CPU の体力に足す値 */
export const ENDLESS_TAIL_HP = 7;

/** wins 連勝した後の段階（表の後ろは最後の段階の CPU の体力を ENDLESS_TAIL_HP ずつ増やす） */
export function stageOf(wins: number): EndlessStage {
  const n = Math.max(0, Math.floor(wins));
  if (n < ENDLESS_STAGES.length) return ENDLESS_STAGES[n];
  const last = ENDLESS_STAGES[ENDLESS_STAGES.length - 1];
  return { ...last, hp: last.hp + ENDLESS_TAIL_HP * (n - ENDLESS_STAGES.length + 1) };
}

/** 新しい対局（短い対局のルールで、両者にカードを配り、CPU はその場で選ぶ）。乱数は配る・CPU の選択に使う */
export function newEndlessGame(cpu: Player, stage: EndlessStage, rng: () => number): GameState {
  let g = dealSkills(createGame(endlessRules(cpu, stage.hp)), rng);
  if (wantsReroll(g.skills!.sides[cpu].offer)) g = rerollSkills(g, cpu, rng);
  return pickSkill(g, cpu, chooseSkillPick(g.skills!.sides[cpu].offer, rng));
}

/** この手番に使う CPU（混ぜる段階は乱数を 1 回使う） */
export function cpuOf(stage: EndlessStage, rng: () => number): EndlessCpu {
  if (stage.mix <= 0 || stage.base === stage.next) return stage.base;
  return rng() < stage.mix ? stage.next : stage.base;
}

/**
 * CPU（席 seat）の手番を 1 つ進める（スキルを使う → 1 手打つ）。終局後・手番が seat でなければ例外。
 * 連続行動の 2 手目は手番が CPU のまま残るので、もう一度呼ぶ。CPU は viewFor の view だけを見る
 */
export function cpuTurn(state: GameState, seat: Player, cpu: EndlessCpu, rng: () => number): GameState {
  const p = state.turn;
  if (state.result) throw new Error("対局は終わっています");
  if (p !== seat) throw new Error("CPU の手番ではありません");
  let s = state;
  const nodes = DEEP_NODES[cpu];
  if (nodes !== undefined) {
    // use だけ返したら、使った結果を見てもう一度読む（偵察・運命の輪）。運命の輪の指定を含めても 4 回で足りる
    for (let k = 0; k < 4; k++) {
      const t = chooseDeep(viewFor(s, p), { nodes }, rng);
      if (t.use) s = useSkill(s, t.use, rng);
      if (t.move) return playMove(s, t.move.r, t.move.c, t.move.kind, { king: t.move.king, vice: t.move.vice });
      if (!t.use) throw new Error("CPU が手を返しませんでした");
      if (s.result) return s;
    }
    throw new Error("CPU がスキルを使い続けました");
  }
  for (let k = 0; k < 2 && !s.result; k++) {
    const use = chooseSkillUse(viewFor(s, p), rng);
    if (!use) break;
    s = useSkill(s, use, rng);
  }
  if (s.result) return s;
  const view = viewFor(s, p);
  const ch = chooseMove(view, cpu as CpuLevel, rng);
  if (!ch) throw new Error("CPU が手を返しませんでした");
  return playMove(s, ch.r, ch.c, ch.kind, { king: ch.king, vice: viceWith(view, ch, rng) });
}
