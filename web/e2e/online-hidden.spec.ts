// /api がない公開先（vite preview。GitHub Pages と同じ）: オンライン対戦の入口（招待リンク・合言葉）とエンドレスマッチの入口を出さず、既存のモードは今までどおり。
// 招待リンクを開いても、つながらないことを案内してメニューに戻せる

import { expect, test } from "@playwright/test";
import { openSettings, startGame } from "./helpers";

const SHOT = "screenshots";

test("/api に届かなければオンラインの入口を出さない。CPU 対戦はそのまま始められる", async ({ page }, info) => {
  const pre = info.project.name === "desktop" ? "pc" : "sp";
  const health = page.waitForResponse((r) => r.url().endsWith("/api/health"));
  await page.goto("/");
  await health;
  // 判定が終わるのを少し待ってから、入口が隠れたままかを見る
  await page.waitForTimeout(300);
  await page.locator("#menu-multi").click();
  await expect(page.locator("#menu-pvp")).toBeVisible();
  await expect(page.locator("#menu-online")).toBeHidden();
  await expect(page.locator("#menu-phrase")).toBeHidden();
  await page.locator("#menu-modes .menu-back").click();
  // エンドレスマッチ（サーバーが打つ CPU）も出さない。プライバシーの説明の行も出さない
  await page.locator("#menu-cpu").click();
  await expect(page.locator("#menu-levels [data-level=hard]")).toBeVisible();
  await expect(page.locator("#menu-endless")).toBeHidden();
  await expect(page.locator("#menu-ranking")).toBeHidden();
  await page.locator("#menu-levels .menu-back").click();
  await expect(page.locator("#about-endless")).toBeHidden();
  await openSettings(page);
  await expect(page.locator("#host-field")).toBeHidden();
  await startGame(page, { mode: "cpu", preset: "v10" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator("#net")).toBeHidden();

  // 招待リンクを開いた場合
  await page.goto(`/?room=${"A".repeat(22)}`);
  await expect(page.locator("#online")).toHaveAttribute("data-view", "error");
  await expect(page.locator("#online-title")).toHaveText("オンライン対戦に接続できません");
  await page.screenshot({ path: `${SHOT}/${pre}-online-unavailable.png` });
  await page.locator("#online-actions .btn.ghost").click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#menu-online")).toBeHidden();
  expect(new URL(page.url()).search).toBe("");
});
