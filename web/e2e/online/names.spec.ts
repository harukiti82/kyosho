// オンライン対戦の名前: 設定で決めた名前が join で送られ、相手の画面の名札・終局画面に出る（逆も）。
// 招待リンクと合言葉の両方・再読み込み（つなぎ直し）・同じ部屋の再戦（先手と後手が入れ替わる）・
// HTML の文字列は文字のまま。終局まで速く進めるため、部屋を作る要求のルールを「裏返す・体力 5・回復なし」に差し替える（rematch.spec と同じ）

import { expect, test, type Page } from "@playwright/test";
import { presetById, type RuleSet } from "../../src/engine/rules";
import { createRoomFromSetup, enterPhrase, joinFromInvite, newPlayer, playToEnd, prefix, saveOnlineSetup, SHOT, waitPlaying, waitResult, type Player } from "./net";

const QUICK: RuleSet = { ...presetById("orig").rules, heal: "none", hp: [5, 5] };

/** 実行ごと・テストごとに違う合言葉（phrase.spec と同じ考え方） */
const run = Date.now().toString(36).slice(-6);

/** 部屋を作る要求（招待リンク・合言葉）のルールを QUICK に差し替える */
async function quickRooms(p: Player) {
  for (const path of ["**/api/rooms", "**/api/match"]) {
    await p.page.route(path, async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      await route.continue({ postData: JSON.stringify({ ...body, rules: QUICK, turnSeconds: 0 }) });
    });
  }
}

/** トップを開き、設定メニューで自分の名前を決めて保存する */
async function saveName(p: Player, name: string) {
  const { page } = p;
  await page.goto("/");
  await page.locator("#menu-settings").click();
  await page.locator("#name-self").fill(name);
  await page.locator("#setup-save").click();
  await expect(page.locator("#setup")).toBeHidden();
}

const plateName = (page: Page, seat: number) => page.locator(`#player-${seat} .player-name`);
const joinSent = (p: Player) => p.sent.filter((t) => t.includes('"join"')).map((t) => JSON.parse(t));

/** 両者の名札: 自分の席に自分の名前、相手の席に相手の名前（名前なしは「あなた」「相手」） */
async function expectPlates(a: Player, aName: string, b: Player, bName: string) {
  for (const [me, mine, theirs] of [[a, aName, bName], [b, bName, aName]] as const) {
    const you = me.last!.you;
    await expect(plateName(me.page, you)).toHaveText(mine);
    await expect(plateName(me.page, 1 - you)).toHaveText(theirs);
  }
}

test("招待リンク: 相手の画面に自分の名前、自分の画面に相手の名前。再読み込み・終局画面・同じ部屋の再戦でも出る", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await quickRooms(host);
  await saveName(host, "はる");
  await saveName(guest, "<b>ゆき</b>");
  const url = await createRoomFromSetup(host, null, "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  // join に名前を付けて送り、サーバーが受け付けた名前が state で届く
  expect(joinSent(host)[0]).toMatchObject({ type: "join", name: "はる" });
  expect(joinSent(guest)[0]).toEqual({ type: "join", name: "<b>ゆき</b>" });
  expect(host.last).toMatchObject({ name: "はる", opponent: { name: "<b>ゆき</b>" } });
  expect(guest.last).toMatchObject({ name: "<b>ゆき</b>", opponent: { name: "はる" } });
  await expectPlates(host, "はる", guest, "<b>ゆき</b>");
  // HTML の文字列は文字のまま（要素にならない）
  await expect(host.page.locator("#player-1 .player-name b")).toHaveCount(0);
  await expect(plateName(host.page, 1)).toHaveAttribute("title", "後手（<b>ゆき</b>）");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-names-host.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-names-guest.png` });

  // 再読み込み（つなぎ直し）しても両者の名前
  await guest.page.reload();
  await expect.poll(() => guest.last?.phase, { timeout: 15_000 }).toBe("playing");
  await expect(guest.page.locator("#online")).toBeHidden();
  await expectPlates(host, "はる", guest, "<b>ゆき</b>");

  // 終局画面
  await playToEnd(host, guest);
  await waitResult(host);
  await waitResult(guest);
  const winner = host.last!.view.result!.winner;
  const won = winner === null ? "引き分け" : winner === 0 ? "はるの勝ち" : "<b>ゆき</b>の勝ち";
  await expect(host.page.locator("#result-winner")).toHaveText(won);
  await expect(guest.page.locator("#result-winner")).toHaveText(won);
  for (const p of [host, guest]) await expect(p.page.locator("#result-detail .score-name")).toHaveText(["はる", "<b>ゆき</b>"]);
  await expect(guest.page.locator("#result-stats .stats-title")).toHaveText("<b>ゆき</b>の成績");
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-names-result.png` });

  // 同じ部屋の再戦: 先手と後手が入れ替わっても名前は人に付いて回る
  await host.page.locator("#result [data-rematch=request]").click();
  await expect(guest.page.locator("#result [data-rematch=request]")).toHaveText("受ける");
  await guest.page.locator("#result [data-rematch=request]").click();
  await expect.poll(() => host.last?.gameNo, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => guest.last?.gameNo, { timeout: 15_000 }).toBe(2);
  expect([host.last!.you, guest.last!.you]).toEqual([1, 0]);
  await expectPlates(host, "はる", guest, "<b>ゆき</b>");
  await expect(plateName(host.page, 0)).toHaveText("<b>ゆき</b>");
});

test("合言葉: 両者の名前が相手の画面に出る（絵文字も）。終局画面も", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await quickRooms(host);
  const phrase = `name${run}${info.project.name.slice(0, 1)}`;
  await saveName(host, "🍣ずし🍣");
  await saveName(guest, "ゆき");
  await saveOnlineSetup(host, "std", "first");
  expect(await enterPhrase(host, phrase, false)).toBe("phrase-wait");
  expect(await enterPhrase(guest, phrase)).toBe("join");
  await guest.page.locator("#join-room").click();
  await waitPlaying(host, guest);
  expect(joinSent(guest)[0]).toEqual({ type: "join", name: "ゆき" });
  expect(host.last).toMatchObject({ name: "🍣ずし🍣", opponent: { name: "ゆき" } });
  expect(guest.last).toMatchObject({ name: "ゆき", opponent: { name: "🍣ずし🍣" } });
  await expectPlates(host, "🍣ずし🍣", guest, "ゆき");
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-names-phrase.png` });

  await playToEnd(host, guest);
  await waitResult(host);
  await waitResult(guest);
  const winner = host.last!.view.result!.winner;
  const won = winner === null ? "引き分け" : winner === 0 ? "🍣ずし🍣の勝ち" : "ゆきの勝ち";
  for (const p of [host, guest]) {
    await expect(p.page.locator("#result-winner")).toHaveText(won);
    await expect(p.page.locator("#result-detail .score-name")).toHaveText(["🍣ずし🍣", "ゆき"]);
  }
});
