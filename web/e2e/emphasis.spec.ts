// 説明文の要点と補足: 遊び方の各ステップ・ルールカード・ルール詳細・設定のルール一覧で、要点の一言が補足より大きく太く、
// 1 つの説明で大きいのは 1 か所だけであること。スマホで横スクロールが出ず、遊び方の盤が最初の画面に収まること。
// スクリーンショットは SHOT_DIR（既定 web/screenshots/）に *-emph-* で保存する。

import { expect, test, type Locator, type Page } from "@playwright/test";
import { parseCell } from "../src/engine/board";
import { LESSONS } from "../src/ui/lessons";
import { cellAt, noHorizontalScroll, openSettings, openTab, play, startGame } from "./helpers";

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const SHOT = env.SHOT_DIR ?? "screenshots";
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 600;
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOT}/${narrow(page) ? "sp" : "pc"}-emph-${name}.png` });

const style = (l: Locator) =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) };
  });

/** 要点が補足より 1.3 倍以上大きく、太い */
async function expectPointOver(point: Locator, note: Locator) {
  const [p, n] = [await style(point), await style(note)];
  expect(p.size / n.size).toBeGreaterThanOrEqual(1.3);
  expect(p.weight).toBeGreaterThanOrEqual(700);
}

/** ルールの一覧: どの行も要点（.rule-point）がちょうど 1 つで、補足があれば要点より小さい */
async function expectRuleLines(list: Locator) {
  const items = list.locator(":scope > li");
  const n = await items.count();
  expect(n).toBeGreaterThan(2);
  for (let i = 0; i < n; i++) {
    const li = items.nth(i);
    await expect(li.locator(".rule-point")).toHaveCount(1);
    if ((await li.locator(".rule-note").count()) > 0) await expectPointOver(li.locator(".rule-point"), li.locator(".rule-note"));
  }
}

test("遊び方: 各ステップで要点が大きく、補足・ヒント・できたの文は小さい", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.locator("#menu-learn").click();
  await expect(page.locator("#coach")).toBeVisible();
  for (const [i, l] of LESSONS.entries()) {
    await expect(page.locator("#coach-title")).toHaveText(l.title);
    await expect(page.locator("#coach-point")).toHaveText(l.point);
    // 大きいのは要点の 1 か所だけ（課題・補足は本文の大きさ）
    const point = await style(page.locator("#coach-point"));
    await expectPointOver(page.locator("#coach-point"), page.locator("#coach-task"));
    if (l.note) await expectPointOver(page.locator("#coach-point"), page.locator("#coach-note"));
    for (const other of ["#coach-title", "#coach-task", "#coach-note"]) expect((await style(page.locator(other))).size).toBeLessThan(point.size);
    await noHorizontalScroll(page, page.viewportSize()!.width);
    // 盤は最初の画面に収まる（コーチの文が大きくなっても押し下げない）
    await expect(page.locator(".board")).toBeInViewport({ ratio: 1 });
    await shot(page, `tutorial-${i + 1}-${l.id}`);
    if (l.match) break;
    if (l.id === "dirs") {
      // ヒント: 歩のまま正解のマスを押す。数字・駒の名前のない文でも崩れない
      await (narrow(page) ? cellAt(page, ...parseCell("e4")).tap() : cellAt(page, ...parseCell("e4")).click());
      if (narrow(page)) await cellAt(page, ...parseCell("e4")).tap();
      await expect(page.locator("#coach-msg.hint")).toBeVisible();
      expect((await style(page.locator("#coach-msg"))).size).toBeLessThan(point.size);
      await shot(page, `tutorial-${i + 1}-${l.id}-hint`);
    }
    const a = l.answers[0];
    if (a.king) await page.locator("#king-toggle").click();
    await play(page, a.at[0], a.at[1], a.kind, narrow(page));
    await expect(page.locator("#coach-msg.ok")).toBeVisible();
    // できたの文の数字・駒の名前は太字（文字の大きさは変えない）
    const keys = page.locator("#coach-msg .coach-key");
    if ((await keys.count()) > 0) expect((await style(keys.first())).size).toBe((await style(page.locator("#coach-msg"))).size);
    expect((await style(page.locator("#coach-msg"))).size).toBeLessThan(point.size);
    await page.waitForTimeout(400);
    await shot(page, `tutorial-${i + 1}-${l.id}-done`);
    await page.locator("#coach-next").click();
  }
});

test("ルールカード・ルール詳細・設定のルール一覧で、各行の要点が大きく補足が小さい", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  await expectRuleLines(page.locator("#setup-rules4"));
  await expect(page.locator("#setup-rules4 .rule-point").nth(1)).toHaveText("駒ごとに挟める向きが違う");
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await shot(page, "setup");
  await page.locator("#setup-cancel").click();
  await startGame(page, { side: 0 });
  await openTab(page, "rules4");
  await expectRuleLines(page.locator("#rules4-list"));
  await expect(page.locator("#rules4-list .rule-point").nth(1)).toHaveText("駒ごとに挟める向きが違う");
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.locator("#rules4").scrollIntoViewIfNeeded();
  await shot(page, "card");
  await page.locator("#btn-rules").click();
  await expect(page.locator("#rules")).toBeVisible();
  for (const list of await page.locator("#rules-content .rule-lines").all()) await expectRuleLines(list);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await shot(page, "details");
});
