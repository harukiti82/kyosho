// 1 手ごとの制限時間: CPU 対戦の強さごとの既定（イージー なし・ノーマル 45 秒・ハード 20 秒）、設定メニューで変えた値、
// 2 人対戦の既定 45 秒、時間切れの自動の手（棋譜・トースト）、止める条件（メニュー・演出・CPU の手番）、
// 締め切りを過ぎた入力（二重に打たない）、タブを裏に回して戻った（時刻だけ進んだ）とき、自動の手で決着・隠し王の期限の手。
// 時計は Playwright の page.clock で進める（実際には待たない）。スクリーンショットは web/screenshots/*-timer-*.png

import { expect, test, type Page } from "@playwright/test";
import { noHorizontalScroll, openRuleFields, openSettings, saveSettings, seedPage, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");
const moves = (page: Page) => page.locator("#log .log-item.move");
const clock = (page: Page) => page.locator("#turn-clock");
const clockNum = (page: Page) => page.locator("#turn-clock .clock-num");

/** 時計を偽物にして（時間は自然に進む）、種付きの CPU でメニューを開く */
async function open(page: Page, seed = 7) {
  await seedPage(page, seed);
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
}

/** 設定メニューのラジオ（ラベルを押す。スマホ幅では隠れた input への直接のクリックが効かない） */
async function pick(page: Page, name: string, value: string) {
  await openSettings(page);
  await page.locator(`label:has(> input[name=${name}][value="${value}"])`).click();
  await expect(page.locator(`input[name=${name}][value="${value}"]`)).toBeChecked();
}

/** 対局をやめてメニューへ */
async function toMenu(page: Page) {
  await page.locator("#btn-menu").click();
  await expect(page.locator("#menu")).toBeVisible();
}

test("CPU 対戦: 強さに合わせた制限時間（イージー なし・ノーマル 45 秒・ハード 20 秒）が自分の名札に出る", async ({ page }) => {
  await open(page);
  await page.locator("#menu-cpu").click();
  await expect(page.locator("[data-level=easy] .menu-time")).toHaveText(/時間なし/);
  await expect(page.locator("[data-level=normal] .menu-time")).toHaveText(/45秒/);
  await expect(page.locator("[data-level=hard] .menu-time")).toHaveText(/20秒/);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-levels.png` });
  await page.locator("#menu-levels .menu-back").click();

  await startGame(page, { level: "easy", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(clock(page)).toHaveCount(0);

  await toMenu(page);
  await startGame(page, { level: "normal" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(clockNum(page)).toHaveText("45");
  // 時計は自分（盤の下）の名札の名前の右
  await expect(page.locator("#seat-bottom #turn-clock")).toBeVisible();
  await expect(clock(page)).toHaveAttribute("role", "timer");
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-normal.png` });
  await noHorizontalScroll(page, page.viewportSize()!.width);

  await toMenu(page);
  await startGame(page, { level: "hard" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(clockNum(page)).toHaveText("20");
});

test("設定メニューで変えた制限時間が反映される（CPU 対戦 なし・20 秒、マルチ 90 秒）", async ({ page }) => {
  await open(page);
  await pick(page, "timeCpu", "0");
  await pick(page, "timeMulti", "90");
  await page.locator("#setup-form fieldset:has(input[name=timeCpu])").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-setup.png` });
  await saveSettings(page);
  await page.locator("#menu-cpu").click();
  await expect(page.locator("[data-level=hard] .menu-time")).toHaveText(/時間なし/);
  await page.locator("#menu-levels .menu-back").click();

  await startGame(page, { level: "hard", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(clock(page)).toHaveCount(0);

  await toMenu(page);
  await startGame(page, { mode: "pvp" });
  await expect(clockNum(page)).toHaveText("1:30");

  // 保存は再読み込みしても残る
  await page.reload();
  await pick(page, "timeCpu", "20");
  await expect(page.locator("input[name=timeMulti][value='90']")).toBeChecked();
  await saveSettings(page);
  await startGame(page, { level: "normal" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(clockNum(page)).toHaveText("20");
});

test("時間切れ: 置ける手から自動で 1 手打ち、棋譜とトーストで知らせる。CPU が打った後、時計は 45 秒に戻る", async ({ page }) => {
  await open(page);
  await startGame(page, { level: "normal", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await page.clock.fastForward(36_000);
  await expect(clockNum(page)).toHaveText("9");
  await expect(clock(page)).toHaveClass(/\bwarn\b/);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-warn.png` });
  await page.clock.fastForward(5_000);
  await expect(clockNum(page)).toHaveText("4");
  await expect(clock(page)).toHaveClass(/\bdanger\b/);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-danger.png` });
  await page.clock.fastForward(5_000);

  await expect(page.locator("#toast")).toContainText("時間切れ！ 先手（あなた）の手を自動で打ちました");
  await expect(moves(page).last()).toHaveClass(/\btimeout\b/);
  await expect(moves(page).last()).toContainText("（時間切れ・自動）");
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-timeout.png` });
  // CPU が打って自分の手番に戻ると、時計は制限時間から
  expect(await waitHumanTurnOrEnd(page)).toBe(false);
  await expect(moves(page)).toHaveCount(2);
  await expect(clockNum(page)).toHaveText("45");
  // CPU の手は時間切れではない
  await expect(page.locator("#log .log-item.move.timeout")).toHaveCount(1);
});

