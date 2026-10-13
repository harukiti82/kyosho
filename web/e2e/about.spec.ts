// 完全版の体裁: 上の帯に「試遊版」が出ない・メニューの「このゲームについて」（版・作者・権利・プライバシー・ルールの全文）・
// 想定外のエラーの知らせ（1 回だけ・ほかのダイアログの上にも出る・「再読み込み」で戻る）・JavaScript がないときの noscript。
// スクリーンショットは web/screenshots/ に保存する。

import { expect, test, type Page } from "@playwright/test";
import pkg from "../package.json" with { type: "json" };
import { createGame, playMove } from "../src/engine/game";
import { presetById } from "../src/engine/rules";
import { greedy, noHorizontalScroll, openSettings, play, startGame } from "./helpers";

const SHOT = "screenshots";
const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");
/** package.json の version（1.0.0）を画面の版（1.0）にしたもの */
const shown = pkg.version.replace(/^(\d+\.\d+)\.0$/, "$1");

/** この画面のスクリプトの中から投げた例外（インラインのスクリプトなので、ファイル名はこのページの URL） */
async function throwInPage(page: Page, message: string) {
  await page.evaluate((m) => {
    const s = document.createElement("script");
    s.textContent = `setTimeout(() => { throw new Error(${JSON.stringify(m)}); })`;
    document.body.append(s);
  }, message);
}

