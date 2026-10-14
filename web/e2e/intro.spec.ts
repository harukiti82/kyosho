// 初めての人は遊び方から（ui/intro.ts）: 空の localStorage でメニューを開くと CPU対戦・マルチに錠が付き、押すと短いトーストで遊び方へ。
// 遊び方・スキル練習・設定・このゲームについて・ルール詳細は使える。前から遊んでいる人（設定・通算・遊び方・スキル練習の保存）は対象外。
// URL のクエリで開いた初めての人も必須、localStorage が使えない・印が壊れているときは必須にしない。
// 遊び方を実際に解いて錠が外れるのは tutorial.spec.ts、招待リンク・合言葉は online/intro.spec.ts。
// ほかの e2e は必須を解いた保存（e2e/intro.ts）で始まるので、ここは空の保存で始める。

import { expect, test, type Page } from "@playwright/test";
import { presetById } from "../src/engine/rules";
import { INTRO_KEY } from "../src/ui/intro";
import { TUTORIAL_KEY } from "../src/ui/lessons";
import { LOCKED_TITLE } from "../src/ui/menu";
import { encodeRules } from "../src/ui/query";
import { RECORD_KEY } from "../src/ui/record";
import { SETTINGS_KEY } from "../src/ui/setup";
import { SKILL_TUTORIAL_KEY } from "../src/ui/skilllessons";
import { noHorizontalScroll, saveSettings, startGame } from "./helpers";
import { EMPTY_STATE } from "./intro";

test.use({ storageState: EMPTY_STATE });

const SHOT = "screenshots";
const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");
const introOf = (page: Page) => page.evaluate((k) => localStorage.getItem(k), INTRO_KEY);

/** CPU対戦・マルチに錠が付いている（押せるが入口は開かない） */
async function expectLocked(page: Page) {
  await expect(page.locator("#menu")).toBeVisible();
  for (const id of ["menu-cpu", "menu-multi"]) {
    const b = page.locator(`#${id}`);
    await expect(b).toHaveClass(/\blocked\b/);
    await expect(b.locator(".menu-lock")).toBeVisible();
    await expect(b).toHaveAccessibleName(new RegExp(LOCKED_TITLE));
  }
  // 遊び方が主な項目
  await expect(page.locator("#menu-learn")).toHaveClass(/\bprimary\b/);
  await expect(page.locator("#menu-cpu")).not.toHaveClass(/\bprimary\b/);
}

async function expectOpen(page: Page) {
  await expect(page.locator("#menu")).toBeVisible();
  for (const id of ["menu-cpu", "menu-multi", "menu-pvp"]) {
    await expect(page.locator(`#${id}`)).not.toHaveClass(/\blocked\b/);
  }
  await expect(page.locator(".menu-lock")).toHaveCount(0);
  await expect(page.locator("#menu-cpu")).toHaveClass(/\bprimary\b/);
  await expect(page.locator("#menu-learn")).not.toHaveClass(/\bprimary\b/);
}

test("初めての人: CPU対戦・マルチは押すとトーストで遊び方へ。遊び方・スキル練習・設定・このゲームについて・ルール詳細は使える", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expectLocked(page);
  expect(JSON.parse((await introOf(page))!)).toEqual({ v: 1, state: "new" });
  await expect(page.locator("#menu-learn")).toHaveText("遊び方 おすすめ");
  await noHorizontalScroll(page, page.viewportSize()!.width);
  // メニューが出てくる動きが終わってから撮る
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-intro-menu.png` });

  // CPU対戦: 強さの段は開かず、トースト。遊び方の鍵に移る
  await page.locator("#menu-cpu").click();
  await expect(page.locator("#toast")).toHaveText(LOCKED_TITLE);
  await expect(page.locator("#menu-levels")).toBeHidden();
  await expect(page.locator("#menu-main")).toBeVisible();
  await expect(page.locator("#menu-learn")).toBeFocused();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-intro-locked.png` });
  // マルチも同じ（この公開先にオンラインはないので、中に開いている入口はない）
  await page.locator("#menu-multi").click();
  await expect(page.locator("#toast")).toHaveText(LOCKED_TITLE);
  await expect(page.locator("#menu-modes")).toBeHidden();

  // ルール詳細
  await page.locator("#menu-rule").click();
  await expect(page.locator("#rules")).toBeVisible();
  await page.locator("#rules-close").click();
  // このゲームについて
  await page.locator("#menu-about").click();
  await expect(page.locator("#about")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#about")).toBeHidden();
  // 設定は保存できる。保存しても必須のまま（再読み込みしても）
  await page.locator("#menu-settings").click();
  await expect(page.locator("#setup")).toBeVisible();
  await saveSettings(page);
  expect(await page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY)).not.toBeNull();
  await expectLocked(page);
  await page.reload();
  await expectLocked(page);
  // スキル練習: 一覧から 1 枚を始められる
  await page.locator("#menu-skills").click();
  await expect(page.locator("#menu-skilllist")).toBeVisible();
  await page.locator("#skill-lessons .tarot").first().click();
  await expect(page.locator("#coach")).toBeVisible();
  await page.locator("#btn-menu").click();
  await expectLocked(page);
  // 遊び方: 1 ステップ目から
  await page.locator("#menu-learn").click();
  await expect(page.locator("#coach-num")).toHaveText("1/16");
  await page.locator("#btn-menu").click();
  await expectLocked(page);
  await page.reload();
  await expectLocked(page);
  await expect(page.locator("#menu-learn")).toHaveText("遊び方 つづき 1/16");
  expect(errors).toEqual([]);
});

