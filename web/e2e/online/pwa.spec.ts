// PWA の Service Worker が受け持っている画面でも、オンライン対戦の /api（HTTP と WebSocket）は SW を通らないこと。
// 両者とも SW が有効になってから部屋を作って参加し、1 手打つ。/api の応答はどれも SW からでなく、SW 自身も /api に行かない

import { expect, test, type Page } from "@playwright/test";
import { createRoomFromSetup, joinFromInvite, newPlayer, playTurn, waitPlaying, type Player } from "./net";

/** SW を入れて、画面を受け持つまで待つ */
async function installSw(page: Page) {
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 30_000 });
}

/** /api の応答と、SW が出したリクエストを記録する */
function record(p: Player) {
  const api: { url: string; fromSw: boolean }[] = [];
  const viaSw: string[] = [];
  p.page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api")) api.push({ url: r.url(), fromSw: r.fromServiceWorker() });
  });
  p.page.context().on("request", (r) => {
    if (r.serviceWorker()) viaSw.push(r.url());
  });
  return { api, viaSw };
}

test("SW があっても /api の HTTP と WebSocket は横取りされず、作成 → 参加 → 1 手が通る", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await installSw(host.page);
  await installSw(guest.page);
  const h = record(host);
  const g = record(guest);
  const url = await createRoomFromSetup(host, "std", "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  expect(await host.page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await guest.page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await playTurn(host);
  await expect.poll(() => guest.last?.view.history.length ?? 0).toBeGreaterThan(0);
  // WebSocket で state が届いている（SW は WebSocket を扱えないので、届けば素通し）
  expect(host.frames.length).toBeGreaterThan(0);
  expect(guest.frames.length).toBeGreaterThan(0);
  // /api の HTTP（health・rooms の作成と情報）はどれも SW からでない
  for (const r of [...h.api, ...g.api]) expect(r.fromSw, r.url).toBe(false);
  expect(h.api.some((r) => r.url.endsWith("/api/rooms"))).toBe(true);
  expect([...h.viaSw, ...g.viaSw].filter((u) => new URL(u).pathname.startsWith("/api"))).toEqual([]);
  await host.page.context().close();
  await guest.page.context().close();
});
