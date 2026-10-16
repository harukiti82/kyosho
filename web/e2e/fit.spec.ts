// 画面がウィンドウ 1 枚に収まること: PC とスマホのいくつかの大きさで、メニュー・CPU 対戦（標準、カードを選んだ後）・2 人対戦・
// 遊び方のステップ（コーチ表示中・できたの文と「次へ」まで）・スキル練習に、ページの縦スクロールも横スクロールもなく、
// 盤・名札・駒台・タブが画面の中に見えていること。引き出しのタブを開いても中身は引き出しの中でスクロールし、ページは伸びない。
// 背の低いウィンドウ（横向きのスマホ）はページのスクロールを許すが、横スクロールは出さず盤の 1 マスは 36px 程度を保つ。
// スクリーンショットは web/screenshots/ に保存する（*-fit-<画面>-<幅>x<高さ>*）。

import { expect, test, type Page } from "@playwright/test";
import { LESSONS } from "../src/ui/lessons";
import { play, seedPage, startGame } from "./helpers";

const SHOT = "screenshots";

/** 確かめるウィンドウの大きさ（PC は desktop、スマホは mobile のプロジェクトで）。1920×960 はフル HD から上下のブラウザの枠を引いた大きさ */
const PC = [
  { width: 1920, height: 960 },
  { width: 1440, height: 800 },
  { width: 1366, height: 650 },
  { width: 1280, height: 720 },
];
const SP = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
];

const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 600;
const sizesFor = (page: Page) => (isNarrow(page) ? SP : PC);

/** 画面の中に見えていてほしい部品（あるものだけ測る） */
const PARTS = [
  "#board-frame",
  "#player-0",
  "#player-1",
  "#hand",
  ".tabs",
  "#coach",
  "#turn-clock",
  ".plate-skill",
  ".tab-panel:not([hidden]):not(.tab-off)",
  ".menu-panel:not([hidden])",
  ".menu-logo",
  "#menu-rule",
];

type Box = { name: string; top: number; bottom: number; left: number; right: number };

