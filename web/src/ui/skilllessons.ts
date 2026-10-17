// スキル練習: スキル 11 枚それぞれを、満タンの状態から盤で使って覚えるチュートリアル（メインの遊び方 LESSONS とは別の入口）。
// 1 枚 1 ステップ。名札のカードを使う → 指定（補充の駒・王の移し替えの先・運命の輪で出た指定）→ 光っているマスに置く、で効き目を見る。
// 連続行動は 2 手目まで、鉄壁は相手の決めた応手まで、巻き戻しは始めの局面に「自分の手と相手の応手」を打ってある。
// 形は lessons.ts の Lesson（judgeMove / nextNeed をそのまま使う）。文に出す数字はエンジン（useSkill / playMove）の結果から取る。
// DOM に依存しない（一覧はメニュー ui/menu.ts、盤の誘導とコーチは ui/app.ts）。

import { parseCell } from "../engine/board";
import { gameFrom, kingInfo, playMove, type MoveEvent, type PositionSkill } from "../engine/game";
import { gaugeMax, SKILL_ORDER, SKILLS, type SkillId, type SkillNote } from "../engine/skills";
import { PIECES, type PieceKind } from "../engine/rules";
import type { KeyValueStore } from "../net/online";
import { B, cells, hand, label, labels, skillOnly, std, stones, W, type Lesson } from "./lessons";
import { skillText } from "./ruletext";

/** 満タンのカード（自分）と、カードを持たない相手 */
const full = (id: SkillId): [PositionSkill, PositionSkill] => [{ card: id, gauge: gaugeMax(id, std()) }, {}];

/** 名札のカードを使ってから置く課題（例: 「名札の強打を押してから、光っているマスに歩を置く」） */
const useTask = (id: SkillId, then: string) => `名札の${SKILLS[id].name}を押してから、${then}`;

/** 使ったスキルの記録（その手番の手の棋譜に残る） */
const noteOf = (m: MoveEvent): SkillNote | undefined => m.skill;

/** 光っているマスに置くヒント（違うマスに置こうとしたとき） */
const placeHint = (kind: PieceKind, why = "") => () => `${why}光っているマスに${PIECES[kind].name}を置く`;

