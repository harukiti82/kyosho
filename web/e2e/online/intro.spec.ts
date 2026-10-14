// 初めての人は遊び方から（ui/intro.ts）のオンライン対戦: 招待リンク・合言葉で来た初めての人は、その対局を先に遊べる。
// 対局が始まった後にメニューへ戻ると、CPU対戦・マルチ（合言葉も）は遊び方の後。合言葉の入口は、初めての人の最初の対局までは開いている
// （待つのをやめただけなら開いたまま）。初めての人の役は何も保存していないコンテキスト（newPlayer の fresh）

import { expect, test, type Page } from "@playwright/test";
import { LOCKED_TITLE } from "../../src/ui/menu";
import { noHorizontalScroll } from "../helpers";
import { createRoomFromSetup, enterPhrase, joinFromInvite, newPlayer, playToEnd, prefix, saveOnlineSetup, SHOT, waitPlaying, waitResult } from "./net";

let n = 0;
const run = Date.now().toString(36).slice(-6);
const fresh = (tag: string) => `${tag}${run}${++n}`;

const locked = (page: Page, id: string) => expect(page.locator(`#${id}`)).toHaveClass(/\blocked\b/);
const open = (page: Page, id: string) => expect(page.locator(`#${id}`)).not.toHaveClass(/\blocked\b/);

/** メニューで CPU対戦・マルチと、マルチの中の入口が全部閉じている */
async function expectAllLocked(page: Page) {
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#menu-phrase")).toBeAttached();
  for (const id of ["menu-cpu", "menu-multi", "menu-pvp", "menu-online", "menu-phrase"]) await locked(page, id);
  await page.locator("#menu-multi").click();
  await expect(page.locator("#toast")).toHaveText(LOCKED_TITLE);
  await expect(page.locator("#menu-modes")).toBeHidden();
}

test("招待リンクで来た初めての人は、その対局に入って終局まで打てる。終局後にメニューへ戻ると遊び方の後", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest", { fresh: true });
  const url = await createRoomFromSetup(host, "std", "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  // 対局の途中にメニューを開くと閉じているが、対局には戻れる
  await guest.page.locator("#btn-menu").click();
  await expectAllLocked(guest.page);
  await guest.page.waitForTimeout(800);
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-intro-guest-menu.png` });
  await guest.page.locator("#menu-resume").click();
  await expect(guest.page.locator("#game")).toBeVisible();

  await playToEnd(host, guest);
  await waitResult(guest);
  await guest.page.locator("#result-menu").click();
  await expectAllLocked(guest.page);
  // 開き直しても同じ（オンライン対戦を 1 局始めた印は残る）
  await guest.page.goto("/");
  await expectAllLocked(guest.page);
  // 遊び方は始められる
  await guest.page.locator("#menu-learn").click();
  await expect(guest.page.locator("#coach-num")).toHaveText("1/16");
  await host.page.context().close();
  await guest.page.context().close();
});

test("合言葉で来る初めての人は、マルチの合言葉だけを使える。対局が始まった後は合言葉も遊び方の後", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest", { fresh: true });
  const page = guest.page;

  await page.goto("/");
  await expect(page.locator("#menu-phrase")).toBeAttached();
  // /api/health に届いて入口が出たら、マルチの錠が外れる
  await open(page, "menu-multi");
  await locked(page, "menu-cpu");
  await page.locator("#menu-multi").click();
  await expect(page.locator("#menu-modes")).toBeVisible();
  await locked(page, "menu-pvp");
  await locked(page, "menu-online");
  await open(page, "menu-phrase");
  // 段が出てくる動きが終わってから撮る
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT}/${pre}-online-intro-phrase-menu.png` });
  await noHorizontalScroll(page, info.project.use.viewport!.width);
  await page.locator("#menu-pvp").click();
  await expect(page.locator("#toast")).toHaveText(LOCKED_TITLE);
  await expect(page.locator("#game")).toBeHidden();
  await page.locator("#menu-modes .menu-back").click();

  // 待つのをやめただけなら、合言葉は開いたまま
  expect(await enterPhrase(guest, fresh("solo"), false)).toBe("phrase-wait");
  await page.locator("#phrase-leave").click();
  await expect(page.locator("#menu")).toBeVisible();
  await open(page, "menu-multi");
  await open(page, "menu-phrase");

  // 合言葉で対局する
  const phrase = fresh("intro");
  await saveOnlineSetup(host, "std", "first");
  expect(await enterPhrase(host, phrase, false)).toBe("phrase-wait");
  expect(await enterPhrase(guest, phrase, false)).toBe("join");
  await page.locator("#join-room").click();
  await waitPlaying(host, guest);
  await page.locator("#btn-menu").click();
  await expectAllLocked(page);
  await page.goto("/");
  await expectAllLocked(page);
  await host.page.context().close();
  await page.context().close();
});