async function measure(page: Page) {
  return page.evaluate((parts) => {
    const doc = document.documentElement;
    const boxes: Box[] = [];
    for (const s of parts) {
      for (const el of document.querySelectorAll<HTMLElement>(s)) {
        if (el.closest("[hidden]") || getComputedStyle(el).display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        boxes.push({ name: s, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
    }
    return {
      scrollH: doc.scrollHeight,
      scrollW: doc.scrollWidth,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      cell: document.querySelector<HTMLElement>("#game:not([hidden]) .cell")?.getBoundingClientRect().width ?? 0,
      boxes,
    };
  }, PARTS);
}

/** 縦にも横にもスクロールがなく、部品がすべて画面の中にあること。label はスクリーンショットの名前 */
async function expectFits(page: Page, label: string, opts: { minCell?: number } = {}) {
  // 入りの動き（メニューの項目・カードの持ち上がり・ゲージ）が収まってから測る
  await page.waitForTimeout(700);
  const m = await measure(page);
  const size = `${m.innerW}x${m.innerH}`;
  await page.screenshot({ path: `${SHOT}/${isNarrow(page) ? "sp" : "pc"}-fit-${label}-${size}.png` });
  const at = `${label} ${size}`;
  expect.soft(m.scrollH, `${at} の縦スクロール`).toBeLessThanOrEqual(m.innerH);
  expect.soft(m.scrollW, `${at} の横スクロール`).toBeLessThanOrEqual(m.innerW);
  for (const b of m.boxes) {
    expect.soft(b.top, `${at} ${b.name} の上`).toBeGreaterThanOrEqual(-0.5);
    expect.soft(b.bottom, `${at} ${b.name} の下`).toBeLessThanOrEqual(m.innerH + 0.5);
    expect.soft(b.left, `${at} ${b.name} の左`).toBeGreaterThanOrEqual(-0.5);
    expect.soft(b.right, `${at} ${b.name} の右`).toBeLessThanOrEqual(m.innerW + 0.5);
  }
  // 盤のマスはタップしやすい大きさを保つ（遊び方・スキル練習は背の低いスマホで 34px 程度まで）
  if (m.cell > 0) expect.soft(m.cell, `${at} の 1 マス`).toBeGreaterThanOrEqual(opts.minCell ?? 36);
  return m;
}

/** 2 つの要素の箱が重ならないこと */
async function expectApart(page: Page, a: string, b: string, at: string) {
  const ra = await page.locator(a).boundingBox();
  const rb = await page.locator(b).boundingBox();
  expect(ra && rb).toBeTruthy();
  const overlap = !(ra!.x + ra!.width <= rb!.x || rb!.x + rb!.width <= ra!.x || ra!.y + ra!.height <= rb!.y || rb!.y + rb!.height <= ra!.y);
  expect.soft(overlap, `${at}: ${a} ${JSON.stringify(ra)} と ${b} ${JSON.stringify(rb)}`).toBe(false);
}

/** 開いている引き出しの中身が、はみ出す分を中でスクロールできること（ページではなく） */
async function expectPanelScrolls(page: Page, id: string, at: string) {
  const p = await page.locator(`#${id}`).evaluate((el) => ({
    overflow: getComputedStyle(el).overflowY,
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect.soft(p.overflow, `${at} #${id} の overflow`).toBe("auto");
  if (p.scroll > p.client + 1) {
    // 中身を下まで送ってもページはスクロールしない
    await page.locator(`#${id}`).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    expect.soft(await page.locator(`#${id}`).evaluate((el) => el.scrollTop), `${at} #${id} が中でスクロールする`).toBeGreaterThan(0);
    expect.soft(await page.evaluate(() => window.scrollY), `${at} のページのスクロール`).toBe(0);
  }
}

test("メニューの各画面が 1 画面に収まる", async ({ page }) => {
  for (const size of sizesFor(page)) {
    await page.setViewportSize(size);
    await page.goto("./");
    await expect(page.locator("#menu")).toBeVisible();
    await expectFits(page, "menu");
    await page.locator("#menu-cpu").click();
    await expectFits(page, "menu-levels");
    await page.locator("#menu-levels .menu-back").click();
    await page.locator("#menu-multi").click();
    await expectFits(page, "menu-modes");
    await page.locator("#menu-modes .menu-back").click();
    await page.locator("#menu-skills").click();
    await expectFits(page, "menu-skills");
  }
});

test("CPU 対戦（標準）が 1 画面に収まり、引き出しの中身は引き出しの中でスクロールする", async ({ page }) => {
  for (const size of sizesFor(page)) {
    await page.setViewportSize(size);
    await seedPage(page, 7);
    await page.goto("./");
    await startGame(page, { preset: "skill" });
    await expect(page.locator("#skill-pick")).toBeHidden();
    // 開始のトースト（選んだカード）: スマホは上の帯の下に出て、盤・駒台・タブを覆わない。出ている間もタブは押せる（トーストは押した所を素通りする）
    await expect(page.locator("#toast")).toBeVisible();
    if (isNarrow(page)) {
      for (const part of ["#board-frame", "#hand", ".tabs"]) await expectApart(page, "#toast", part, `cpu-toast ${size.width}x${size.height}`);
    }
    const hit = await page.locator("#tab-log-panel").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect.soft(hit, `cpu-toast ${size.width}x${size.height} のタブが押せる`).toBe(true);
    await page.screenshot({ path: `${SHOT}/${isNarrow(page) ? "sp" : "pc"}-fit-cpu-toast-${size.width}x${size.height}.png` });
    // 駒台の駒と王の鍵が重ならない（右の列・スマホの幅に収まる）
    for (const kind of await page.locator("#hand-buttons .piece-btn").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))) {
      await expectApart(page, `#hand-buttons .piece-btn[data-kind=${kind}]`, "#king-toggle", `cpu-hand ${size.width}x${size.height}`);
    }
    // PC はルールを開いて始め、スマホは閉じて始める
    await expect(page.locator("#tab-rules4")).toHaveAttribute("aria-selected", String(!isNarrow(page)));
    await expectFits(page, "cpu");
    for (const id of ["rules4", "log-panel", "legend-box", "preview"]) {
      const tab = page.locator(`#tab-${id}`);
      if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectFits(page, `cpu-${id}`);
      await expectPanelScrolls(page, id, `cpu-${id} ${size.width}x${size.height}`);
      // 狭い画面のシートは駒台の上に開き、駒台とタブを隠さない（開いたまま打てる）
      if (isNarrow(page)) {
        await expectApart(page, `#${id}`, ".tabs", `cpu-${id} ${size.width}x${size.height}`);
        await expectApart(page, `#${id}`, "#hand", `cpu-${id} ${size.width}x${size.height}`);
        // 打ちながら見る「予測」は盤にも重ねない
        if (id === "preview") await expectApart(page, `#${id}`, "#board-frame", `cpu-${id} ${size.width}x${size.height}`);
      }
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "false");
    }
  }
});

test("2 人対戦（標準）が 1 画面に収まる", async ({ page }) => {
  for (const size of sizesFor(page)) {
    await page.setViewportSize(size);
    await page.goto("./");
    await startGame(page, { mode: "pvp", preset: "skill" });
    await expectFits(page, "pvp");
  }
});

test("遊び方のステップ（できたの文と「次へ」まで）とスキル練習が 1 画面に収まり、コーチは盤と重ならない", async ({ page }) => {
  const first = LESSONS[0].answers[0];
  for (const size of sizesFor(page)) {
    await page.setViewportSize(size);
    await page.goto("./");
    await page.locator("#menu-learn").click();
    await expect(page.locator("#coach")).toBeVisible();
    await expectFits(page, "tutorial", { minCell: 34 });
    await expectApart(page, "#coach", "#board", `tutorial ${size.width}x${size.height}`);
    // 正解を打つと、できたの文と「次へ」がコーチの中で見える（コーチが中でスクロールする背の低い画面でも寄せる）
    await play(page, first.at[0], first.at[1], first.kind, isNarrow(page));
    await expect(page.locator("#coach-next")).toBeVisible();
    await page.waitForTimeout(600);
    await expectFits(page, "tutorial-done", { minCell: 34 });
    await expectApart(page, "#coach", "#board", `tutorial-done ${size.width}x${size.height}`);
    const coach = (await page.locator("#coach").boundingBox())!;
    const next = (await page.locator("#coach-next").boundingBox())!;
    expect.soft(next.y, "「次へ」がコーチの中に見える").toBeGreaterThanOrEqual(coach.y - 0.5);
    expect.soft(next.y + next.height, "「次へ」がコーチの中に見える").toBeLessThanOrEqual(coach.y + coach.height + 0.5);

    await page.locator("#btn-menu").click();
    await page.locator("#menu-skills").click();
    await page.locator("#skill-lessons [data-skill]").first().click();
    await expect(page.locator("#coach")).toBeVisible();
    await expectFits(page, "skill-lesson", { minCell: 34 });
    await expectApart(page, "#coach", "#board", `skill-lesson ${size.width}x${size.height}`);
  }
});

test("背の低いウィンドウ: PC の 1280×600 は収まり、横向きのスマホは縦のスクロールだけを許す", async ({ page }) => {
  await seedPage(page, 7);
  await page.goto("./");
  if (!isNarrow(page)) {
    await page.setViewportSize({ width: 1280, height: 600 });
    await startGame(page, { preset: "skill" });
    await expectFits(page, "cpu-low");
    await page.setViewportSize({ width: 960, height: 600 });
    await expectFits(page, "cpu-low");
    return;
  }
  // 横向きのスマホ（667×375）は盤の下限（1 マス 36px 程度）を保ち、溢れた分だけページを縦にスクロールする
  await page.setViewportSize({ width: 667, height: 375 });
  await startGame(page, { preset: "skill" });
  await page.waitForTimeout(700);
  const m = await measure(page);
  await page.screenshot({ path: `${SHOT}/sp-fit-cpu-landscape-667x375.png`, fullPage: true });
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
  expect(m.cell).toBeGreaterThanOrEqual(36);
});
