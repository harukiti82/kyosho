// e2e の共通ヘルパー（設定画面の操作・待ち合わせ・横スクロールの確認・種付き乱数）

import { expect, type Page } from "@playwright/test";
import type { PresetId, RuleSet } from "../src/engine/rules";

export async function noHorizontalScroll(page: Page, width: number) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

/** 設定画面のフォームから読んだ設定 */
export function readSetup(page: Page): Promise<RuleSet> {
  return page.locator("#setup-form").evaluate((form: HTMLFormElement) => {
    const f = new FormData(form);
    const n = (k: string) => Number((form.elements.namedItem(k) as HTMLInputElement).value);
    return {
      action: f.get("action"),
      gate: f.get("gate") === "1",
      damage: f.get("damage"),
      heal: f.get("heal"),
      hp: [n("hp0"), n("hp1")],
      hand: { fu: n("fu"), gin: n("gin"), kin: n("kin"), hi: n("hi") },
      maxPlies: n("maxPlies"),
      king: { on: f.get("king") === "1", penalty: f.get("kingPenalty"), amount: n("kingAmount"), deadline: n("kingDeadline") },
    } as unknown as RuleSet;
  });
}

export async function startGame(page: Page, opts: { mode?: "cpu" | "pvp"; side?: 0 | 1; preset?: PresetId } = {}) {
  await expect(page.locator("#setup")).toBeVisible();
  if (opts.preset) await page.locator(`.preset[data-preset=${opts.preset}]`).click();
  await page.locator(`input[name=mode][value=${opts.mode ?? "cpu"}]`).check({ force: true });
  if ((opts.mode ?? "cpu") === "cpu") await page.locator(`input[name=side][value="${opts.side ?? 0}"]`).check({ force: true });
  await page.locator("#setup-start").click();
  await expect(page.locator("#setup")).toBeHidden();
}

/** 人間の手番（盤を操作できる）か終局画面のどちらかになるまで待つ。終局なら true */
export async function waitHumanTurnOrEnd(page: Page): Promise<boolean> {
  await page.waitForFunction(
    () => !!document.querySelector("#result[open]") || !!document.querySelector(".board.acting"),
    undefined,
    { timeout: 30_000 },
  );
  return page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open);
}

/** 種付き乱数（mulberry32） */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
