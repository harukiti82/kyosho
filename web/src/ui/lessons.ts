// チュートリアル（遊び方）のステップ: 用意した局面で 1 手ずつ打って、標準ルールの要素を易しい順に覚える。
// 局面は engine の gameFrom で作り、ダメージ・回復・予測はすべてエンジン（playMove / previewMove）の結果を見せる。
// DOM に依存しない（盤の誘導・コーチの表示は ui/app.ts と ui/coach.ts）。

import { parseCell, type Cell } from "../engine/board";
import { createGame, gameFrom, previewMove, type GameState, type MoveEvent } from "../engine/game";
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
import { kingPenaltyText, pieceLabel } from "./ruletext";

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
  /** 目標（1〜2 文） */
  goal: string;
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

/** 返した（取った）駒の名前と数字（例: 「金5＋歩1」） */
const targetsText = (g: GameState, m: MoveEvent) => m.targets.map((t) => pieceLabel(g.rules, t.kind)).join("＋");

const pickHint = "光っているマスのどちらかに置こう。";

export const LESSONS: readonly Lesson[] = [
  {
    id: "flank",
    title: "挟む",
    goal: "自分の駒で相手の駒を挟むと、裏返して自分の駒にできる。光っているマスに歩を置こう。",
    rules: rulesWith({}),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["d8", B, "fu"], ["d7", W, "fu"], ["d6", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("d5"), kind: "fu" }],
    guide: cells("d5"),
    hint: () => "そのマスでは挟めない。光っているマスに置こう。",
    done: (m) => `相手の歩 ${m.targets.length} つを挟んで、自分の駒に裏返した。`,
  },
  {
    id: "damage",
    title: "ダメージ",
    goal: "挟んだ駒の数字の合計が、相手へのダメージになる。白の残り体力 6 を削り切れるマスに置こう。",
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
      return pv ? `そこは ${pv.damage} ダメージ。マスに触れると、置く前に数字が出る。` : pickHint;
    },
    done: (m, g) => `${targetsText(g, m)}で ${m.damage} ダメージ。白の体力が 0 になって勝ち。`,
  },
  {
    id: "dirs",
    title: "駒の向き",
    goal: "駒ごとに挟める向きが違う（石の上の矢印）。駒台で飛を選んで、横に挟もう。",
    rules: rulesWith({ dirs: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["b4", B, "fu"], ["c4", W, "fu"], ["d4", W, "fu"], ["g8", B, "fu"], ["g7", W, "fu"]]),
        hands: [hand({ fu: 3, hi: 1 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("e4"), kind: "hi" }],
    guide: cells("e4"),
    hint: () => "光っているマスに、飛で横に挟もう。",
    done: () => "点線の枠（普通のオセロなら置けるマス）に、縦だけの歩では置けず、縦横の飛なら置けた。",
  },
  {
    id: "hand",
    title: "持ち駒",
    goal: "持ち駒は数に限りがある（駒の右下の数字）。残り 1 つの金で、3 方向まとめて挟もう。",
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
    hint: () => "光っているマスに、金で置こう。",
    done: () => "最後の金を使ったので、この対局ではもう金を置けない。",
  },
  {
    id: "anchor",
    title: "端の駒",
    goal: "挟んだ端にある自分の駒の数字も、ダメージに足される。金（5）を端にして挟もう。",
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
      const ends = pv.anchors.map((a) => pieceLabel(g.rules, a.kind)).join("・");
      return `そこは端が${ends}で ${pv.damage} ダメージ。金を端にできるマスへ。`;
    },
    done: (m, g) => `返した${targetsText(g, m)}に端の${(m.anchors ?? []).map((a) => pieceLabel(g.rules, a.kind)).join("・")}が足されて、${m.damage} ダメージ。`,
  },
  {
    id: "heal",
    title: "回復",
    goal: "挟んだ両端（置いた駒と端の駒）の、低い方の数字−1 だけ回復する。飛で、金を端にして挟もう。",
    rules: rulesWith({ dirs: true, anchor: true, heal: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["a3", B, "kin"], ["b3", W, "fu"], ["g8", B, "kin"], ["g7", W, "fu"]]),
        hands: [hand({ fu: 3, hi: 1 }), hand({ fu: 3 })],
        hp: [100, this.rules.hp[1]],
      });
    },
    answers: [{ at: parseCell("c3"), kind: "hi" }],
    guide: cells("c3", "g6"),
    hint(g, m) {
      const pv = previewMove(g, m.r, m.c, m.kind);
      if (pv && pv.heal === 0) return `そこは回復 0。数字が 1 の歩・横を置くと回復しない。飛に持ち替えよう。`;
      return pickHint;
    },
    done: (m, g) => `${pieceLabel(g.rules, m.kind)}と端の${(m.anchors ?? []).map((a) => pieceLabel(g.rules, a.kind)).join("・")}で挟んで、体力が ${m.heal} 回復した。`,
  },
  {
    id: "king",
    title: "王を決める",
    goal: `最初の ${STD.king.deadline} 手のうち 1 手で、置く駒を自分の王にする。駒台の王を押してから置こう。`,
    rules: rulesWith({ dirs: true, anchor: true, heal: true, king: true }),
    start() {
      return gameFrom(this.rules, {
        stones: stones([["e8", B, "fu"], ["e7", W, "fu"]]),
        hands: [hand({ fu: 3 }), hand({ fu: 3 })],
      });
    },
    answers: [{ at: parseCell("e6"), kind: "fu", king: true }],
    guide: cells("e6"),
    hint: () => "光っているマスに置こう。",
    done: (m, g) => `この${pieceLabel(g.rules, m.kind)}があなたの王になった（相手には見えず、返されると${kingPenaltyText(g.rules)}）。`,
  },
  {
    id: "kingHit",
    title: "王を返す",
    goal: `相手の王はふつう見えないが、ここでは「?」の駒が白の王。挟んで返すと、ダメージに加えて${kingPenaltyText(STD)}。`,
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
    marks: [{ at: parseCell("c7"), text: "?", label: "白の王" }],
    hint: () => "光っているマスに置いて、「?」の駒を挟もう。",
    done: (m) => `白の王を返して、${m.damage} ダメージに −${m.king?.penalty ?? 0} が上乗せされた。`,
  },
  {
    id: "read",
    title: "予測を読む",
    goal: "マスに触れると、赤い数字がダメージ、! が次に相手に返されうる駒。置いた駒に ! が付かないマスを選ぼう。",
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
      if (pv?.exposed.some(([y, x]) => y === m.r && x === m.c)) return "そこだと置いた駒が次に返される（吹き出しの !）。もう一方のマスへ。";
      return pickHint;
    },
    done: (m) => `置いた駒を返されない手で、${m.damage} ダメージ。`,
  },
  {
    id: "match",
    title: "実戦",
    goal: "最後は CPU（イージー）と 1 局。ここまでのルールがすべて入った標準ルールで、制限時間はなし。",
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
export const FINISHED_TEXT = "おつかれさま。これで標準ルールの対局ができる。";

/** 王にしないで置こうとしたときのヒント */
export const KING_HINT = "先に駒台の右の王を押して、王にしてから置こう。";

/** 選んでいる駒（have）では正解の駒（need）の向きに挟めない・違う駒のときのヒント */
export function kindHint(r: RuleSet, have: PieceKind, need: PieceKind): string {
  const reach = PIECES[have].reach;
  const limited = r.dirs === "piece" && reach !== "all" && reach !== PIECES[need].reach;
  const why = limited ? `${PIECES[have].name}は${REACH_MARK[reach].mark} ${REACH_MARK[reach].name}にしか挟めない。` : "";
  return `${why}駒台で${PIECES[need].name}を選んでから置こう。`;
}

/**
 * 打とうとした手の判定。正解なら null、違えばヒント（盤は変えない）。
 * 正解のマスに違う駒・王にしないで置こうとしたときは、そのことを知らせる
 */
export function judgeMove(l: Lesson, g: GameState, m: LessonMove): string | null {
  const here = l.answers.filter((a) => sameCell(a.at, m.r, m.c));
  if (here.length === 0) return l.hint(g, m);
  const a = here.find((x) => x.kind === m.kind);
  if (!a) return kindHint(l.rules, m.kind, here[0].kind);
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
  if (!p) return "はじめての方に";
  if (p.done) return "クリア済み";
  return `つづき ${p.step + 1}/${LESSONS.length}`;
}
