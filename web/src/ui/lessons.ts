// チュートリアル（遊び方）のステップ: 用意した局面で 1 手ずつ打って、ルールの要素を易しい順に覚える。
// 章は 2 つ: 標準ルール（LESSONS）と、標準を覚えた人がプリセット「スキルあり」で足されるものを覚える章（SKILL_LESSONS）。
// 局面は engine の gameFrom で作り、ダメージ・回復・予測・ゲージはすべてエンジン（playMove / previewMove / useSkill）の結果を見せる。
// DOM に依存しない（盤の誘導・コーチの表示は ui/app.ts と ui/coach.ts）。

import { parseCell, type Cell } from "../engine/board";
import { createGame, gameFrom, isLegal, kingInfo, playMove, previewMove, type GameState, type MoveEvent } from "../engine/game";
import { GAUGE_UNIT, gaugeMax, moverGain, SKILLS, VICE_DEADLINE, VICE_PENALTY, type SkillId } from "../engine/skills";
import {
  cloneRules,
  KIND_ORDER,
  NO_KING,
  PIECES,
  presetById,
  REACH_MARK,
  type Hand,
  type PieceKind,
  type Player,
  type RuleSet,
} from "../engine/rules";
import type { KeyValueStore } from "../net/online";
import { pieceLabel, skillText } from "./ruletext";

export type LessonId =
  | "flank"
  | "damage"
  | "dirs"
  | "hand"
  | "anchor"
  | "heal"
  | "king"
  | "kingAuto"
  | "kingHit"
  | "read"
  | "match"
  | "skillPick"
  | "skillGauge"
  | "skillUse"
  | "vice"
  | "viceHit"
  | "scout"
  | "skillMatch";

/** 遊び方の章（標準ルール・スキルあり） */
export type ChapterId = "std" | "skill";

/** プレイヤーが打とうとした手（王・副将にするか、この手番でスキルを使ったかを含む） */
export interface LessonMove {
  r: number;
  c: number;
  kind: PieceKind;
  king: boolean;
  /** 副将にして置く */
  vice?: boolean;
  /** この手番でスキルを使ってある */
  skill?: boolean;
}

/** 正解の手 */
export interface Answer {
  at: Cell;
  kind: PieceKind;
  /** 王にして置く */
  king?: boolean;
  /** 副将にして置く */
  vice?: boolean;
  /** 置く前に名札のスキルを使う */
  skill?: boolean;
}

export interface Lesson {
  id: LessonId;
  /** 短い見出し */
  title: string;
  /** このステップで覚えるルールの要点（大きく太く出す一言。句点を付けない） */
  point: string;
  /** 要点の補足（小さく添える 1 文。何を見ればよいか・数え方）。課題と合わせて文が多くなるステップは付けない */
  note?: string;
  /** 盤ですること（命令形の 1 文） */
  task: string;
  rules: RuleSet;
  /** 実戦（CPU イージー・章のルール・制限時間なし）。局面・正解・誘導はない */
  match?: true;
  /**
   * 盤に打たず、対局の前のカードを選ぶステップ（配り直してから 1 枚選べば正解）。answers・guide は空。
   * done はカードを選んだ後の 1 文
   */
  pick?: { done(card: SkillId, g: GameState): string };
  /** 始めの局面（先手 = プレイヤーの手番） */
  start(): GameState;
  answers: readonly Answer[];
  /** 光らせて誘導するマス（候補から選ばせるステップは候補すべて） */
  guide: readonly Cell[];
  /** 盤の駒に添える印（例: 見えないはずの相手の王の「?」） */
  marks?: readonly { at: Cell; text: string; label: string }[];
  /** 正解ではないマスに置こうとしたときのヒント（置けないマスなら preview は null） */
  hint(g: GameState, m: LessonMove): string;
  /** 正解を打った後の、何が起きたかの 1 文（エンジンの棋譜の値を使う。g は打つ前、after は打った後の局面） */
  done(m: MoveEvent, g: GameState, after: GameState): string;
}

const B: Player = 0;
const W: Player = 1;

/** 教える標準ルール（既定の DEFAULT_PRESET が変わっても、チュートリアルは標準を教える） */
const std = (): RuleSet => cloneRules(presetById("std").rules);
const STD = std();

/** 標準から、まだ習っていない要素を外したルール（体力・駒の数字は標準のまま） */
function rulesWith(on: { dirs?: true; anchor?: true; heal?: true; king?: true }): RuleSet {
  const r = std();
  if (!on.dirs) r.dirs = "all";
  if (!on.anchor) r.anchor = "none";
  if (!on.heal) r.heal = "none";
  if (!on.king) r.king = { ...NO_KING };
  return r;
}

