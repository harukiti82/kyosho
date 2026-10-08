// オンライン対戦の 1 手の制限時間: 部屋を作った人の設定（既定 45 秒）が両者に見え、時間切れはサーバーが自動で打って両者の画面が一致する。
// 相手が切断していても時間は進む。待ち時間を短くするため、部屋を作る要求の turnSeconds を e2e 用の短い秒数に差し替える
// （サーバーは wrangler dev の --var TEST_TURN_SECONDS のときだけその秒数を受ける。playwright.online.config.ts）

import { expect, test } from "@playwright/test";
import { TEST_TURN_SECONDS } from "../../playwright.online.config";
import { createRoomFromSetup, joinFromInvite, newPlayer, playTurn, prefix, SHOT, waitPlaying, type Player } from "./net";

/** 部屋を作る要求の turnSeconds（画面の既定 45 秒）を、e2e 用の短い秒数に差し替える */
async function shortenTurn(host: Player) {
  await host.page.route("**/api/rooms", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    expect(body.turnSeconds).toBe(45);
    await route.continue({ postData: JSON.stringify({ ...body, turnSeconds: TEST_TURN_SECONDS }) });
  });
}

const moves = (p: Player) => p.page.locator("#log .log-item.move");

test("制限時間: 両者の名札に時計が出て、時間切れはサーバーが自動で打つ。両者の画面が一致し、相手が切断中でも進む", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await shortenTurn(host);
  const url = await createRoomFromSetup(host, null, "first");
  // 作成者の案内は自分の設定（要求を差し替える前の 45 秒）。参加者の確認はサーバーの部屋の値
  await expect(host.page.locator("#room-time")).toHaveText("1 手 45 秒（切れたら自動で 1 手）");
  await guest.page.goto(new URL(url).pathname + new URL(url).search);
  await expect(guest.page.locator("#room-time")).toHaveText(`1 手 ${TEST_TURN_SECONDS} 秒（切れたら自動で 1 手）`);
  await joinFromInvite(guest, url, `${SHOT}/${pre}-online-timer-join.png`);
  await waitPlaying(host, guest);

  // 先手（作成者）の手番: 両者の画面で先手の名札に時計（作成者は下、参加者は上）
  expect(host.last!.clock!.limitMs).toBe(TEST_TURN_SECONDS * 1000);
  await expect(host.page.locator("#seat-bottom #turn-clock")).toBeVisible();
  await expect(guest.page.locator("#seat-top #turn-clock")).toBeVisible();
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-timer-clock.png` });

  // 何もしないと、サーバーが先手の手を自動で打つ
  await expect.poll(() => host.last!.view.history.length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => guest.last!.view.history.length, { timeout: 15_000 }).toBe(1);
  for (const p of [host, guest]) {
    expect(p.last!.view.history[0]).toMatchObject({ type: "move", player: 0, timeout: true });
    await expect(moves(p)).toHaveCount(1);
    await expect(moves(p).first()).toHaveClass(/\btimeout\b/);
  }
  await expect(host.page.locator("#toast")).toContainText("時間切れ！ 先手（あなた）の手を自動で打ちました");
  await expect(guest.page.locator("#toast")).toContainText("時間切れ！ 先手（相手）の手を自動で打ちました");
  expect(guest.last!.view.board).toEqual(host.last!.view.board);
  expect(guest.last!.view.hp).toEqual(host.last!.view.hp);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-timer-timeout-host.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-timer-timeout-guest.png` });

  // 後手は時間内に打てる（時計は手番ごとに戻る）
  await playTurn(guest);
  await expect.poll(() => host.last!.view.history.length).toBe(2);
  expect(host.last!.view.history[1]).not.toHaveProperty("timeout");
  expect(host.last!.clock!.remainingMs).toBeGreaterThan(TEST_TURN_SECONDS * 1000 - 1000);

  // 先手も時間内に打ち、後手が切断する。切断中でも後手の時間は進み、自動の手が先手に届く
  await playTurn(host);
  await guest.page.close();
  await expect.poll(() => host.last!.opponent.online, { timeout: 15_000 }).toBe(false);
  await expect.poll(() => host.last!.view.history.length, { timeout: 15_000 }).toBe(4);
  expect(host.last!.view.history[3]).toMatchObject({ type: "move", player: 1, timeout: true });
  await expect(host.page.locator("#toast")).toContainText("時間切れ！ 後手（相手）の手を自動で打ちました");
  await expect(host.page.locator(".board.acting")).toBeVisible();
});

test("制限時間なしの部屋（設定で「なし」）は時計を出さない", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await host.page.goto("/");
  await host.page.locator("#menu-settings").click();
  await host.page.locator(`label:has(> input[name=timeMulti][value="0"])`).click();
  await host.page.locator("#setup-save").click();
  const url = await createRoomFromSetup(host, null, "first");
  await expect(host.page.locator("#room-time")).toHaveText("1 手の制限時間なし");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  expect(host.last!.clock).toBeNull();
  await expect(host.page.locator(".board.acting")).toBeVisible();
  await expect(host.page.locator("#turn-clock")).toHaveCount(0);
  await expect(guest.page.locator("#turn-clock")).toHaveCount(0);
});