test("タッチの端末でも錠の鍵を押すとトースト", async ({ page }) => {
  test.skip(prefix(page) !== "sp");
  await page.goto("/");
  await expectLocked(page);
  await page.locator("#menu-cpu").tap();
  await expect(page.locator("#toast")).toHaveText(LOCKED_TITLE);
  await expect(page.locator("#menu-levels")).toBeHidden();
});

for (const key of [SETTINGS_KEY, RECORD_KEY, TUTORIAL_KEY, SKILL_TUTORIAL_KEY]) {
  test(`前から遊んでいる人（${key} の保存がある）は最初から CPU対戦・マルチを使える`, async ({ page }) => {
    const value: Record<string, string> = {
      [SETTINGS_KEY]: JSON.stringify({ v: 2, side: "0" }),
      [RECORD_KEY]: JSON.stringify({ cpu: { easy: { wins: 1, losses: 0, draws: 0 } } }),
      [TUTORIAL_KEY]: JSON.stringify({ v: 2, step: 2, reached: 2, done: false }),
      [SKILL_TUTORIAL_KEY]: JSON.stringify({ v: 1, done: ["strong"] }),
    };
    await page.addInitScript(([k, v]) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(k, v);
        sessionStorage.setItem("seeded", "1");
      }
    }, [key, value[key]] as const);
    await page.goto("/");
    await expectOpen(page);
    // 印は書かない（前から遊んでいる人の保存を増やさない）
    expect(await introOf(page)).toBeNull();
    await startGame(page, { preset: "std" });
    await expect(page.locator("#game")).toBeVisible();
  });
}

test("URL のクエリでルールを指定して開いた初めての人も、メニューでは必須", async ({ page }) => {
  await page.goto(`/?${encodeRules(presetById("std").rules)}`);
  await expectLocked(page);
  await expect(page.locator("#menu-rule-name")).toHaveText("スキルなし");
});

test("印が壊れている・知らない形なら必須にしない", async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, "{broken"), INTRO_KEY);
  await page.goto("/");
  await expectOpen(page);
});

test("localStorage が使えないときは必須にしない（遊び方から抜けられなくならない）", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await expectOpen(page);
  await startGame(page, { preset: "std", side: "saved" });
  await expect(page.locator("#game")).toBeVisible();
});

test("壊れた遊び方の保存がある初めての人は、必須のまま遊び方の最初から", async ({ page }) => {
  await page.addInitScript(
    ([ik, tk]) => {
      localStorage.setItem(ik, JSON.stringify({ v: 1, state: "new" }));
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(tk, "{broken");
        sessionStorage.setItem("seeded", "1");
      }
    },
    [INTRO_KEY, TUTORIAL_KEY] as const,
  );
  await page.goto("/");
  await expectLocked(page);
  await expect(page.locator("#menu-learn")).toHaveText("遊び方 おすすめ");
  await page.locator("#menu-learn").click();
  await expect(page.locator("#coach-num")).toHaveText("1/16");
});

test("招待リンクの部屋に入れなかった初めての人は、メニューで必須", async ({ page }) => {
  // この公開先には /api がないので、つながらない案内からメニューへ
  await page.goto(`/?room=${"A".repeat(22)}`);
  await expect(page.locator("#online")).toBeVisible();
  await page.locator("#online").getByRole("button", { name: "メニューへ" }).click();
  await expectLocked(page);
});