const hand = (h: Partial<Hand>): Hand => ({ ...(Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Hand), ...h });

type StoneSpec = [name: string, owner: Player, kind: PieceKind];
const stones = (list: StoneSpec[]) => list.map(([name, owner, kind]) => ({ at: parseCell(name), owner, kind }));
const cells = (...names: string[]) => names.map(parseCell);
const sameCell = (a: Cell, r: number, c: number) => a[0] === r && a[1] === c;

// ---- 文の部品 ----
// 文は初めて遊ぶ人が一度読めば分かる言葉で書く。内部の用語（端の駒・上乗せ・期限など）は使わず、盤の上の物を指して言い、
// 結果はいま盤で起きた数字で言う。1 文に 1 つのことだけ。チュートリアルは標準（裏返すルール）だけを教える

/** 駒の名前と数字（例: 「金5」。盤の駒の字と同じ書き方） */
const label = (g: GameState, k: PieceKind) => pieceLabel(g.rules, k);
/** 駒の並び（例: 「歩1と金5」） */
const labels = (g: GameState, kinds: readonly PieceKind[]) => kinds.map((k) => label(g, k)).join("と");
/** 数字の足し算（例: 「1＋5」）。式の途中で行を折り返さないよう、＋の前後に WORD JOINER（U+2060）を挟む */
export const PLUS = "\u2060＋\u2060";
const sumText = (g: GameState, kinds: readonly PieceKind[]) => kinds.map((k) => g.rules.values[k]).join(PLUS);
/** プレビューで裏返す駒の種類 */
const previewKinds = (g: GameState, cellsOf: readonly Cell[]) => cellsOf.map(([y, x]) => g.board[y][x]!.kind);
/** 王を裏返されたときに起きること（例: 「体力が 30 減る」） */
const kingLoss = (r: RuleSet) => (r.king.penalty === "lose" ? "その場で負けになる" : `体力が ${r.king.amount} 減る`);

const pickHint = "光っているマスのどちらかに置く";

