// 先手・後手の抽選の演出（盤の石を投げ、上を向いた色で手番を見せる）: CPU 対戦の手番「ランダム」で、結果が実際の手番と一致すること、
// 演出の間は盤・CPU・時計が止まり、終われば動くこと、タップ・Enter で飛ばせること、動きを減らす設定では回さないこと、
// 手番を選んだとき・2 人対戦・遊び方では出さないこと（再戦で引き直して出ることは seat.spec.ts）。演出の長さの時計は page.clock で止めて進め、CSS の動きは途中の時刻で止めて撮る。
// スクリーンショットは web/screenshots/*-toss-*.png に保存する。

import { expect, test, type Page } from "@playwright/test";
import { startGame, stubDraws } from "./helpers";

const SHOT = "screenshots";
const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");
const moves = (page: Page) => page.locator("#log .log-item.move");
const toss = (page: Page) => page.locator(".fx-toss");

/** page.clock の時刻を止める（この後は runFor で進めた分だけタイマーが動く） */
async function pauseClock(page: Page) {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
}

/** 画面の CSS アニメーションをすべて ms の時点で止める（演出の途中を撮る） */
async function freezeAt(page: Page, ms: number) {
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
}

/** 抽選の乱数を value にして、手番「ランダム」の CPU 対戦（ノーマル・45 秒）を時計を止めて始める */
async function startDrawn(page: Page, value: number) {
  await stubDraws(page, [value]);
  await page.clock.install();
  await page.goto("/");
  await pauseClock(page);
  await startGame(page, { side: "random" });
}

test("先手: 石が回って黒が上を向き「先手」。演出の間は盤と時計が止まり、終われば打てて時計が進む", async ({ page }) => {
  await startDrawn(page, 0.1);
  const t = toss(page);
  await expect(t).toHaveAttribute("data-up", "0");
  await expect(t.locator(".toss-who")).toHaveText("あなた");
  await expect(t.locator(".toss-title")).toHaveText("先手");
  await expect(page.locator("#player-0")).toContainText("あなた");
  await expect(page.locator("#status")).toHaveText("抽選で先手");
  // 盤は操作できず、時計は止まっている
  await expect(page.locator(".board.acting")).toHaveCount(0);
  await expect(page.locator(".turn-clock.paused")).toBeVisible();
  await expect(page.locator(".turn-clock .clock-num")).toHaveText("45");
  // 石は 3D で回る（途中は黒と白の間）。連続写真と、落ちて黒が上を向いた結果
  const pre = prefix(page);
  if (pre === "pc") {
    for (const ms of [0, 250, 500, 750, 950, 1100]) {
      await freezeAt(page, ms);
      await page.screenshot({ path: `${SHOT}/${pre}-toss-frames-${String(ms).padStart(4, "0")}.png` });
    }
  }
  await freezeAt(page, 450);
  await page.screenshot({ path: `${SHOT}/${pre}-toss-spin-first.png` });
  await freezeAt(page, 1600);
  await page.screenshot({ path: `${SHOT}/${pre}-toss-result-first.png` });

  // 1.9 秒の途中ではまだ止まっている
  await page.clock.runFor(1000);
  await expect(t).toBeVisible();
  await expect(page.locator(".turn-clock .clock-num")).toHaveText("45");
  // 終わると演出が消え、打てる・時計が進む
  await page.clock.runFor(1000);
  await expect(t).toHaveCount(0);
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator(".turn-clock.paused")).toHaveCount(0);
  await expect(page.locator("#status")).toHaveText("あなたの番");
  await page.clock.runFor(3000);
  await expect(page.locator(".turn-clock .clock-num")).toHaveText("42");
  await expect(moves(page)).toHaveCount(0);
});

test("後手: 白が上を向き「後手」。演出が終わるまで CPU は打たず、終わってから先手の CPU が考え始める", async ({ page }) => {
  await startDrawn(page, 0.9);
  const t = toss(page);
  await expect(t).toHaveAttribute("data-up", "1");
  await expect(t.locator(".toss-title")).toHaveText("後手");
  await expect(page.locator("#player-1")).toContainText("あなた");
  const pre = prefix(page);
  await freezeAt(page, 450);
  await page.screenshot({ path: `${SHOT}/${pre}-toss-spin-second.png` });
  await freezeAt(page, 1600);
  await page.screenshot({ path: `${SHOT}/${pre}-toss-result-second.png` });
  await page.clock.runFor(1800);
  await expect(t).toBeVisible();
  await expect(moves(page)).toHaveCount(0);
  await page.clock.runFor(200);
  await expect(t).toHaveCount(0);
  // CPU の待ち時間（0.9 秒）の後に初手
  await expect(moves(page)).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(moves(page)).toHaveCount(1);
  await expect(moves(page).first()).toHaveClass(/\bp0\b/);
  await expect(page.locator(".board.acting")).toBeVisible();
});

