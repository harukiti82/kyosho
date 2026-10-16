// オンライン対戦の前の名前の案内（ui/namedialog.ts。名前がなく、この端末でまだ案内していない人に 1 回だけ）。
// 確かめること: メニューの招待リンク・合言葉の前に案内が出て、決めた名前は join で送られメニューの名札にも出る・「名前なし」でも進む・
// 一度出したら次は出ない・名前を決めてある人には出ない・Esc はやめてメニューに戻る（次にまた出る）・
// 招待リンクで来た人は参加の確認に名前の欄が添わる（ダイアログを挟まない。入れなくても参加でき、通らない名前は参加させない）。
// 案内を出していない人は newPlayer の askName（遊び方の必須を解いた印だけ）

import { expect, test, type Page } from "@playwright/test";
import { createRoomFromSetup, enterPhrase, newPlayer, prefix, saveOnlineSetup, SHOT, waitPlaying, type Player } from "./net";

let n = 0;
const run = Date.now().toString(36).slice(-6);
const fresh = (tag: string) => `${tag}${run}${++n}`;

const ask = (page: Page) => page.locator("#name-dialog[data-mode=ask]");
const joinSent = (p: Player) => p.sent.filter((t) => t.includes('"join"')).map((t) => JSON.parse(t));
const savedName = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("kyosho:settings") ?? "{}").name ?? null);

/** メニューのマルチ → オンライン 招待リンク（名前の案内が出るかは呼ぶ側で） */
async function clickOnline(page: Page) {
  await page.locator("#menu-multi").click();
  await expect(page.locator("#menu-online")).toBeVisible();
  await page.locator("#menu-online").click();
}

test("招待リンクを作る前に名前の案内: 決めた名前を送り、メニューの名札にも出る。招待された人は参加の確認の欄で名前を決める", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host", { askName: true });
  const guest = await newPlayer(browser, info, "guest", { askName: true });
  await saveOnlineSetup(host, "std", "first");
  await clickOnline(host.page);
  await expect(ask(host.page)).toBeVisible();
  await expect(host.page.locator("#name-dialog-other")).toHaveText("名前なし");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-name-ask.png` });
  await host.page.locator("#name-dialog-input").fill("はる");
  await host.page.locator("#name-dialog-ok").click();
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "invite");
  const url = await host.page.locator("#invite-url").inputValue();
  expect(await savedName(host.page)).toBe("はる");

  // 招待された人: 参加の確認に名前の欄（通らない名前は参加させない）
  await guest.page.goto(new URL(url).pathname + new URL(url).search);
  await expect(guest.page.locator("#online")).toHaveAttribute("data-view", "join");
  await expect(ask(guest.page)).toBeHidden();
  const field = guest.page.locator("#join-name");
  await expect(field).toBeVisible();
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-name-join.png` });
  await field.fill("あ".repeat(11));
  await guest.page.locator("#join-room").click();
  await expect(guest.page.locator("#join-name-error")).toHaveText("10文字まで");
  await expect(guest.page.locator("#online")).toHaveAttribute("data-view", "join");
  await field.fill("ゆき");
  await field.press("Enter");
  await waitPlaying(host, guest);
  expect(joinSent(host)[0]).toMatchObject({ type: "join", name: "はる" });
  expect(joinSent(guest)[0]).toMatchObject({ type: "join", name: "ゆき" });
  expect(await savedName(guest.page)).toBe("ゆき");

  // メニューの名札にも出る
  await host.page.locator("#btn-menu").click();
  await expect(host.page.locator("#menu-name-text")).toHaveText("はる");
  await host.page.context().close();
  await guest.page.context().close();
});

test("「名前なし」でも進み、次からは案内しない。招待された人は欄を空のまま参加できる", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host", { askName: true });
  const guest = await newPlayer(browser, info, "guest", { askName: true });
  await saveOnlineSetup(host, "std", "first");
  await clickOnline(host.page);
  await expect(ask(host.page)).toBeVisible();
  await host.page.locator("#name-dialog-other").click();
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "invite");
  await host.page.locator("#invite-leave").click();
  await expect(host.page.locator("#menu")).toBeVisible();

  // 次は（再読み込みしても）案内しない: 合言葉も招待リンクもそのまま
  await host.page.reload();
  await host.page.locator("#menu-multi").click();
  await host.page.locator("#menu-phrase").click();
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "phrase");
  await expect(ask(host.page)).toBeHidden();
  await host.page.locator("#phrase-cancel").click();
  await host.page.locator("#menu-online").click();
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "invite");
  await expect(ask(host.page)).toBeHidden();
  const url = await host.page.locator("#invite-url").inputValue();
  // 設定メニューで保存したときの名前なしのまま
  expect(await savedName(host.page)).toBe("");

  // 招待された人は欄を空のまま参加（名前なし）
  await guest.page.goto(new URL(url).pathname + new URL(url).search);
  await expect(guest.page.locator("#online")).toHaveAttribute("data-view", "join");
  await expect(guest.page.locator("#join-name")).toHaveValue("");
  await guest.page.locator("#join-room").click();
  await expect.poll(() => joinSent(guest).length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(joinSent(guest)[0].name ?? "").toBe("");
  await host.page.context().close();
  await guest.page.context().close();
});

test("名前を決めてある人には案内も参加の確認の欄も出ない。Esc はやめてメニューに戻り、次にまた出る", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host", { askName: true });
  const guest = await newPlayer(browser, info, "guest", { askName: true });

  // Esc: 合言葉に進まずメニューへ。案内した印は付けない
  await host.page.goto("/");
  await host.page.locator("#menu-multi").click();
  await host.page.locator("#menu-phrase").click();
  await expect(ask(host.page)).toBeVisible();
  await host.page.keyboard.press("Escape");
  await expect(ask(host.page)).toBeHidden();
  await expect(host.page.locator("#online")).toBeHidden();
  await expect(host.page.locator("#menu-modes")).toBeVisible();
  await host.page.locator("#menu-phrase").click();
  await expect(ask(host.page)).toBeVisible();
  await host.page.keyboard.press("Escape");

  // メニューの名札で名前を決めた人には出ない
  await host.page.locator("#menu-modes .menu-back").click();
  await host.page.locator("#menu-name").click();
  await host.page.locator("#name-dialog-input").fill("はる");
  await host.page.locator("#name-dialog-ok").click();
  const phrase = fresh("nm");
  expect(await enterPhrase(host, phrase, false)).toBe("phrase-wait");

  await guest.page.goto("/");
  await guest.page.locator("#menu-name").click();
  await guest.page.locator("#name-dialog-input").fill("ゆき");
  await guest.page.locator("#name-dialog-ok").click();
  const url = await createRoomFromSetup(guest, "std", "first");
  await expect(ask(guest.page)).toBeHidden();
  await host.page.goto(new URL(url).pathname + new URL(url).search);
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "join");
  await expect(host.page.locator("#join-name")).toHaveCount(0);
  await host.page.context().close();
  await guest.page.context().close();
});