test("止める: メニューを開いている間・CPU の手番・大きな演出の間は時計が進まない", async ({ page }) => {
  await open(page);
  await startGame(page, { level: "normal", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(clockNum(page)).toHaveText("35");
  await toMenu(page);
  await page.clock.fastForward(120_000);
  await page.locator("#menu-resume").click();
  await expect(page.locator("#game")).toBeVisible();
  await expect(clockNum(page)).toHaveText("35");
  await expect(moves(page)).toHaveCount(0);

  // 自分が打つと、CPU が考えている間は時計を出さない（CPU 側には付けない）
  await page.locator(".cell.open").first().click();
  await expect(moves(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelectorAll("#turn-clock").length)).toBe(0);
  expect(await waitHumanTurnOrEnd(page)).toBe(false);
  await expect(clockNum(page)).toHaveText("45");
});

test("止める（2 人対戦）: 大きな演出の間は次の人の時計が止まり、終われば制限時間から進む", async ({ page }) => {
  await open(page);
  // 体力 5 なら 1 枚返すだけで体力の 20%（特大）の演出になる
  await openRuleFields(page);
  await page.locator(".preset[data-preset=orig]").click();
  await page.locator("input[name=hp0]").fill("5");
  await page.locator("input[name=hp1]").fill("5");
  await page.locator(`label:has(> input[name=heal][value=none])`).click();
  await saveSettings(page);
  await startGame(page, { mode: "pvp" });
  await expect(clockNum(page)).toHaveText("45");
  await page.locator(".cell.open").first().click();
  await expect(page.locator(".turn-clock.paused")).toBeVisible();
  await expect(page.locator("#seat-top #turn-clock")).toBeVisible();
  await expect(clockNum(page)).toHaveText("45");
  await expect(page.locator(".turn-clock.paused")).toHaveCount(0, { timeout: 5_000 });
  await page.clock.fastForward(3_000);
  await expect(clockNum(page)).toHaveText("42");
});

test("自動の手で決着がつく（2 人対戦・体力 5）。終局後は時計を出さない", async ({ page }) => {
  await open(page);
  await openRuleFields(page);
  await page.locator(".preset[data-preset=orig]").click();
  await page.locator("input[name=hp0]").fill("5");
  await page.locator("input[name=hp1]").fill("5");
  await page.locator(`label:has(> input[name=heal][value=none])`).click();
  await saveSettings(page);
  await startGame(page, { mode: "pvp" });
  for (let i = 0; i < 80; i++) {
    if (await page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open)) break;
    await page.clock.fastForward(46_000);
  }
  await expect(page.locator("#result")).toBeVisible();
  const n = await moves(page).count();
  expect(n).toBeGreaterThan(0);
  await expect(page.locator("#log .log-item.move.timeout")).toHaveCount(n);
  await expect(page.locator("#result-detail .score-foot")).toContainText("1 手 45 秒");
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-end.png` });
  await page.locator("#result-view").click();
  await expect(clock(page)).toHaveCount(0);
});

test("締め切りを過ぎてから届いた入力では打たない（先に自動の手を打ち、二重に打たない）", async ({ page }) => {
  await open(page);
  await startGame(page, { level: "normal", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  // 時計のタイマーを動かさずに時刻だけ締め切りの後へ進めてから、盤を押す
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 60_000);
  await page.locator(".cell.open").first().click();
  await expect(moves(page)).toHaveCount(1);
  await expect(moves(page).first()).toHaveClass(/\btimeout\b/);
  await page.clock.resume();
  expect(await waitHumanTurnOrEnd(page)).toBe(false);
  // 自動の手 1 つと CPU の手 1 つだけ
  await expect(moves(page)).toHaveCount(2);
  await expect(page.locator("#log .log-item.move.p0")).toHaveCount(1);
});

test("タブを裏に回して戻ったとき（タイマーが止まり時刻だけ進んだ）、戻った時点で経過時間どおりに時間切れにする", async ({ page }) => {
  await open(page);
  await startGame(page, { level: "normal", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  // 30 秒経って戻った: まだ切れていない（残り 14 秒）
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 30_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(clockNum(page)).toHaveText("14");
  await expect(moves(page)).toHaveCount(0);
  // さらに 20 秒: 戻った時点で時間切れ
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 20_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(moves(page)).toHaveCount(1);
  await expect(moves(page).first()).toHaveClass(/\btimeout\b/);
  await page.clock.resume();
});

test("隠し王の期限の手で時間切れなら、置いた駒が自動であなたの王になる", async ({ page }) => {
  await open(page);
  await openRuleFields(page);
  await page.locator(".preset[data-preset=king]").click();
  await page.locator("input[name=kingDeadline]").fill("1");
  await saveSettings(page);
  await startGame(page, { level: "normal", side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator("#king-toggle")).toHaveAttribute("aria-label", "この手で置く駒が王になる");
  await page.clock.fastForward(46_000);
  await expect(page.locator("#toast")).toContainText("時間切れ！");
  await expect(page.locator("#toast")).toContainText("自動であなたの王になりました");
  const m = moves(page).first();
  await expect(m).toHaveClass(/\btimeout\b/);
  // 名札の王はそのマス
  const cell = ((await m.textContent()) ?? "").match(/→([a-h][1-8])/)![1];
  await expect(page.locator("#seat-bottom .king-tag")).toContainText(cell);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-timer-king.png` });
});
