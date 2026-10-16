// メニューの名前の名札（#menu-name）と、その場で変えるダイアログ（#name-dialog。ui/namedialog.ts）をヘッドレスブラウザで確かめる。
// 確かめること: 名前がなければ「名前を決める」・押して決めるとメニュー・設定メニューの欄・保存・次の対局の名札に出る・再読み込みで残る・
// 空で決めると名前なしに戻る・長すぎる名前と見えない文字は理由を出して保存させない・やめる／Esc は変えない・設定メニューで変えても名札が揃う・
// URL のクエリのルールで開いていても、名前だけを保存して保存のルールは書き換えない・HTML の文字列は文字のまま・
// PC 1440×800 とスマホ 375×667 で名札が画面の中・縦横のスクロールなし（スクリーンショット）

import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PRESET, presetById } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { SETTINGS_KEY } from "../src/ui/setup";
import { noHorizontalScroll, openSettings, saveSettings, startGame } from "./helpers";

const SHOT = "screenshots";
const chip = (page: Page) => page.locator("#menu-name");
const dialog = (page: Page) => page.locator("#name-dialog");
const input = (page: Page) => page.locator("#name-dialog-input");
const savedJson = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), SETTINGS_KEY);

/** メニューの名札を押して、名前を入れて決める */
async function setName(page: Page, value: string) {
  await chip(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("data-mode", "edit");
  await expect(input(page)).toBeFocused();
  await input(page).fill(value);
  await page.locator("#name-dialog-ok").click();
}

async function expectChip(page: Page, name: string | null) {
  if (name === null) {
    await expect(chip(page)).toHaveClass(/\bunset\b/);
    await expect(page.locator("#menu-name-text")).toHaveText("名前を決める");
    await expect(page.locator("#menu-name-label")).toBeHidden();
  } else {
    await expect(chip(page)).not.toHaveClass(/\bunset\b/);
    await expect(page.locator("#menu-name-text")).toHaveText(name);
    await expect(page.locator("#menu-name-label")).toBeVisible();
  }
}

test("名前がなければ「名前を決める」。メニューで決めると名札・設定の欄・保存・対局の名札に出て、再読み込みでも残る", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
  await expectChip(page, null);

  await setName(page, "  はる  ");
  await expect(dialog(page)).toBeHidden();
  // 前後の空白を除いて保存し、名札の鍵にフォーカスが戻る
  await expectChip(page, "はる");
  await expect(chip(page)).toBeFocused();
  expect(await savedJson(page)).toMatchObject({ name: "はる", pvpNames: ["", ""] });

  // 設定メニューの欄にも入っている
  await openSettings(page);
  await expect(page.locator("#name-self")).toHaveValue("はる");
  await page.locator("#setup-cancel").click();

  // 次の対局の自分の名札
  await startGame(page, { preset: "std", level: "easy" });
  await expect(page.locator("#player-0 .player-name")).toHaveText("はる");
  await page.locator("#btn-menu").click();
  await expectChip(page, "はる");

  await page.reload();
  await expectChip(page, "はる");
  expect(errors).toEqual([]);
});

test("空で決めると名前なしに戻る。やめる・Esc は変えない", async ({ page }) => {
  await page.goto("/");
  await setName(page, "ゆき");
  await expectChip(page, "ゆき");

  // やめる: 入れかけた名前は捨てる
  await chip(page).click();
  await expect(input(page)).toHaveValue("ゆき");
  await input(page).fill("べつ");
  await page.locator("#name-dialog-other").click();
  await expect(dialog(page)).toBeHidden();
  await expectChip(page, "ゆき");

  // Esc
  await chip(page).click();
  await input(page).fill("べつ");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expectChip(page, "ゆき");
  expect(await savedJson(page)).toMatchObject({ name: "ゆき" });

  // Enter で決める・空は名前なし
  await chip(page).click();
  await input(page).fill("   ");
  await input(page).press("Enter");
  await expect(dialog(page)).toBeHidden();
  await expectChip(page, null);
  expect(await savedJson(page)).toMatchObject({ name: "" });
  await startGame(page, { preset: "std", level: "easy" });
  await expect(page.locator("#player-0 .player-name")).toHaveText("あなた");
});

test("長すぎる名前と見えない文字は理由を出して保存させない", async ({ page }) => {
  await page.goto("/");
  await setName(page, "あ".repeat(11));
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator("#name-dialog-input-error")).toHaveText("10文字まで");
  await expect(input(page)).toHaveAttribute("aria-invalid", "true");
  await expect(input(page)).toBeFocused();
  // 見えない文字（ゼロ幅の空白）
  await input(page).fill("は​る");
  await expect(page.locator("#name-dialog-input-error")).toHaveText("使えない文字があります");
  await page.locator("#name-dialog-ok").click();
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY)).toBeNull();
  await page.locator("#name-dialog-other").click();
  await expectChip(page, null);

  // 直せば通る。HTML の文字列は文字のまま
  await setName(page, "<b>あ</b>😀");
  await expect(dialog(page)).toBeHidden();
  await expectChip(page, "<b>あ</b>😀");
  await expect(page.locator("#menu-name-text b")).toHaveCount(0);
});

test("設定メニューで変えた名前もメニューの名札に出る", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.locator("#name-self").fill("かい");
  await saveSettings(page);
  await expectChip(page, "かい");
  await chip(page).click();
  await expect(input(page)).toHaveValue("かい");
});

test("URL のクエリのルールで開いていても、名前だけを保存して保存のルールは書き換えない", async ({ page }) => {
  await page.goto(`/?${encodeRules(presetById("orig").rules)}`);
  await setName(page, "はる");
  await expectChip(page, "はる");
  const saved = await savedJson(page);
  expect(saved.name).toBe("はる");
  expect(saved.rules).toBe(encodeRules(presetById(DEFAULT_PRESET).rules));
  // この画面の次の対局は URL のルールのまま
  await expect(page.locator("#menu-rule-name")).toHaveText(presetById("orig").name);
});

for (const [kind, size] of [
  ["pc", { width: 1440, height: 800 }],
  ["sp", { width: 375, height: 667 }],
] as const) {
  test(`${kind} ${size.width}×${size.height}: 名札がメニューの上の方にあり、縦横にスクロールしない`, async ({ page }, info) => {
    test.skip(info.project.name !== (kind === "pc" ? "desktop" : "mobile"));
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.locator("#menu")).toBeVisible();
    // 出る動きを待ってから測る
    await page.waitForTimeout(800);
    for (const name of [null, "ながいなまえのひと"]) {
      if (name) await setName(page, name);
      await expectChip(page, name);
      const box = (await chip(page).boundingBox())!;
      const cpu = (await page.locator("#menu-cpu").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      // 主な入口と同じ高さか、それより上
      expect(box.y).toBeLessThanOrEqual(cpu.y + 1);
      await noHorizontalScroll(page, size.width);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height);
      await page.screenshot({ path: `${SHOT}/${kind}-name-menu-${name ? "set" : "unset"}-${size.width}x${size.height}.png` });
    }
    await chip(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.screenshot({ path: `${SHOT}/${kind}-name-menu-dialog-${size.width}x${size.height}.png` });
  });
}
