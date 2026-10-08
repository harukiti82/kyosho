// オンライン対戦の先手・後手の抽選の演出: 作成者が手番を「ランダム」にした部屋では、対局が始まると両者に石を投げる演出が出て、
// それぞれの画面で上を向いた色が自分の席（サーバーが決めた席）と一致すること。片方が先に演出を飛ばして打っても、
// もう一方は演出が終わってから相手の手を見せること、再読み込みでは出し直さないこと。
// 演出が遅れる側の時間は page.clock で止める。スクリーンショットは web/screenshots/*-online-toss-*.png

import { expect, test, type Page } from "@playwright/test";
import { createRoomFromSetup, newPlayer, playTurn, prefix, SHOT, waitPlaying, type Player } from "./net";

const toss = (p: Player) => p.page.locator(".fx-toss");
const moves = (p: Player) => p.page.locator("#log .log-item.move");

/** 画面の CSS アニメーションをすべて ms の時点で止める（演出の途中を撮る） */
async function freezeAt(page: Page, ms: number) {
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
}

async function pauseClock(page: Page) {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
}

test("席が抽選の部屋: 両者に演出が出て、上を向いた色が自分の席と一致する。先に打たれても演出の後に見せ、再読み込みでは出し直さない", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const url = await createRoomFromSetup(host, null, "random");
  await expect.poll(() => host.last?.phase).toBe("waiting");
  // 先手（席 0）と後手。後手の画面の時計を止め、演出が遅れて終わる側にする
  const hostSeat = host.last!.you;
  const [first, second] = hostSeat === 0 ? [host, guest] : [guest, host];
  await second.page.clock.install();
  if (second === host) await pauseClock(host.page);

  await guest.page.goto(new URL(url).pathname + new URL(url).search);
  await expect(guest.page.locator("#online")).toHaveAttribute("data-view", "join");
  if (second === guest) await pauseClock(guest.page);
  await guest.page.locator("#join-room").click();
  await waitPlaying(host, guest);
  expect(host.last!.seatDraw).toBe(true);
  expect(guest.last!.you).toBe(hostSeat === 0 ? 1 : 0);

  for (const p of [host, guest]) {
    const you = p.last!.you;
    await expect(toss(p)).toHaveAttribute("data-up", String(you));
    await expect(toss(p).locator(".toss-title")).toHaveText(you === 0 ? "先手" : "後手");
    await expect(p.page.locator(".board.acting")).toHaveCount(0);
  }
  await freezeAt(second.page, 450);
  await second.page.screenshot({ path: `${SHOT}/${pre}-online-toss-spin.png` });
  await freezeAt(second.page, 1600);
  await second.page.screenshot({ path: `${SHOT}/${pre}-online-toss-second.png` });
  await freezeAt(first.page, 1600);
  await first.page.screenshot({ path: `${SHOT}/${pre}-online-toss-first.png` });

  // 先手が再読み込み: まだ手がなくても演出は出し直さず、すぐ打てる
  await first.page.reload();
  await expect.poll(() => first.last?.phase).toBe("playing");
  await expect(first.page.locator(".board.acting")).toBeVisible();
  await expect(toss(first)).toHaveCount(0);

  // 先手が打つ。後手はまだ演出の途中（時計を止めている）なので、盤には出さない
  await playTurn(first);
  await expect.poll(() => second.last!.view.history.length).toBe(1);
  await expect(toss(second)).toBeVisible();
  await expect(moves(second)).toHaveCount(0);
  // 演出が終わると相手の手を見せ、自分の番
  await second.page.clock.runFor(2000);
  await expect(toss(second)).toHaveCount(0);
  await expect(moves(second)).toHaveCount(1);
  await second.page.clock.resume();
  await expect(second.page.locator(".board.acting")).toBeVisible();
});
