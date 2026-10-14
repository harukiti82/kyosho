// オンライン対戦の合言葉: 同じ合言葉（全角と半角の違いは同じ）の 2 人が同じ部屋で対局する・違えばつながらない・
// そろった後の 3 人目は新しい部屋で待つ・待つのをやめた後の人は新しい部屋で待つ・先に席が埋まったら探し直す・
// 入力の検証・待っている人の再読み込み・同じブラウザの 2 つのタブ。
// サーバーは playwright.online.config.ts が起こす wrangler dev（保存先は実行をまたいで残るので、合言葉は実行ごとに変える）

import { expect, test } from "@playwright/test";
import { noHorizontalScroll } from "../helpers";
import { newPlayer, playTurn, prefix, saveOnlineSetup, SHOT, waitPlaying, watch, type Player } from "./net";

/** 実行ごと・テストごとに違う合言葉（前の実行やほかのテストの部屋とつながらない。20 字以内） */
let n = 0;
const run = Date.now().toString(36).slice(-6);
const fresh = (tag: string) => `${tag}${run}${++n}`;

/** 英数字を全角にする（同じ合言葉とみなされる） */
const wide = (s: string) => s.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

const roomOf = (p: Player) => new URL(p.page.url()).searchParams.get("room");

/** メニューのマルチ → オンライン 合言葉 で入力のダイアログを開く（トップを開くところから。open: false なら今の画面から） */
async function openPhrase(p: Player, open = true) {
  const { page } = p;
  if (open) await page.goto("/");
  await page.locator("#menu-multi").click();
  await expect(page.locator("#menu-phrase")).toBeVisible();
  await page.locator("#menu-phrase").click();
  await expect(page.locator("#online")).toHaveAttribute("data-view", "phrase");
}

/** 合言葉を入れて決める（Enter で送る）。待つ（phrase-wait）か参加の確認（join）になるまで待つ */
async function enterPhrase(p: Player, phrase: string, open = true): Promise<"phrase-wait" | "join"> {
  await openPhrase(p, open);
  await p.page.locator("#phrase-input").fill(phrase);
  await p.page.locator("#phrase-input").press("Enter");
  const online = p.page.locator("#online");
  await expect(online).toHaveAttribute("data-view", /^(phrase-wait|join)$/, { timeout: 15_000 });
  return (await online.getAttribute("data-view")) as "phrase-wait" | "join";
}

/** 待っている（自分の部屋で相手を待つ表示と、state の waiting） */
async function expectWaiting(p: Player) {
  await expect(p.page.locator("#online")).toHaveAttribute("data-view", "phrase-wait");
  await expect(p.page.locator("#phrase-waiting")).toBeVisible();
  await expect.poll(() => p.last?.phase, { timeout: 15_000 }).toBe("waiting");
  expect(roomOf(p)).toMatch(/^[A-Za-z0-9_-]{22}$/);
}

