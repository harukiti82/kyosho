import { describe, expect, it } from "vitest";
import { safeStore, type KeyValueStore } from "../src/net/online";
import { INTRO_KEY, introRequired, PLAYED_KEYS, REQUIRED_STEPS, saveIntro, startIntro, tutorialCleared } from "../src/ui/intro";
import { LESSONS, loadProgress, TUTORIAL_KEY } from "../src/ui/lessons";
import { RECORD_KEY } from "../src/ui/record";
import { SETTINGS_KEY } from "../src/ui/setup";
import { SKILL_TUTORIAL_KEY } from "../src/ui/skilllessons";

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const progress = (step: number, reached = step, done = false) => ({ step, reached, done });

describe("初めての人は遊び方から", () => {
  it("必須の範囲は実戦の前までの 15 ステップ", () => {
    expect(REQUIRED_STEPS).toBe(15);
    expect(LESSONS[REQUIRED_STEPS].match).toBe(true);
    expect(LESSONS.length).toBe(REQUIRED_STEPS + 1);
  });

  it("何も保存がなければ初めての人として new を保存する", () => {
    const s = memStore();
    expect(startIntro(s)).toBe("new");
    expect(JSON.parse(s.data[INTRO_KEY])).toEqual({ v: 1, state: "new" });
    // 開き直しても同じ（遊び方を途中まで進めても、前から遊んでいる人にはならない）
    s.data[TUTORIAL_KEY] = JSON.stringify({ v: 2, step: 3, reached: 3, done: false });
    expect(startIntro(s)).toBe("new");
    expect(introRequired("new", loadProgress(s))).toBe(true);
  });

  it.each(PLAYED_KEYS)("前から遊んでいる印（%s）があれば必須にせず、何も書かない", (key) => {
    const s = memStore({ [key]: "{}" });
    expect(startIntro(s)).toBe("cleared");
    expect(s.data[INTRO_KEY]).toBeUndefined();
  });

  it("前から遊んでいる印は設定・通算・遊び方・スキル練習の 4 つ", () => {
    expect([...PLAYED_KEYS].sort()).toEqual([SETTINGS_KEY, RECORD_KEY, TUTORIAL_KEY, SKILL_TUTORIAL_KEY].sort());
  });

  it("保存した状態をそのまま読む", () => {
    for (const state of ["new", "played", "cleared"] as const) {
      const s = memStore();
      expect(saveIntro(s, state)).toBe(true);
      expect(startIntro(s)).toBe(state);
    }
  });

  it("壊れた保存・知らない形は必須にしない", () => {
    for (const raw of ["{", "null", "1", '"new"', "[]", '{"v":1}', '{"v":1,"state":"x"}', '{"v":2,"state":"new"}', '{"state":"new"}']) {
      expect(startIntro(memStore({ [INTRO_KEY]: raw }))).toBe("cleared");
    }
  });

  it("localStorage が使えない（読めない・書けない・書いても残らない）ときは必須にしない", () => {
    const throwing = safeStore(() => {
      throw new Error("SecurityError");
    });
    expect(startIntro(throwing)).toBe("cleared");
    const noWrite = safeStore(() => ({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    }));
    expect(startIntro(noWrite)).toBe("cleared");
    // 書いたように見えて残らない
    expect(startIntro({ getItem: () => null, setItem: () => {}, removeItem: () => {} })).toBe("cleared");
  });

  it("15 ステップ目を終えて実戦を開いたら解ける（実戦をしなくても・終えていても）", () => {
    expect(tutorialCleared(null)).toBe(false);
    expect(tutorialCleared(progress(0))).toBe(false);
    expect(tutorialCleared(progress(REQUIRED_STEPS - 1))).toBe(false);
    expect(tutorialCleared(progress(REQUIRED_STEPS))).toBe(true);
    // 前のステップに戻っても、開いたことのある最も先で決める
    expect(tutorialCleared(progress(2, REQUIRED_STEPS))).toBe(true);
    expect(tutorialCleared(progress(0, 0, true))).toBe(true);
  });

  it("必須なのは new・played で、遊び方の必須の範囲をまだ終えていないときだけ", () => {
    expect(introRequired("new", null)).toBe(true);
    expect(introRequired("played", progress(REQUIRED_STEPS - 1))).toBe(true);
    expect(introRequired("new", progress(REQUIRED_STEPS))).toBe(false);
    expect(introRequired("cleared", null)).toBe(false);
  });

  it("壊れた遊び方の保存は最初からやり直しで、必須のまま（抜けられる）", () => {
    const s = memStore({ [INTRO_KEY]: JSON.stringify({ v: 1, state: "new" }), [TUTORIAL_KEY]: "{broken" });
    expect(startIntro(s)).toBe("new");
    expect(loadProgress(s)).toBeNull();
    expect(introRequired("new", loadProgress(s))).toBe(true);
  });
});