/** 回復の 2 枚（応急手当・大回復）。体力 100 から使う */
function healLesson(id: "firstaid" | "bigheal", col: string): Lesson {
  const t = skillText(id, std());
  return {
    id,
    title: SKILLS[id].name,
    point: t.point,
    note: `${t.note}。使ったら、そのまま駒も置く。`,
    task: useTask(id, "光っているマスに歩を置く"),
    rules: skillOnly(),
    start() {
      return gameFrom(this.rules, {
        stones: stones([[`${col}8`, B, "fu"], [`${col}7`, W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        hp: [100, this.rules.hp[1]],
        skills: full(id),
      });
    },
    answers: [{ at: parseCell(`${col}6`), kind: "fu", skill: true }],
    guide: cells(`${col}6`),
    hint: placeHint("fu"),
    done(m, _g, after) {
      const heal = noteOf(m)?.heal ?? 0;
      return `${SKILLS[id].name}で体力が ${heal} 回復して ${after.hp[0]} になった。ゲージは 0 に戻り、また溜めると使える。`;
    },
  };
}

/** 補充で戻す駒が 2 種類（歩と金）ある持ち駒。金は使い切ってある */
const refillHands = (r = std()) => [{ ...r.hand, fu: r.hand.fu - 1, kin: 0 }, { ...r.hand }] as [typeof r.hand, typeof r.hand];

/** スキル練習のステップ（SKILL_ORDER の順） */
const CARD_LESSONS: Record<SkillId, Lesson> = {
  firstaid: healLesson("firstaid", "d"),
  bigheal: healLesson("bigheal", "e"),
  strong: {
    id: "strong",
    title: SKILLS.strong.name,
    point: skillText("strong", std()).point,
    note: "使った手番に置く 1 手だけに効く。",
    task: useTask("strong", "光っているマスに歩を置く"),
    rules: skillOnly(),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["c8", B, "kin"], ["c7", W, "fu"], ["c6", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: full("strong"),
      });
    },
    answers: [{ at: parseCell("c5"), kind: "fu", skill: true }],
    guide: cells("c5"),
    hint: placeHint("fu"),
    done: (m) => `強打で、ダメージ ${m.plain ?? m.damage} が 1.5 倍の ${m.damage} になった。`,
  },
  omni: {
    id: "omni",
    title: SKILLS.omni.name,
    point: skillText("omni", std()).point,
    note: "縦にしか挟めない歩でも、横や斜めに挟める。",
    task: useTask("omni", "光っているマスに歩を置いて、横に挟む"),
    rules: skillOnly(),
    start() {
      // 横に並んだ白い駒（b4・c4）は、縦にしか挟めない歩では挟めない。g6 はふつうに置けるマス（打てる手を残して、手番を飛ばさない）
      return gameFrom(this.rules, {
        stones: stones([["a4", B, "fu"], ["b4", W, "fu"], ["c4", W, "kin"], ["g8", B, "fu"], ["g7", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: full("omni"),
      });
    },
    answers: [{ at: parseCell("d4"), kind: "fu", skill: true }],
    guide: cells("d4"),
    hint: placeHint("fu", "そこはふつうに置けるマス。"),
    done: (m, g) => `全方向で、縦にしか挟めない歩が横の${labels(g, m.targets.map((t) => t.kind))}を挟んで、${m.damage} のダメージ。`,
  },
  refill: {
    id: "refill",
    title: SKILLS.refill.name,
    point: skillText("refill", std()).point,
    note: "戻せる駒が 2 種類以上あれば、押した後に戻す駒を選ぶ。",
    task: useTask("refill", "戻す駒に金を選ぶ。戻した金を光っているマスに置く"),
    rules: skillOnly(),
    start() {
      // 金は使い切ってある（駒台の金は 0）。c8・d7 の斜めは金で挟める
      return gameFrom(this.rules, {
        stones: stones([["c8", B, "fu"], ["d7", W, "fu"], ["g8", B, "fu"], ["g7", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: refillHands(this.rules),
        skills: full("refill"),
      });
    },
    aim: { kind: "kin" },
    answers: [{ at: parseCell("e6"), kind: "kin", skill: true }],
    guide: cells("e6"),
    hint: placeHint("kin", "戻した金を使う。"),
    done: (m, g) => `補充で${label(g, noteOf(m)?.kind ?? "kin")}が駒台に戻り、そのまま置いて斜めの${labels(g, m.targets.map((t) => t.kind))}を裏返した。`,
  },
  wall: {
    id: "wall",
    title: SKILLS.wall.name,
    point: skillText("wall", std()).point,
    note: "! の付いた金が、次の相手の手で裏返されそうな形。",
    task: useTask("wall", "光っているマスに歩を置く。続く相手の手を見る"),
    rules: skillOnly(),
    start() {
      // b7 の金は、相手が b6 に歩を置くと裏返される（!）。鉄壁を使っても裏返されるが、ダメージは半分
      return gameFrom(this.rules, {
        stones: stones([["e8", B, "fu"], ["e7", W, "fu"], ["b8", W, "fu"], ["b7", B, "kin"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: full("wall"),
      });
    },
    answers: [{ at: parseCell("e6"), kind: "fu", skill: true }],
    guide: cells("e6"),
    reply: { at: parseCell("b6"), kind: "fu" },
    hint: placeHint("fu"),
    done(m, g) {
      const kinds = m.targets.map((t) => t.kind);
      return `相手が${labels(g, kinds)}を裏返したが、鉄壁でダメージ ${m.plain ?? m.damage} が半分の ${m.damage} になった。駒は裏返される。`;
    },
  },
  scout: {
    id: "scout",
    title: SKILLS.scout.name,
    point: "偵察で、相手の王の場所が分かる",
    note: "王が分かった後に使うと、相手の今の副将の場所が分かる。",
    task: "名札の偵察を押してから、見えた相手の王を飛で挟む",
    rules: std(),
    start() {
      // 王を決めずに、お互い 7 手ずつ打った局面（7 手目の駒が自動で王。相手の王は d3）。
      // 自分は左の 2 列を下から・e6、相手は右の 2 列を上から・d3。相手の王の候補は相手が置いた 7 つの駒
      let g = gameFrom(this.rules, {
        stones: stones([
          ["a8", B, "fu"], ["a7", W, "fu"], ["a5", W, "fu"], ["a3", W, "fu"],
          ["b8", B, "fu"], ["b7", W, "fu"], ["b5", W, "fu"], ["b3", W, "fu"],
          ["g1", W, "fu"], ["g2", B, "fu"], ["g4", B, "fu"], ["g6", B, "fu"],
          ["h1", W, "fu"], ["h2", B, "fu"], ["h4", B, "fu"], ["h6", B, "fu"],
          ["e8", B, "fu"], ["e7", W, "fu"], ["d1", W, "fu"], ["d2", B, "fu"], ["c3", B, "fu"],
        ]),
        hands: [hand({ fu: 10, hi: 1 }), hand({ fu: 10 })],
        // ゲージは満タンから始める（打っていく間も満タンのまま）
        skills: full("scout"),
      });
      const mine = ["a6", "a4", "a2", "b6", "b4", "b2", "e6"];
      const theirs = ["g3", "g5", "g7", "h3", "h5", "h7", "d3"];
      for (const [i, name] of mine.entries()) {
        for (const at of [name, theirs[i]]) g = playMove(g, ...parseCell(at), "fu");
      }
      return g;
    },
    answers: [{ at: parseCell("e3"), kind: "hi", skill: true }],
    guide: cells("e3"),
    hint: () => "光っているマスに飛を置いて、見えた相手の王を挟む",
    done(m) {
      const extra = m.king?.penalty ?? 0;
      if (m.king?.lose) return "偵察で見えた相手の王を裏返したので、あなたの勝ち。";
      return `偵察で見えた相手の王を裏返した。ダメージ ${m.damage} に王の分の ${extra} が加わり、相手の体力が ${m.damage + extra} 減った。`;
    },
  },
  kingmove: {
    id: "kingmove",
    title: SKILLS.kingmove.name,
    point: skillText("kingmove", std()).point,
    note: "赤い ! の王は、次の相手の手で裏返されそうな形。",
    task: useTask("kingmove", "光っている駒を押して王を移す。続けて光っているマスに歩を置く"),
    rules: std(),
    start() {
      // 王は b7（相手が b6 に置くと裏返される）、副将は a8。王から 2 マス以内で移せる駒は d8 だけ
      return gameFrom(this.rules, {
        stones: stones([
          ["b8", W, "fu"], ["b7", B, "fu"], ["a8", B, "fu"], ["d8", B, "fu"],
          ["g8", B, "fu"], ["g7", W, "fu"], ["h1", W, "fu"], ["h2", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"],
        ]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        kings: [parseCell("b7"), parseCell("h1")],
        vices: [parseCell("a8"), parseCell("h2")],
        skills: full("kingmove"),
      });
    },
    aim: { to: parseCell("d8") },
    answers: [{ at: parseCell("g6"), kind: "fu", skill: true }],
    guide: cells("g6"),
    hint: placeHint("fu"),
    done(_m, g) {
      const at = kingInfo(g, B).cell;
      const where = at ? `右の${label(g, g.board[at[0]][at[1]]!.kind)}` : "近くの駒";
      return `王を${where}へ移したので、赤い ! が消えた。相手には使ったことだけが分かり、どこへ移したかは見えない。`;
    },
  },
  fool: {
    id: "fool",
    title: SKILLS.fool.name,
    point: skillText("fool", std()).point,
    note: "2 手目のダメージは半分になる。",
    task: useTask("fool", "光っているマスに歩を置く"),
    rules: skillOnly(),
    start() {
      return gameFrom(this.rules, {
        stones: stones([
          ["c8", B, "kin"], ["c7", W, "fu"], ["c6", W, "fu"],
          ["g8", B, "fu"], ["g7", W, "kin"], ["a1", B, "fu"], ["a2", W, "fu"],
        ]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: full("fool"),
      });
    },
    answers: [{ at: parseCell("c5"), kind: "fu", skill: true }],
    guide: cells("c5"),
    hint: placeHint("fu"),
    then: {
      task: "もう 1 手。光っているマスに歩を置く",
      answers: [{ at: parseCell("g6"), kind: "fu" }],
      guide: cells("g6"),
      hint: placeHint("fu", "2 手目も打てる。"),
    },
    done(m, _g, after) {
      const first = after.history.filter((e): e is MoveEvent => e.type === "move" && e.player === B).at(-2);
      return `連続行動で 2 手続けて打った。1 手目は ${first?.damage ?? 0}、2 手目は ${m.plain ?? m.damage} の半分の ${m.damage} のダメージ。`;
    },
  },
  wheel: {
    id: "wheel",
    title: SKILLS.wheel.name,
    point: skillText("wheel", std()).point,
    note: "何が出るかは使うまで分からない。この練習では補充が出る。",
    task: useTask("wheel", "出た補充で金を戻し、光っているマスに置く"),
    rules: std(),
    start() {
      // 王（g8）と副将（c8）は決めてある。金は使い切ってある
      return gameFrom(this.rules, {
        stones: stones([
          ["c8", B, "fu"], ["d7", W, "fu"], ["g8", B, "fu"], ["g7", W, "fu"],
          ["h1", W, "fu"], ["h2", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"],
        ]),
        hands: refillHands(this.rules),
        kings: [parseCell("g8"), parseCell("h1")],
        vices: [parseCell("c8"), parseCell("h2")],
        skills: full("wheel"),
      });
    },
    wheel: "refill",
    aim: { kind: "kin" },
    answers: [{ at: parseCell("e6"), kind: "kin", skill: true }],
    guide: cells("e6"),
    hint: placeHint("kin", "戻した金を使う。"),
    done: (m, g) => {
      const n = noteOf(m);
      const effect = n?.effect ? SKILLS[n.effect].name : "効果";
      return `運命の輪で${effect}が出て、${label(g, n?.kind ?? "kin")}を駒台に戻した。出た効果は、そのカードを使ったときと同じに効く。`;
    },
  },
  judge: {
    id: "judge",
    title: SKILLS.judge.name,
    point: skillText("judge", std()).point,
    note: "さっき置いた歩ごと、相手の応手で金も裏返された。",
    task: useTask("judge", "光っているマスに打ち直す"),
    rules: skillOnly(),
    start() {
      // 自分が c5 に歩を置き、相手が c4 の歩で c5〜c7 を挟み返した局面（巻き戻せるのは、この 2 手）
      let g = gameFrom(this.rules, {
        stones: stones([["c8", W, "fu"], ["c7", B, "kin"], ["c6", W, "fu"], ["g8", B, "fu"], ["g7", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: full("judge"),
      });
      g = playMove(g, ...parseCell("c5"), "fu");
      return playMove(g, ...parseCell("c4"), "fu");
    },
    answers: [{ at: parseCell("g6"), kind: "fu", skill: true }],
    guide: cells("g6"),
    hint: (_g, m) => (m.r === 4 && m.c === 2 ? "そこはさっき挟み返された手。光っているマスに置く" : "光っているマスに歩を置く"),
    done(m, g) {
      const back = noteOf(m)?.back ?? 0;
      return `巻き戻しで ${back} 手戻り、相手に減らされた体力も ${g.hp[0]} に戻った。打ち直した手は ${m.damage} のダメージ。`;
    },
  },
};

/** スキル練習のステップ（一覧・コーチの順） */
export const SKILL_LESSONS: readonly Lesson[] = SKILL_ORDER.map((id) => CARD_LESSONS[id]);

/** id のステップの位置 */
export const skillLessonIndex = (id: SkillId) => SKILL_ORDER.indexOf(id);

/** 偵察のステップ（メインの遊び方の流れには入れない。前の版はここを SCOUT_LESSON として lessons.ts に残していた） */
export const SCOUT_LESSON: Lesson = CARD_LESSONS.scout;

/** 運命の輪の効果を決める乱数（wheelPool の並びで effect の位置に当たる値を返す） */
export function wheelRng(pool: readonly string[], effect: string): () => number {
  const i = pool.indexOf(effect);
  if (i < 0) throw new Error(`運命の輪で ${effect} は出ません`);
  return () => (i + 0.5) / pool.length;
}

// ---- 進み具合（localStorage。読めない・壊れていれば「まだ 1 枚も終えていない」） ----

export const SKILL_TUTORIAL_KEY = "kyosho:skill-tutorial";
const SAVE_VERSION = 1;

/** 終えたカード（SKILL_ORDER の順。保存がない・読めない・壊れていれば空） */
export function loadSkillDone(store: KeyValueStore): SkillId[] {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(SKILL_TUTORIAL_KEY) ?? "null");
  } catch {
    return [];
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  if (o.v !== SAVE_VERSION || !Array.isArray(o.done)) return [];
  const known = new Set<unknown>(o.done);
  return SKILL_ORDER.filter((id) => known.has(id));
}

/** 終えたカードを保存する */
export function saveSkillDone(store: KeyValueStore, done: readonly SkillId[]) {
  const set = new Set(done);
  store.setItem(SKILL_TUTORIAL_KEY, JSON.stringify({ v: SAVE_VERSION, done: SKILL_ORDER.filter((id) => set.has(id)) }));
}

/** メニューの「スキル練習」に添える短い状態 */
export function skillProgressLabel(done: readonly SkillId[]): string {
  if (done.length === 0) return `${SKILL_ORDER.length} 枚`;
  if (done.length >= SKILL_ORDER.length) return "クリア済み";
  return `${done.length}/${SKILL_ORDER.length}`;
}
