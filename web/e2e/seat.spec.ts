// CPU 対戦の手番「ランダム」: 抽選の結果どおりに先手・後手になること、メニューから始め直したとき・再戦で引き直すこと、
// 先手・後手を選んだときは抽選しないこと。抽選の乱数（crypto.getRandomValues）は決めた列に差し替える。
// スクリーンショットは web/screenshots/*-seat-*.png に保存する。

import { expect, test, type Page } from "@playwright/test";
import { draws, noHorizontalScroll, openSettings, seedPage, startGame, stubDraws, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const moves = (page: Page) => page.locator("#log .log-item.move");

const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");

/** 設定メニューで CPU 対戦の手番 side を選んで保存し、メニューから CPU 対戦（ノーマル）を始める（ラベルを押す。スマホ幅では隠れた input への直接のクリックが効かない） */
async function startCpu(page: Page, side: "random" | "0" | "1", shot?: string) {
  await openSettings(page);
  await page.locator(`label:has(> input[name=side][value="${side}"])`).click();
  await expect(page.locator(`input[name=side][value="${side}"]`)).toBeChecked();
  if (shot) {
    await page.locator("#side-field").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/${shot}` });
  }
  await startGame(page, { side: "saved" });
}

/** 先手になった: 抽選の表示・手番の表示・まだ誰も打っていない・人間が打てる */
async function isFirst(page: Page) {
  await expect(page.locator("#toast")).toHaveText("対局開始！ 抽選の結果、あなたは先手（黒）です（あなたから打ちます）");
  await expect(page.locator("#player-0")).toContainText("あなた");
  await expect(page.locator("#player-1")).toContainText("CPU");
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(moves(page)).toHaveCount(0);
}

/** 後手になった: 抽選の表示・CPU が初手を打ってから人間の手番 */
async function isSecond(page: Page) {
  await expect(page.locator("#toast")).toHaveText("対局開始！ 抽選の結果、あなたは後手（白）です（CPU から打ちます）");
  await expect(page.locator("#player-1")).toContainText("あなた");
  await expect(page.locator("#player-0")).toContainText("CPU");
  await expect(moves(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(moves(page).first()).toHaveClass(/\bp0\b/);
  await expect(page.locator(".board.acting")).toBeVisible();
}

test("ランダム: 乱数が 0.5 未満なら先手になり、すぐに打てる", async ({ page }) => {
  await stubDraws(page, [0.1]);
  await page.goto("/");
  // 既定は「ランダム」
  await openSettings(page);
  await expect(page.locator("input[name=side][value=random]")).toBeChecked();
  await startCpu(page, "random", `${prefix(page)}-seat-setup.png`);
  await isFirst(page);
  expect(await draws(page)).toBe(1);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-seat-first.png` });
});

test("ランダム: 乱数が 0.5 以上なら後手になり、CPU が初手を打つ（標準の隠し王あり）", async ({ page }) => {
  await stubDraws(page, [0.9]);
  await page.goto("/");
  await startCpu(page, "random");
  // CPU の初手の前から抽選の結果が見えている
  await expect(page.locator("#toast")).toContainText("後手（白）");
  await expect(moves(page)).toHaveCount(0);
  await isSecond(page);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-seat-second.png` });
});

test("ランダム: メニューから始め直すと引き直す", async ({ page }) => {
  await stubDraws(page, [0.1, 0.9]);
  await page.goto("/");
  await startCpu(page, "random");
  await isFirst(page);
  await page.locator("#btn-menu").click();
  // 手番の設定は「ランダム」のまま残る
  await openSettings(page);
  await expect(page.locator("input[name=side][value=random]")).toBeChecked();
  await startGame(page, { side: "saved" });
  await isSecond(page);
  expect(await draws(page)).toBe(2);
});

test("ランダム: 終局後の再戦で引き直す（ルールを変えた設定でも）", async ({ page }, info) => {
  const touch = info.project.name === "mobile";
  await stubDraws(page, [0.9, 0.1]);
  // CPU の手を毎回同じにする（抽選は crypto なので影響しない）
  await seedPage(page, 1);
  // 体力 5 の v1.0 基準（すぐ終局する）。ルールの変更と組み合わせても抽選が効く
  await page.goto("/?hp1=5&hp2=5");
  await startCpu(page, "random");
  await isSecond(page);
  await expect(page.locator("#player-1")).toContainText("5");
  for (let i = 0; i < 60 && !(await waitHumanTurnOrEnd(page)); i++) {
    const take = page.locator(".cell.can-take");
    const cell = (await take.count()) > 0 ? take.first() : page.locator(".cell.open").first();
    const before = await moves(page).count();
    if (touch) {
      await cell.tap();
      await cell.tap();
    } else {
      await cell.click();
    }
    await expect.poll(() => moves(page).count()).toBeGreaterThan(before);
  }
  await expect(page.locator("#result")).toBeVisible();
  await page.locator("#result-rematch").click();
  await expect(page.locator("#result")).toBeHidden();
  await isFirst(page);
  expect(await draws(page)).toBe(2);
});

test("先手・後手を選んだときは抽選せず、従来どおり", async ({ page }) => {
  await stubDraws(page, [0.9]);
  await page.goto("/");
  await startCpu(page, "1");
  await expect(moves(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("#player-1")).toContainText("あなた");
  await expect(page.locator("#toast")).not.toContainText("抽選");
  await page.locator("#btn-menu").click();
  await startCpu(page, "0");
  await expect(page.locator("#player-0")).toContainText("あなた");
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(moves(page)).toHaveCount(0);
  expect(await draws(page)).toBe(0);
});