test("上の帯は読みの「きょうしょう」だけ。メニューの「このゲームについて」に版・作者・権利・プライバシー・ルールの全文", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.locator(".topbar .title-sub")).toHaveText("きょうしょう");
  await expect(page.locator("body")).not.toContainText("試遊");
  // 小さい項目の最後（設定の次）
  await expect(page.locator("#menu-main .menu-btn:visible").last()).toHaveText("このゲームについて");
  await expect(page.locator("#menu-about")).toHaveClass(/menu-small/);

  await page.locator("#menu-about").click();
  const about = page.locator("#about");
  await expect(about).toBeVisible();
  expect(pkg.version).toBe("1.0.0");
  await expect(page.locator("#about-version")).toHaveText(`版 ${shown}`);
  await expect(about).toContainText("© 2026 rukiharukichi");
  await expect(about.locator(".rule-point")).toHaveText(["無断利用不可", "保存はこの端末だけ", "アクセス数の集計", "オンライン対戦の通信"]);
  await expect(about).toContainText("All rights reserved.");
  await expect(about).toContainText("設定・遊び方の進み具合・通算はこのブラウザに保存");
  await expect(about).toContainText("Cloudflare Web Analytics");
  await expect(about).toContainText("クッキーは使いません");
  await expect(about).toContainText("サーバーに送ります");
  const link = page.locator("#about-rules");
  await expect(link).toHaveText("ルールの全文");
  await expect(link).toHaveAttribute("href", "https://github.com/harukiti82/kyosho/blob/main/RULES.md");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  // 要点は補足より大きい（説明は要点と補足の形）
  const [point, note] = await Promise.all([
    about.locator(".rule-point").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    about.locator(".rule-note").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ]);
  expect(point).toBeGreaterThan(note * 1.3);
  // ダイアログが画面に収まり、横にスクロールしない
  const box = (await about.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await noHorizontalScroll(page, width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-about.png` });

  // 閉じる・Esc で閉じてメニューに戻る
  await page.locator("#about-close").click();
  await expect(about).toBeHidden();
  await expect(page.locator("#menu-main")).toBeVisible();
  await page.locator("#menu-about").click();
  await expect(about).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();
  // Esc はダイアログを閉じるだけで、メニューの段は変えない
  await expect(page.locator("#menu-main")).toBeVisible();
  expect(errors).toEqual([]);
});

test("対局中にメニューから「このゲームについて」を開いて閉じても、そのまま対局に戻れる", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const touch = (page.viewportSize()?.width ?? 1280) < 600;
  await page.goto("/");
  await startGame(page, { preset: "std", mode: "pvp" });
  // 2 人対戦でスキルなしの 2 手を打つ（返す駒が最も多い手）
  let s = createGame(presetById("std").rules);
  for (let i = 0; i < 2; i++) {
    const m = greedy(s);
    await play(page, m.r, m.c, m.kind, touch);
    s = playMove(s, m.r, m.c, m.kind);
    await expect(page.locator("#ply")).toHaveText(`${i + 1} 手`);
  }
  await page.locator("#btn-menu").click();
  await expect(page.locator("#menu-resume")).toBeVisible();
  await page.locator("#menu-about").click();
  await expect(page.locator("#about")).toBeVisible();
  await page.locator("#about-close").click();
  await page.locator("#menu-resume").click();
  await expect(page.locator("#game")).toBeVisible();
  await expect(page.locator("#ply")).toHaveText("2 手");
  await expect(page.locator(".board.acting")).toBeVisible();
  expect(errors).toEqual([]);
});

test("localStorage が使えなくても「このゲームについて」が開ける", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await page.locator("#menu-about").click();
  await expect(page.locator("#about-version")).toHaveText(`版 ${shown}`);
  await expect(page.locator("#crash")).toBeHidden();
});

test("想定外のエラーは小さな知らせを 1 回だけ出し、閉じれば続けられ、「再読み込み」で戻る", async ({ page }) => {
  await page.goto("/");
  const crash = page.locator("#crash");
  await expect(page.locator("#menu")).toBeVisible();
  await expect(crash).toBeHidden();

  // 例外を続けて投げても 1 つだけ
  await throwInPage(page, "e2e のわざとの例外 1");
  await throwInPage(page, "e2e のわざとの例外 1");
  await expect(crash).toBeVisible();
  await expect(crash).toHaveText(/エラーが起きました/);
  await expect(page.locator("dialog.crash[open]")).toHaveCount(1);
  // 画面はそのまま（メニューは残っている）
  await expect(page.locator("#menu")).toBeVisible();
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-crash.png` });

  // 閉じた後は、別のエラー（拒否されたままの Promise）でももう出さない
  await page.locator("#crash-close").click();
  await expect(crash).toBeHidden();
  await page.evaluate(() => {
    void Promise.reject(new Error("e2e のわざとの拒否"));
  });
  await throwInPage(page, "e2e のわざとの例外 2");
  await page.waitForTimeout(300);
  await expect(crash).toBeHidden();
  // 閉じた後もメニューは使える
  await page.locator("#menu-about").click();
  await expect(page.locator("#about")).toBeVisible();
  await page.locator("#about-close").click();

  // 再読み込みで戻る（知らせは消え、メニューから始まる）
  await page.reload();
  await expect(crash).toBeHidden();
  await expect(page.locator("#menu")).toBeVisible();
});

test("拒否されたままの Promise でも知らせ、開いているダイアログの上に出て「再読み込み」を押せる", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await page.evaluate(() => {
    void Promise.reject(new Error("e2e のわざとの拒否"));
  });
  const crash = page.locator("#crash");
  await expect(crash).toBeVisible();
  await expect(page.locator("#setup")).toBeVisible();
  // 設定のダイアログの上に出ていて押せる（ふさがれていればクリックは失敗する）
  await page.locator("#crash-reload").click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect(crash).toBeHidden();
  await expect(page.locator("#setup")).toBeHidden();
});

test("別のオリジンのスクリプトの中身の見えないエラーでは知らせない", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", filename: "" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Error", filename: "https://static.cloudflareinsights.com/beacon.min.js", error: new Error() }));
  });
  await page.waitForTimeout(200);
  await expect(page.locator("#crash")).toBeHidden();
});

test.describe("JavaScript がないとき", () => {
  test.use({ javaScriptEnabled: false });
  test("JavaScript が必要という一文が出る", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".noscript")).toBeVisible();
    await expect(page.locator(".noscript")).toHaveText("挟将を遊ぶには JavaScript を有効にしてください。");
    await noHorizontalScroll(page, page.viewportSize()!.width);
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-noscript.png` });
  });
});