test("飛ばす: 演出をタップ／クリックすると（メニューのボタンの上でも）すぐ対局へ。Enter・スペースでも飛ばせる", async ({ page }, info) => {
  const touch = info.project.name === "mobile";
  await startDrawn(page, 0.1);
  // メニューのボタンの上を押しても、演出を飛ばすだけでメニューは開かない
  const box = (await page.locator("#btn-menu").boundingBox())!;
  if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(toss(page)).toHaveCount(0);
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator(".board.acting")).toBeVisible();
  // 飛ばした後に時間が来ても何も起きない（二重に終わらせない）
  await page.clock.runFor(2500);
  await expect(page.locator(".board.acting")).toBeVisible();

  // メニューから始め直すと引き直して（乱数は同じ値）もう一度出る。Enter で飛ばしても、下のボタンは反応しない
  await page.locator("#btn-menu").click();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=easy]").click();
  await expect(toss(page)).toHaveAttribute("data-up", "0");
  await page.keyboard.press("Enter");
  await expect(toss(page)).toHaveCount(0);
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator(".board.acting")).toBeVisible();

  await page.locator("#btn-menu").click();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=easy]").click();
  await expect(toss(page)).toBeVisible();
  await page.keyboard.press(" ");
  await expect(toss(page)).toHaveCount(0);
  await expect(page.locator(".board.acting")).toBeVisible();
});

test("演出中にメニューへ移った: 演出を残さず、メニューの間は CPU も打たず、対局に戻ると続きから", async ({ page }) => {
  await startDrawn(page, 0.9);
  await expect(toss(page)).toBeVisible();
  // ボタンは演出に覆われているので、キーボードでメニューのボタンを押したのと同じ操作を直接起こす
  await page.locator("#btn-menu").dispatchEvent("click");
  await expect(page.locator("#menu")).toBeVisible();
  await expect(toss(page)).toHaveCount(0);
  // メニューの間は CPU も打たない
  await page.clock.runFor(3000);
  await page.locator("#menu-resume").click();
  await expect(toss(page)).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(moves(page)).toHaveCount(1);
  await expect(page.locator(".board.acting")).toBeVisible();
});

test("動きを減らす設定: 石は回さず、上を向いた色と結果だけを短く見せる", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startDrawn(page, 0.9);
  const t = toss(page);
  await expect(t).toHaveClass(/\breduce\b/);
  await expect(t.locator(".toss-title")).toHaveText("後手");
  // アニメーションはなく、石は最後の向き（白が上）で止まっている
  expect(await page.evaluate(() => document.querySelector(".fx-toss")!.getAnimations({ subtree: true }).length)).toBe(0);
  const m = await t.locator(".toss-coin").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform));
  expect(Math.round(m.m22)).toBe(-1);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-toss-reduced.png` });
  await page.clock.runFor(950);
  await expect(t).toHaveCount(0);
});

test("出さない: 手番を先手・後手に選んだとき、2 人対戦、遊び方", async ({ page }) => {
  await stubDraws(page, [0.9]);
  await page.goto("/");
  await startGame(page, { side: 1 });
  await expect(moves(page)).toHaveCount(1, { timeout: 10_000 });
  await expect(toss(page)).toHaveCount(0);
  await page.locator("#btn-menu").click();
  await startGame(page, { side: 0 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(toss(page)).toHaveCount(0);
  await page.locator("#btn-menu").click();
  await startGame(page, { mode: "pvp" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(toss(page)).toHaveCount(0);
  await page.locator("#btn-menu").click();
  await page.locator("#menu-learn").click();
  await expect(page.locator("#coach")).toBeVisible();
  await expect(toss(page)).toHaveCount(0);
  // 抽選は CPU 対戦の「ランダム」以外では引かない
  expect(await page.evaluate(() => (window as unknown as { __seatDraws: number }).__seatDraws)).toBe(0);
});