export const LESSONS: readonly Lesson[] = [
  {
    id: "flank",
    title: "挟む",
    point: "白い駒を挟むと、黒に裏返る",
    note: "あなたは黒で、挟み方はオセロと同じ。",
    task: "光っているマスをタップして、歩を置く",
    rules: rulesWith({}),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["d8", B, "fu"], ["d7", W, "fu"], ["d6", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("d5"), kind: "fu" }],
    guide: cells("d5"),
    hint: () => "そこでは白い駒を挟めない。光っているマスに置く",
    done: (m) => `白い歩を ${m.targets.length} つ挟んで、黒に裏返した。`,
  },
  {
    id: "damage",
    title: "ダメージ",
    point: "裏返した駒の数字の合計がダメージ",
    note: "駒の漢字の右下にある小さな数字が、その駒の強さ。",
    task: "光っているマスのうち、金と歩を両方挟めるほうに歩を置く",
    rules: rulesWith({}),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["f8", B, "fu"], ["f7", W, "kin"], ["f6", W, "fu"], ["b8", B, "fu"], ["b7", W, "fu"], ["b6", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        hp: [this.rules.hp[0], 6],
      });
    },
    answers: [{ at: parseCell("f5"), kind: "fu" }],
    guide: cells("b5", "f5"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      if (!pv) return pickHint;
      return `そこで裏返せるのは${labels(g, previewKinds(g, pv.targets))}で、ダメージは ${pv.damage} しかない。金も挟めるマスに置く`;
    },
    done(m, g) {
      const kinds = m.targets.map((t) => t.kind);
      const left = g.hp[1] - m.damage;
      return `${labels(g, kinds)}を裏返して、${sumText(g, kinds)} で ${m.damage} のダメージ。${left <= 0 ? "相手の体力が 0 になったので、あなたの勝ち。" : `相手の体力は残り ${left}。`}`;
    },
  },
  {
    id: "dirs",
    title: "駒の向き",
    point: "駒ごとに挟める向きが違う",
    note: "駒の上の矢印が挟める向きで、歩は縦だけ、飛は縦と横。",
    task: "駒台の飛をタップしてから、光っているマスに置く",
    rules: rulesWith({ dirs: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["b4", B, "fu"], ["c4", W, "fu"], ["d4", W, "fu"], ["g8", B, "fu"], ["g7", W, "fu"]]),
        hands: [hand({ fu: 3, hi: 1 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("e4"), kind: "hi" }],
    guide: cells("e4"),
    hint: () => "光っているマスに飛を置いて、横に並んだ白い歩を挟む",
    done: (m) =>
      `${PIECES[m.kind].name}で、横に並んだ白い歩を ${m.targets.length} つ裏返した。盤に出る点線の枠は、ふつうのオセロなら置けるマスの目印。駒の向きが合わないと、そこにも置けない。`,
  },
  {
    id: "hand",
    title: "持ち駒",
    point: "残りが 0 になった駒は置けない",
    note: "駒台にある駒が持ち駒で、丸の中の数字が残りの数。",
    task: "残り 1 つの金をタップしてから、光っているマスに置く",
    rules: rulesWith({ dirs: true }),
    start() {
      const r = this.rules;
      return gameFrom(r, {
        // 自分の駒は盤の端に置き、相手に挟み返されない形にする（「!」を出さない）
        stones: stones([["c1", B, "fu"], ["c2", W, "fu"], ["a3", B, "fu"], ["b3", W, "fu"], ["a1", B, "fu"], ["b2", W, "yoko"]]),
        hands: [{ ...r.hand, kin: 1 }, { ...r.hand }],
      });
    },
    answers: [{ at: parseCell("c3"), kind: "kin" }],
    guide: cells("c3"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      if (pv && m.kind !== "kin") return `${PIECES[m.kind].name}だと ${pv.targets.length} つしか裏返せない。駒台の金をタップしてから置く`;
      return "光っているマスに金を置く";
    },
    done: (m, g) => {
      const left = g.hands[0][m.kind] - 1;
      const name = PIECES[m.kind].name;
      return `${name}は全部の向きに挟めるので、${m.targets.length} つまとめて裏返した。${left > 0 ? `${name}の残りは ${left}。` : `${name}の残りが 0 になったので、この対局ではもう${name}を置けない。`}`;
    },
  },
  {
    id: "anchor",
    title: "反対側の駒",
    point: "反対側の自分の駒の数字も、ダメージに足す",
    note: "置く前にマスをタップすると、置いた駒の反対側にある自分の駒が青い枠で光る。",
    task: "光っているマスのうち、反対側が自分の金になるほうに歩を置く",
    rules: rulesWith({ dirs: true, anchor: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["d8", B, "kin"], ["d7", W, "fu"], ["g8", B, "fu"], ["g7", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("d6"), kind: "fu" }],
    guide: cells("d6", "g6"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      if (!pv) return pickHint;
      return `そこだと反対側の自分の駒は${labels(g, pv.anchors.map((a) => a.kind))}で、ダメージは ${pv.damage}。反対側が金になるマスに置く`;
    },
    done(m, g) {
      const flipped = m.targets.map((t) => t.kind);
      const ends = (m.anchors ?? []).map((a) => a.kind);
      return `裏返した${labels(g, flipped)}に、反対側の${labels(g, ends)}が足された。${sumText(g, [...flipped, ...ends])} で ${m.damage} ダメージ。`;
    },
  },
  {
    id: "heal",
    title: "回復",
    point: "挟むと、自分の体力も回復",
    note: "置いた駒と反対側の駒のうち、小さいほうの数字から 1 を引いた分だけ回復する。",
    task: "駒台の飛をタップしてから、光っているマスに置く",
    rules: rulesWith({ dirs: true, anchor: true, heal: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["a3", B, "kin"], ["b3", W, "fu"], ["g8", B, "kin"], ["g7", W, "fu"]]),
        hands: [hand({ fu: 3, hi: 1 }), hand({ fu: 3 })],
        hp: [100, this.rules.hp[1]],
      });
    },
    // 光る 2 マスはどちらも反対側が金。飛ならどちらでも同じだけ回復する
    answers: [{ at: parseCell("c3"), kind: "hi" }, { at: parseCell("g6"), kind: "hi" }],
    guide: cells("c3", "g6"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      if (!pv || pv.heal > 0) return pickHint;
      const end = pv.anchors[0]?.kind;
      const low = Math.min(g.rules.values[m.kind], end ? g.rules.values[end] : 0);
      const pair = end ? `${label(g, m.kind)}と${label(g, end)}で挟むと、` : "";
      return `${pair}小さいほうの ${low} から 1 を引いて、回復は 0。駒台の飛をタップしてから置く`;
    },
    done(m, g) {
      const v = g.rules.values;
      // 回復は挟んだ向きのうちいちばん多いもの。その向きの反対側の駒で説明する
      const end = (m.anchors ?? []).map((a) => a.kind).find((k) => Math.max(0, Math.min(v[m.kind], v[k]) - 1) === m.heal);
      if (!end) return `体力が ${m.heal} 回復した。`;
      const low = Math.min(v[m.kind], v[end]);
      return `${label(g, m.kind)}と${label(g, end)}で挟んだ。小さいほうの ${low} から 1 を引いた ${m.heal} だけ、体力が回復した。`;
    },
  },
  {
    id: "king",
    title: "王を決める",
    point: `最初の ${STD.king.deadline} 手のうちに、駒を 1 つ王にする`,
    note: "どの駒が王かは、相手には見えない。",
    task: "駒台の右にある王をタップしてから、光っているマスに歩を置く",
    rules: rulesWith({ dirs: true, anchor: true, heal: true, king: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["e8", B, "fu"], ["e7", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("e6"), kind: "fu", king: true }],
    guide: cells("e6"),
    hint: () => "光っているマスに歩を置く",
    done: (m, g) => `この${label(g, m.kind)}があなたの王になった。王を相手に裏返されると、ダメージとは別に${kingLoss(g.rules)}。`,
  },
  {
    id: "kingAuto",
    title: "自動で王に",
    point: `王を決めないと、${STD.king.deadline} 手目の駒が王になる`,
    note: "数えるのは自分の手だけで、相手の手は数えない。",
    task: `${STD.king.deadline} 手目の歩を、光っているマスに置く`,
    rules: rulesWith({ dirs: true, anchor: true, heal: true, king: true }),
    start() {
      // 王を決めずに、お互い期限の 1 手前まで打った局面（自分は左の 2 列を下から、相手は右の 2 列を上から）。
      // どちらの列も盤の端から続く同じ色の並びになり、縦にしか挟めない歩では挟み返せない（「!」を出さない）
      let g = gameFrom(this.rules, {
        stones: stones([
          ["a8", B, "fu"], ["a7", W, "fu"], ["a5", W, "fu"], ["a3", W, "fu"],
          ["b8", B, "fu"], ["b7", W, "fu"], ["b5", W, "fu"], ["b3", W, "fu"],
          ["g1", W, "fu"], ["g2", B, "fu"], ["g4", B, "fu"], ["g6", B, "fu"],
          ["h1", W, "fu"], ["h2", B, "fu"], ["h4", B, "fu"], ["h6", B, "fu"],
          ["e8", B, "fu"], ["e7", W, "fu"],
        ]),
        hands: [hand({ fu: 10 }), hand({ fu: 10 })],
      });
      const mine = ["a6", "a4", "a2", "b6", "b4", "b2"];
      const theirs = ["g3", "g5", "g7", "h3", "h5", "h7"];
      for (const [i, name] of mine.entries()) {
        for (const at of [name, theirs[i]]) g = playMove(g, ...parseCell(at), "fu");
      }
      return g;
    },
    answers: [{ at: parseCell("e6"), kind: "fu" }],
    guide: cells("e6"),
    hint: () => "光っているマスに歩を置く",
    done: (m, g) =>
      `王を決めないまま ${kingInfo(g, 0).nextMove} 手目に置いたので、この${label(g, m.kind)}が自動であなたの王になった。好きな駒を王にしたいときは、それより前に駒台の王をタップする。`,
  },
  {
    id: "kingHit",
    title: "王を裏返す",
    point: `王を裏返すと、相手の${kingLoss(STD)}`,
    task: "この練習では「?」の駒が相手の王。光っているマスに歩を置いて挟む",
    rules: std(),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["c8", B, "fu"], ["c7", W, "kin"], ["g8", B, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        kings: [parseCell("g8"), parseCell("c7")],
      });
    },
    answers: [{ at: parseCell("c6"), kind: "fu" }],
    guide: cells("c6"),
    marks: [{ at: parseCell("c7"), text: "?", label: "相手の王" }],
    hint: () => "光っているマスに歩を置いて、「?」の駒を挟む",
    done(m) {
      const extra = m.king?.penalty ?? 0;
      if (m.king?.lose) return "相手の王を裏返したので、あなたの勝ち。";
      return `相手の王を裏返した。ダメージ ${m.damage} に王の分の ${extra} が加わり、相手の体力が ${m.damage + extra} 減った。`;
    },
  },
  {
    id: "read",
    title: "予測を読む",
    point: "! の付いた駒は、次に裏返されるかもしれない",
    note: "置く前にマスをタップすると、結果が先に出る。",
    task: "光っている 2 マスを見比べて、置いた歩に ! が付かないほうに置く",
    rules: std(),
    start() {
      return gameFrom(this.rules, {
        stones: stones([
          ["d8", B, "fu"], ["d7", W, "kin"], ["c6", W, "fu"],
          ["g8", B, "fu"], ["g7", W, "fu"],
          // 普通のオセロなら置けるが、縦の歩では置けないマス（c4）の点線の枠
          ["a4", B, "fu"], ["b4", W, "fu"],
        ]),
        hands: [hand({ fu: 3 }), hand({ fu: 2, yoko: 2 })],
        kings: [parseCell("a4"), parseCell("c6")],
      });
    },
    answers: [{ at: parseCell("g6"), kind: "fu" }],
    guide: cells("d6", "g6"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      if (pv?.exposed.some(([y, x]) => y === m.r && x === m.c)) {
        return `そこに置くと、置いた${PIECES[m.kind].name}が次の相手の手で裏返される。! が付かないマスに置く`;
      }
      return pickHint;
    },
    done(m, g) {
      // 光っているもう一方（置いた駒が裏返されるマス）と比べる
      const other = this.guide.find(([y, x]) => y !== m.r || x !== m.c);
      const pv = other ? previewMove(g, other[0], other[1], m.kind) : null;
      const name = PIECES[m.kind].name;
      const head = `このマスはダメージ ${m.damage} で、置いた${name}は次の相手の手で裏返されない。`;
      return pv && pv.damage > m.damage ? `${head}もう一方はダメージ ${pv.damage} だが、置いた${name}をすぐ裏返されていた。` : head;
    },
  },
  {
    id: "match",
    title: "実戦",
    point: "覚えたルールを全部使って対局",
    note: "この対局には時間の制限がない。",
    task: "強さイージーの CPU と、最後まで対局する",
    rules: std(),
    match: true,
    start() {
      return createGame(this.rules);
    },
    answers: [],
    guide: [],
    hint: () => "",
    done: () => "",
  },
];

