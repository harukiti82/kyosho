// 初めての人は遊び方から: 初めてこの端末で開いた人は、遊び方（LESSONS）の実戦の前までを終えるまで CPU 対戦とマルチを始められない。
// 前から遊んでいる人（設定・通算・遊び方・スキル練習の保存のどれかがある）は対象外。招待リンク・合言葉で来た人は、その 1 局を先に遊べる。
// 初めてかどうかは起動したときに 1 回だけ決め、localStorage の INTRO_KEY に残す（この後に遊び方を途中まで進めても、前から遊んでいる人にはならない）。
// localStorage が使えない・読めない・壊れているときは必須にしない（遊び方から抜けられない状態を作らない）。DOM に依存しない。

import type { KeyValueStore } from "../net/online";
import { LESSONS, TUTORIAL_KEY, type Progress } from "./lessons";
import { RECORD_KEY } from "./record";
import { SETTINGS_KEY } from "./setup";
import { SKILL_TUTORIAL_KEY } from "./skilllessons";

/** localStorage のキー（中身は JSON の { v: 1, state }） */
export const INTRO_KEY = "kyosho:intro";
const SAVE_VERSION = 1;

/**
 * new: 初めての人（遊び方を終えるまで CPU 対戦・マルチは遊べない。合言葉のオンライン対戦は 1 局目まで遊べる）。
 * played: 初めての人で、招待リンクか合言葉のオンライン対戦を 1 局始めた（合言葉も遊び方の後）。
 * cleared: 遊び方の実戦の前まで終えた
 */
export type IntroState = "new" | "played" | "cleared";

/** 必須にする遊び方のステップの数（最後の実戦の前まで） */
export const REQUIRED_STEPS = LESSONS.findIndex((l) => l.match);

/** 前から遊んでいる印になる保存 */
export const PLAYED_KEYS = [SETTINGS_KEY, RECORD_KEY, TUTORIAL_KEY, SKILL_TUTORIAL_KEY] as const;

const STATES: readonly IntroState[] = ["new", "played", "cleared"];

/** 遊び方の必須の範囲を終えたか（実戦を開いた = その前のステップを全部終えた。実戦まで終えていても） */
export const tutorialCleared = (p: Progress | null): boolean => !!p && (p.done || p.reached >= REQUIRED_STEPS);

/** 保存した状態（ないときは null、壊れているときは "cleared" = 必須にしない） */
function readIntro(store: KeyValueStore): IntroState | null {
  const raw = store.getItem(INTRO_KEY);
  if (raw === null) return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o === "object" && o !== null) {
      const { v, state } = o as Record<string, unknown>;
      if (v === SAVE_VERSION && STATES.includes(state as IntroState)) return state as IntroState;
    }
  } catch {
    // 壊れた保存は必須にしない
  }
  return "cleared";
}

/** 状態を保存する。保存して読み直せたら true（localStorage が使えないときは false） */
export function saveIntro(store: KeyValueStore, state: IntroState): boolean {
  const text = JSON.stringify({ v: SAVE_VERSION, state });
  store.setItem(INTRO_KEY, text);
  return store.getItem(INTRO_KEY) === text;
}

/**
 * 起動したときの状態（ほかの保存を書く前に 1 回だけ呼ぶ）。保存がなければ、前から遊んでいる印があれば "cleared"（書かない）、
 * なければ初めての人として "new" を保存する。保存できない（localStorage が使えない）ときは "cleared"
 */
export function startIntro(store: KeyValueStore): IntroState {
  const saved = readIntro(store);
  if (saved) return saved;
  if (PLAYED_KEYS.some((k) => store.getItem(k) !== null)) return "cleared";
  return saveIntro(store, "new") ? "new" : "cleared";
}

/** CPU 対戦とマルチを遊び方の後にするか（初めての人で、遊び方の必須の範囲をまだ終えていない） */
export const introRequired = (state: IntroState, p: Progress | null): boolean => state !== "cleared" && !tutorialCleared(p);