test("全角と半角で入れた同じ合言葉の 2 人が、同じ部屋で対局し、手が両方に届く。合言葉は WebSocket に流れない", async ({ browser }, info) => {
  const pre = prefix(info);
  const width = info.project.use.viewport!.width;
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const phrase = fresh("ab");

  await saveOnlineSetup(host, "std", "first");
  expect(await enterPhrase(host, wide(phrase.toUpperCase()), false)).toBe("phrase-wait");
  await expectWaiting(host);
  // 待っている本人の画面には、正規化した合言葉を出す
  await expect(host.page.locator("#phrase-show")).toHaveText(phrase);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-phrase-wait.png` });
  await noHorizontalScroll(host.page, width);

  expect(await enterPhrase(guest, phrase)).toBe("join");
  // 参加の前に、待っていた人のルールを見せる
  await expect(guest.page.locator("#online-title")).toHaveText("合言葉の相手");
  await expect(guest.page.locator(".online-rules summary")).toContainText("スキルなし");
  await expect(guest.page.locator("#join-own")).toHaveCount(0);
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-phrase-join.png` });
  await noHorizontalScroll(guest.page, width);
  await guest.page.locator("#join-room").click();

  await waitPlaying(host, guest);
  expect(roomOf(guest)).toBe(roomOf(host));
  expect(host.last!.you).toBe(0);
  expect(guest.last!.you).toBe(1);
  await playTurn(host);
  await expect.poll(() => guest.last!.view.history.length).toBe(1);
  await playTurn(guest);
  await expect.poll(() => host.last!.view.history.length).toBe(2);
  // 合言葉はサーバーから届くメッセージにも、送る手にも入らない
  for (const raw of [...host.frames, ...guest.frames, ...host.sent, ...guest.sent]) expect(raw).not.toContain(phrase);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-phrase-play.png` });
});

test("違う合言葉ならつながらず、どちらも自分の部屋で待つ", async ({ browser }, info) => {
  const a = await newPlayer(browser, info, "a");
  const b = await newPlayer(browser, info, "b");
  expect(await enterPhrase(a, fresh("ringo"))).toBe("phrase-wait");
  expect(await enterPhrase(b, fresh("mikan"))).toBe("phrase-wait");
  await expectWaiting(a);
  await expectWaiting(b);
  expect(roomOf(a)).not.toBe(roomOf(b));
  await expect.poll(() => a.last?.opponent.joined).toBe(false);
});

test("2 人がそろった後に同じ合言葉を入れた 3 人目は、新しい部屋で待つ", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const third = await newPlayer(browser, info, "third");
  const phrase = fresh("san");
  await saveOnlineSetup(host, "std", "first");
  expect(await enterPhrase(host, phrase, false)).toBe("phrase-wait");
  await expectWaiting(host);
  expect(await enterPhrase(guest, phrase)).toBe("join");
  await guest.page.locator("#join-room").click();
  await waitPlaying(host, guest);

  expect(await enterPhrase(third, phrase)).toBe("phrase-wait");
  await expectWaiting(third);
  expect(roomOf(third)).not.toBe(roomOf(host));
});

test("待っている人が「やめる」で抜けた後に同じ合言葉を入れた人は、新しい部屋で待つ", async ({ browser }, info) => {
  const a = await newPlayer(browser, info, "a");
  const b = await newPlayer(browser, info, "b");
  const phrase = fresh("yame");
  expect(await enterPhrase(a, phrase)).toBe("phrase-wait");
  await expectWaiting(a);
  const old = roomOf(a);
  await a.page.locator("#phrase-leave").click();
  await expect(a.page.locator("#menu")).toBeVisible();
  expect(roomOf(a)).toBeNull();

  expect(await enterPhrase(b, phrase)).toBe("phrase-wait");
  await expectWaiting(b);
  expect(roomOf(b)).not.toBe(old);
});

test("待っている人がタブを閉じた後に同じ合言葉を入れた人は、新しい部屋で待つ", async ({ browser }, info) => {
  const a = await newPlayer(browser, info, "a");
  const b = await newPlayer(browser, info, "b");
  const phrase = fresh("toji");
  expect(await enterPhrase(a, phrase)).toBe("phrase-wait");
  await expectWaiting(a);
  const old = roomOf(a);
  await a.page.context().close();

  // サーバーが切断を受け取るまで少し待つ
  await expect(async () => {
    expect(await enterPhrase(b, phrase)).toBe("phrase-wait");
    expect(roomOf(b)).not.toBe(old);
  }).toPass({ timeout: 15_000 });
  await expectWaiting(b);
});

test("参加の確認の間に、ほかの人が先に席に座ったら、同じ合言葉で探し直して新しい部屋で待つ", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host");
  const slow = await newPlayer(browser, info, "slow");
  const fast = await newPlayer(browser, info, "fast");
  const phrase = fresh("haya");
  await saveOnlineSetup(host, "std", "first");
  expect(await enterPhrase(host, phrase, false)).toBe("phrase-wait");
  await expectWaiting(host);
  // 2 人とも参加の確認まで進む（どちらにも待っている部屋が見える）
  expect(await enterPhrase(slow, phrase)).toBe("join");
  expect(await enterPhrase(fast, phrase)).toBe("join");
  await fast.page.locator("#join-room").click();
  await waitPlaying(host, fast);
  // 遅れた人は満員で入れず、探し直して自分の部屋で待つ
  await slow.page.locator("#join-room").click();
  await expectWaiting(slow);
  expect(roomOf(slow)).not.toBe(roomOf(host));
});

test("入力の検証: 空・長すぎる・使えない文字は送らずに理由を出す。「?」で注意を開く", async ({ browser }, info) => {
  const p = await newPlayer(browser, info, "p");
  await openPhrase(p);
  const { page } = p;
  await expect(page.locator("#phrase-help")).toBeHidden();
  await page.locator("#phrase-help-btn").click();
  await expect(page.locator("#phrase-help")).toBeVisible();
  await expect(page.locator("#phrase-help")).toContainText("知らない人");

  await page.locator("#phrase-go").click();
  await expect(page.locator("#phrase-error")).toHaveText("合言葉を入れてください");
  await page.locator("#phrase-input").fill("　 ");
  await page.locator("#phrase-go").click();
  await expect(page.locator("#phrase-error")).toHaveText("合言葉を入れてください");
  await page.locator("#phrase-input").fill("a".repeat(21));
  await page.locator("#phrase-go").click();
  await expect(page.locator("#phrase-error")).toHaveText("合言葉は 20 字まで");
  // 入れた文字は欄に残る
  await expect(page.locator("#phrase-input")).toHaveValue("a".repeat(21));
  await page.locator("#phrase-input").fill("a​b");
  await page.locator("#phrase-go").click();
  await expect(page.locator("#phrase-error")).toHaveText("使えない文字が入っています");
  await expect(page.locator("#online")).toHaveAttribute("data-view", "phrase");
  expect(p.sent).toHaveLength(0);
  await page.screenshot({ path: `${SHOT}/${prefix(info)}-online-phrase-input.png` });
  await noHorizontalScroll(page, info.project.use.viewport!.width);
  // やめるとマルチの段に戻る
  await page.locator("#phrase-cancel").click();
  await expect(page.locator("#online")).toBeHidden();
  await expect(page.locator("#menu-phrase")).toBeVisible();
});

test("待っている人が再読み込みしても、同じ部屋で合言葉を出して待ち、相手が来れば始まる", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const phrase = fresh("yomi");
  await saveOnlineSetup(host, "std", "first");
  expect(await enterPhrase(host, phrase, false)).toBe("phrase-wait");
  await expectWaiting(host);
  const room = roomOf(host);
  host.last = null;
  await host.page.reload();
  await expectWaiting(host);
  expect(roomOf(host)).toBe(room);
  await expect(host.page.locator("#phrase-show")).toHaveText(phrase);

  expect(await enterPhrase(guest, phrase)).toBe("join");
  await guest.page.locator("#join-room").click();
  await waitPlaying(host, guest);
  expect(roomOf(guest)).toBe(room);
});

test("同じブラウザの別のタブで同じ合言葉を入れると、自分の部屋だと注意してから参加できる（招待リンクと同じ）", async ({ browser }, info) => {
  const a = await newPlayer(browser, info, "a");
  const phrase = fresh("tab");
  await saveOnlineSetup(a, "std", "first");
  expect(await enterPhrase(a, phrase, false)).toBe("phrase-wait");
  await expectWaiting(a);
  const b = watch(await a.page.context().newPage(), "b", a.touch);
  expect(await enterPhrase(b, phrase)).toBe("join");
  await expect(b.page.locator("#join-own")).toBeVisible();
  await b.page.locator("#join-room").click();
  await waitPlaying(a, b);
  expect(roomOf(b)).toBe(roomOf(a));
});