// ---- スキルあり の章 ----
// 標準を覚えた人に、プリセット「スキルあり」で足されるもの（カードを選ぶ・ゲージ・使う・副将・偵察）を教える。
// カード・ゲージの値はエンジン（skills.ts）のものを使い、文に出す数字は打った後の局面との差から取る

/** 教えるスキルありのルール（標準＋スキル。副将は隠し王ありのときだけ） */
const skillRules = (): RuleSet => cloneRules(presetById("skill").rules);
/** スキルありから隠し王（と副将）を外したルール（ゲージ・使うだけを覚えるステップ。王・副の鍵を出さない） */
function skillOnly(): RuleSet {
  const r = skillRules();
  r.king = { ...NO_KING };
  return r;
}

/** 手番の人（先手）のゲージの、打つ前から打った後に増えた点（GAUGE_UNIT を 1 点に直す） */
const gaugeGain = (before: GameState, after: GameState) => (after.skills!.sides[0].gauge - before.skills!.sides[0].gauge) / GAUGE_UNIT;
/** 先手のカードの名前 */
const cardName = (g: GameState) => {
  const card = g.skills?.sides[0].card;
  return card ? SKILLS[card].name : "スキル";
};

export const SKILL_LESSONS: readonly Lesson[] = [
  {
    id: "skillPick",
    title: "カードを選ぶ",
    point: "対局の前に、3 枚から 1 枚を選ぶ",
    note: "配り直しは 1 局に 1 回で、ほかの 8 枚から新しく 3 枚が来る。",
    task: "配り直しを押してから、好きなカードを 1 枚選ぶ",
    rules: skillRules(),
    start() {
      // 盤は選ぶ画面の後ろに見えるだけ（「!」の出ない形）。相手は選び終えてある
      return gameFrom(this.rules, {
        stones: stones([["e8", B, "fu"], ["e7", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: [{ offer: ["firstaid", "strong", "wall"] }, { card: "firstaid" }],
      });
    },
    answers: [],
    guide: [],
    pick: {
      done(card, g) {
        return `${SKILLS[card].name}を選んだ。${skillText(card, g.rules).point}。ゲージが満タンになるたびに使える。`;
      },
    },
    hint: () => PICK_HINT,
    done: () => "",
  },
  {
    id: "skillGauge",
    title: "ゲージを溜める",
    point: "裏返した数だけ、ゲージが溜まる",
    note: "1 手で多く裏返すほど、まとめて多く溜まる。",
    task: "光っているマスのうち、多く裏返せるほうに歩を置く",
    rules: skillOnly(),
    start() {
      // 強打のゲージは満タンの 4 点手前。h4 は 3 つ裏返して 4 点で満タン、b6 は 1 つで 1 点（どちらも溜めマスの外）
      return gameFrom(this.rules, {
        stones: stones([["h8", B, "fu"], ["h7", W, "fu"], ["h6", W, "fu"], ["h5", W, "fu"], ["b8", B, "fu"], ["b7", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: [{ card: "strong", gauge: gaugeMax("strong") - 4 * GAUGE_UNIT }, {}],
      });
    },
    answers: [{ at: parseCell("h4"), kind: "fu" }],
    guide: cells("b6", "h4"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      const card = g.skills?.sides[0].card;
      if (!pv || !card) return pickHint;
      const gain = moverGain(card, [m.r, m.c], pv.targets.map(([r, c]) => ({ r, c }))) / GAUGE_UNIT;
      return `そこで裏返せるのは ${pv.targets.length} つで、ゲージは ${gain} しか溜まらない。多く裏返せるマスに置く`;
    },
    done(m, g, after) {
      const full = after.skills!.sides[0].gauge >= gaugeMax(after.skills!.sides[0].card!);
      return `${PIECES[m.kind].name}で ${m.targets.length} つ裏返して、ゲージが ${gaugeGain(g, after)} 溜まった。${full ? "満タンになったので、次の自分の手番で使える。" : ""}`;
    },
  },
  {
    id: "skillUse",
    title: "スキルを使う",
    point: "満タンになったら、置く前に使う",
    note: "使えるのは自分の手番の初めで、使うとゲージは 0 に戻る。",
    task: "名札の強打を押してから、光っているマスに歩を置く",
    rules: skillOnly(),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["d8", B, "kin"], ["d7", W, "fu"], ["d6", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        skills: [{ card: "strong", gauge: gaugeMax("strong") }, {}],
      });
    },
    answers: [{ at: parseCell("d5"), kind: "fu", skill: true }],
    guide: cells("d5"),
    hint: () => "光っているマスに歩を置く",
    done(m) {
      const name = m.skill ? SKILLS[m.skill.id].name : "スキル";
      return m.plain === undefined ? `${name}を使った。` : `${name}で、ダメージ ${m.plain} が ${m.damage} になった。ゲージはまた 0 から溜める。`;
    },
  },
  {
    id: "vice",
    title: "副将を置く",
    point: `王の後は、${VICE_DEADLINE} 手ごとに副将を置き直す`,
    note: `置かないと、${VICE_DEADLINE} 手目に置いた駒が自動で副将になる。`,
    task: "駒台の右にある副をタップしてから、光っているマスに歩を置く",
    rules: skillRules(),
    start() {
      // 王はお互い決めてある（自分は e8、相手は h1）。a1・a2 は正解の後も自分に打てる手を残し、終局させない（終局すると相手の王が見える）
      return gameFrom(this.rules, {
        stones: stones([["e8", B, "fu"], ["e7", W, "fu"], ["h1", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        kings: [parseCell("e8"), parseCell("h1")],
        skills: [{}, {}],
      });
    },
    answers: [{ at: parseCell("e6"), kind: "fu", vice: true }],
    guide: cells("e6"),
    hint: () => "光っているマスに歩を置く",
    done: (m, g) =>
      `この${label(g, m.kind)}があなたの副将になった。相手には見えず、裏返されると体力が ${VICE_PENALTY} 減る。${VICE_DEADLINE} 手ごとに新しい副将を置き、前の副将はふつうの駒に戻る。`,
  },
  {
    id: "viceHit",
    title: "副将を裏返す",
    point: `副将を裏返すと、相手の体力が ${VICE_PENALTY} 減る`,
    task: "この練習では「?」の駒が相手の副将。光っているマスに歩を置いて挟む",
    rules: skillRules(),
    start() {
      // 王と副将はお互い決めてある（自分の王 g8・副将 a8、相手の王 h1・副将 c7）。a1・a2 は終局させないため
      return gameFrom(this.rules, {
        stones: stones([["c8", B, "fu"], ["c7", W, "kin"], ["g8", B, "fu"], ["a8", B, "fu"], ["h1", W, "fu"], ["a1", B, "fu"], ["a2", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
        kings: [parseCell("g8"), parseCell("h1")],
        vices: [parseCell("a8"), parseCell("c7")],
        skills: [{}, {}],
      });
    },
    answers: [{ at: parseCell("c6"), kind: "fu" }],
    guide: cells("c6"),
    marks: [{ at: parseCell("c7"), text: "?", label: "相手の副将" }],
    hint: () => "光っているマスに歩を置いて、「?」の駒を挟む",
    done(m) {
      const extra = m.vice?.penalty ?? 0;
      return `相手の副将を裏返した。ダメージ ${m.damage} に副将の分の ${extra} が加わり、相手の体力が ${m.damage + extra} 減った。裏返した副将はふつうの駒になり、相手は次の ${VICE_DEADLINE} 手の区切りで新しい副将を置く。`;
    },
  },
  {
    id: "scout",
    title: "偵察",
    point: "偵察で、相手の王の場所が分かる",
    note: "王が分かった後に使うと、次は相手の副将の場所が分かる。",
    task: "名札の偵察を押してから、見えた相手の王を飛で挟む",
    rules: skillRules(),
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
        skills: [{ card: "scout", gauge: gaugeMax("scout") }, {}],
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
  {
    id: "skillMatch",
    title: "実戦",
    point: "スキルを使って対局",
    note: "この対局には時間の制限がない。",
    task: "カードを選んで、強さイージーの CPU と最後まで対局する",
    rules: skillRules(),
    match: true,
    start() {
      return createGame(this.rules);
    },
    answers: [],
    guide: [],
    hint: () => "",
    done: () => "",
  },
];

/** 章ごとのステップ */
export const CHAPTERS: Readonly<Record<ChapterId, readonly Lesson[]>> = { std: LESSONS, skill: SKILL_LESSONS };
export const CHAPTER_IDS: readonly ChapterId[] = ["std", "skill"];
/** 章の名前（メニューの遊び方の項目） */
export const CHAPTER_NAME: Readonly<Record<ChapterId, string>> = { std: "基本のルール", skill: "スキルあり" };

/** 実戦を終えたときのコーチの 1 文 */
export const FINISHED_TEXT = "遊び方はこれで終わり。メニューから、同じルールで CPU や人と対局できる。";
/** スキルありの実戦を終えたときのコーチの 1 文 */
export const SKILL_FINISHED_TEXT = "スキルありの遊び方はこれで終わり。設定でスキルありを選ぶと、スキルを使って対局できる。";
/** 章を終えたときの 1 文 */
export const finishedText = (chapter: ChapterId) => (chapter === "skill" ? SKILL_FINISHED_TEXT : FINISHED_TEXT);

/** 王にしないで置こうとしたときのヒント */
export const KING_HINT = "王にするには、先に駒台の右にある王をタップする";
/** 副将にしないで置こうとしたときのヒント */
export const VICE_HINT = "副将にするには、先に駒台の右にある副をタップする";
/** 配り直す前にカードを選ぼうとしたときのヒント */
export const PICK_HINT = "選ぶ前に、配り直しを押す";
/** スキルを使う前に置こうとしたときのヒント */
export const skillHint = (g: GameState) => `先に名札の${cardName(g)}を押して使う`;

/** 選んでいる駒（have）では正解の駒（need）の向きに挟めない・違う駒のときのヒント */
export function kindHint(r: RuleSet, have: PieceKind, need: PieceKind): string {
  const reach = PIECES[have].reach;
  const limited = r.dirs === "piece" && reach !== "all" && reach !== PIECES[need].reach;
  const why = limited ? `${PIECES[have].name}は${REACH_MARK[reach].short}にしか挟めない。` : "";
  return `${why}駒台の${PIECES[need].name}をタップしてから置く`;
}

/**
 * 打とうとした手の判定。正解なら null、違えばヒント（盤は変えない）。
 * 正解のマスに違う駒・王にしないで置こうとしたときは、そのことを知らせる。
 * 違う駒でもそのマスに置ける（向きは合う）なら、なぜその駒ではだめかはステップのヒントが言う
 */
export function judgeMove(l: Lesson, g: GameState, m: LessonMove): string | null {
  // スキルを使ってから置くステップは、使う前に置こうとしたらどこでも先に使うよう知らせる
  if (l.answers.length > 0 && l.answers.every((a) => a.skill) && !m.skill) return skillHint(g);
  const here = l.answers.filter((a) => sameCell(a.at, m.r, m.c));
  if (here.length === 0) return l.hint(g, m);
  const a = here.find((x) => x.kind === m.kind);
  if (!a) return isLegal(g, m.r, m.c, m.kind) ? l.hint(g, m) : kindHint(l.rules, m.kind, here[0].kind);
  if (a.king && !m.king) return KING_HINT;
  if (a.vice && !m.vice) return VICE_HINT;
  return null;
}

/** 置けないマスを押したときのヒント（空いていないマスは null。何も言わない） */
export function illegalHint(l: Lesson, g: GameState, m: LessonMove): string | null {
  if (g.board[m.r][m.c] !== null) return null;
  return judgeMove(l, g, m) ?? l.hint(g, m);
}

/** 盤より先にすること */
export interface Need {
  /** 名札のスキルを使う */
  skill?: true;
  /** 駒台で選ぶ駒 */
  kind?: PieceKind;
  /** 王の鍵を押す */
  king?: true;
  /** 副の鍵を押す */
  vice?: true;
}

/**
 * 次にすること（盤より先に名札のスキルを使う・駒台で選ぶ駒・王・副を押す）。選んでいる駒・王と副の選択・使ったスキルから決める。
 * スキルを使うまでは、ほかの誘導を出さない（光るマスも App が隠す）
 */
export function nextNeed(l: Lesson, selected: PieceKind, kingOn: boolean, more: { viceOn?: boolean; skill?: boolean } = {}): Need {
  if (l.answers.length > 0 && l.answers.every((a) => a.skill) && !more.skill) return { skill: true };
  const kinds = new Set(l.answers.map((a) => a.kind));
  if (kinds.size === 1 && !kinds.has(selected)) return { kind: [...kinds][0] };
  if (l.answers.some((a) => a.king) && !kingOn) return { king: true };
  if (l.answers.some((a) => a.vice) && !more.viceOn) return { vice: true };
  return {};
}

// ---- 進み具合（localStorage。読めない・壊れていれば「はじめて」） ----

export const TUTORIAL_KEY = "kyosho:tutorial";

/**
 * 保存の形: 標準の章は従来どおり一番上の { step, reached, done }、スキルありの章は skill キーの中に同じ形で持つ
 * （skill キーのない古い保存は、スキルありを開いたことがないものとして読む）
 */
export interface Progress {
  /** 前回開いていたステップ（0 始まり） */
  step: number;
  /** 開いたことのある最も先のステップ */
  reached: number;
  /** 最後の実戦まで終えた */
  done: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 保存の中身（読めない・壊れていれば null） */
function readSaved(store: KeyValueStore): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(store.getItem(TUTORIAL_KEY) ?? "null");
    return isObject(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 章の進み具合を検証する（範囲外・形が違えば null） */
function progressOf(o: unknown, count: number): Progress | null {
  if (!isObject(o)) return null;
  const isStep = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < count;
  if (!isStep(o.step)) return null;
  const reached = isStep(o.reached) ? Math.max(o.reached, o.step) : o.step;
  return { step: o.step, reached, done: o.done === true };
}

/** 保存した章の進み具合。保存がない・読めないときは null（はじめて） */
export function loadProgress(store: KeyValueStore, chapter: ChapterId = "std"): Progress | null {
  const o = readSaved(store);
  if (!o) return null;
  return progressOf(chapter === "std" ? o : o.skill, CHAPTERS[chapter].length);
}

/** 章の進み具合を保存する（もう一方の章の保存は残す） */
export function saveProgress(store: KeyValueStore, p: Progress, chapter: ChapterId = "std") {
  const o = readSaved(store) ?? {};
  const plain = { step: p.step, reached: p.reached, done: p.done };
  store.setItem(TUTORIAL_KEY, JSON.stringify(chapter === "std" ? { ...o, ...plain } : { ...o, skill: plain }));
}

/** i 番目のステップを開いたときの進み具合 */
export const progressAt = (p: Progress | null, i: number): Progress => ({
  step: i,
  reached: Math.max(p?.reached ?? 0, i),
  done: p?.done ?? false,
});

/** メニューから始めるステップ（途中なら前回の位置、終えていれば最初から） */
export const resumeStep = (p: Progress | null) => (!p || p.done ? 0 : p.step);

/** メニューの「遊び方」・章の項目に添える短い状態（スキルありは、はじめてなら何も添えない） */
export function progressLabel(p: Progress | null, chapter: ChapterId = "std"): string {
  if (!p) return chapter === "std" ? "おすすめ" : "";
  if (p.done) return "クリア済み";
  return `つづき ${p.step + 1}/${CHAPTERS[chapter].length}`;
}
