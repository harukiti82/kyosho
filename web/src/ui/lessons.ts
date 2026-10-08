// チュートリアル（遊び方）のステップ: 用意した局面で 1 手ずつ打って、標準ルールの要素を易しい順に覚える。
// 局面は engine の gameFrom で作り、ダメージ・回復・予測はすべてエンジン（playMove / previewMove）の結果を見せる。
// DOM に依存しない（盤の誘導・コーチの表示は ui/app.ts と ui/coach.ts）。

import { parseCell, type Cell } from "../engine/board";
import { createGame, gameFrom, isLegal, previewMove, type GameState, type MoveEvent } from "../engine/game";
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
import { pieceLabel } from "./ruletext";

export type LessonId = "flank" | "damage" | "dirs" | "hand" | "anchor" | "heal" | "king" | "kingHit" | "read" | "match";

/** プレイヤーが打とうとした手（王にするかを含む） */
export interface LessonMove {
  r: number;
  c: number;
  kind: PieceKind;
  king: boolean;
}

/** 正解の手 */
export interface Answer {
  at: Cell;
  kind: PieceKind;
  /** 王にして置く */
  king?: boolean;
}

export interface Lesson {
  id: LessonId;
  /** 短い見出し */
  title: string;
  /** このステップで覚えるルール（1 文） */
  lead: string;
  /** 盤ですること（命令形の 1 文） */
  task: string;
  rules: RuleSet;
  /** 実戦（CPU イージー・標準・制限時間なし）。局面・正解・誘導はない */
  match?: true;
  /** 始めの局面（先手 = プレイヤーの手番） */
  start(): GameState;
  answers: readonly Answer[];
  /** 光らせて誘導するマス（候補から選ばせるステップは候補すべて） */
  guide: readonly Cell[];
  /** 盤の駒に添える印（例: 見えないはずの相手の王の「?」） */
  marks?: readonly { at: Cell; text: string; label: string }[];
  /** 正解ではないマスに置こうとしたときのヒント（置けないマスなら preview は null） */
  hint(g: GameState, m: LessonMove): string;
  /** 正解を打った後の、何が起きたかの 1 文（エンジンの棋譜の値を使う） */
  done(m: MoveEvent, g: GameState): string;
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
    lead: "あなたは黒。オセロと同じように、白い駒を黒で挟むと、裏返して黒にできる。",
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
    lead: "駒の漢字の右下にある小さな数字が、その駒の強さ。裏返した駒の数字を足した分が、相手へのダメージになる。",
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
    lead: "駒の上の矢印は、その駒で挟める向き。歩は縦だけ、飛は縦と横に挟める。",
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
    lead: "駒台にある駒を持ち駒と呼ぶ。丸の中の数字が残りの数で、0 になるとその駒はもう置けない。",
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
    lead: "相手の駒を挟んだとき、置いた駒の反対側にある自分の駒の数字も、ダメージに足される。置く前にマスをタップすると、その駒が青い枠で光る。",
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
    lead: "挟むと、自分の体力も回復する。置いた駒と反対側の駒のうち、小さいほうの数字から 1 を引いた分だけ回復する。",
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
    lead: `最初の ${STD.king.deadline} 手のうちどれか 1 手で、置く駒を王にする。どの駒が王かは、相手には見えない。`,
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
    id: "kingHit",
    title: "王を裏返す",
    lead: `相手の王を裏返すと、ダメージとは別に相手の${kingLoss(STD)}。`,
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
    lead: "置く前にマスをタップすると、結果が先に出る。! の付いた駒は、次の相手の手で裏返されるかもしれない。",
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
    lead: "ここまで覚えたルールを全部使う、ふつうの対局。この対局には時間の制限がない。",
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

/** 実戦を終えたときのコーチの 1 文 */
export const FINISHED_TEXT = "遊び方はこれで終わり。メニューから、同じルールで CPU や人と対局できる。";

/** 王にしないで置こうとしたときのヒント */
export const KING_HINT = "王にするには、先に駒台の右にある王をタップする";

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
  const here = l.answers.filter((a) => sameCell(a.at, m.r, m.c));
  if (here.length === 0) return l.hint(g, m);
  const a = here.find((x) => x.kind === m.kind);
  if (!a) return isLegal(g, m.r, m.c, m.kind) ? l.hint(g, m) : kindHint(l.rules, m.kind, here[0].kind);
  if (a.king && !m.king) return KING_HINT;
  return null;
}

/** 置けないマスを押したときのヒント（空いていないマスは null。何も言わない） */
export function illegalHint(l: Lesson, g: GameState, m: LessonMove): string | null {
  if (g.board[m.r][m.c] !== null) return null;
  return judgeMove(l, g, m) ?? l.hint(g, m);
}

/** 次にすること（盤より先に駒台で選ぶ駒・王を押す）。選んでいる駒・王の選択から決める */
export function nextNeed(l: Lesson, selected: PieceKind, kingOn: boolean): { kind?: PieceKind; king?: true } {
  const kinds = new Set(l.answers.map((a) => a.kind));
  if (kinds.size === 1 && !kinds.has(selected)) return { kind: [...kinds][0] };
  if (l.answers.some((a) => a.king) && !kingOn) return { king: true };
  return {};
}

// ---- 進み具合（localStorage。読めない・壊れていれば「はじめて」） ----

export const TUTORIAL_KEY = "kyosho:tutorial";

export interface Progress {
  /** 前回開いていたステップ（0 始まり） */
  step: number;
  /** 開いたことのある最も先のステップ */
  reached: number;
  /** 最後の実戦まで終えた */
  done: boolean;
}

const isStep = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < LESSONS.length;

/** 保存した進み具合。保存がない・読めないときは null（はじめて） */
export function loadProgress(store: KeyValueStore): Progress | null {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(TUTORIAL_KEY) ?? "null");
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isStep(o.step)) return null;
  const reached = isStep(o.reached) ? Math.max(o.reached, o.step) : o.step;
  return { step: o.step, reached, done: o.done === true };
}

export function saveProgress(store: KeyValueStore, p: Progress) {
  store.setItem(TUTORIAL_KEY, JSON.stringify(p));
}

/** i 番目のステップを開いたときの進み具合 */
export const progressAt = (p: Progress | null, i: number): Progress => ({
  step: i,
  reached: Math.max(p?.reached ?? 0, i),
  done: p?.done ?? false,
});

/** メニューから始めるステップ（途中なら前回の位置、終えていれば最初から） */
export const resumeStep = (p: Progress | null) => (!p || p.done ? 0 : p.step);

/** メニューの「遊び方」に添える短い状態 */
export function progressLabel(p: Progress | null): string {
  if (!p) return "おすすめ";
  if (p.done) return "クリア済み";
  return `つづき ${p.step + 1}/${LESSONS.length}`;
}
