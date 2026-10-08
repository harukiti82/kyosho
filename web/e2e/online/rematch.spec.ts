// オンライン対戦の同じ部屋での再戦: 終局 → 申し込み → 断る → もう一度申し込む（二重押し）→ 受ける → 先手と後手を入れ替えた 2 局目、
// 申し込み中の再読み込み・同時の申し込み・相手の退室と新しい部屋。
// 終局まで速く進めるため、部屋を作る要求のルールを「裏返す・体力 5・回復なし」に差し替える（画面の操作は本物のまま）

import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { presetById, type RuleSet } from "../../src/engine/rules";
import { flipRecord, recordText } from "../../src/ui/outcome";
import { createRoomFromSetup, joinFromInvite, newPlayer, playToEnd, prefix, SHOT, waitPlaying, waitResult, type Player } from "./net";

/** 裏返すルールは毎手 1 枚以上返すので、体力 5（下限）・回復なしなら数手で決着する */
const QUICK: RuleSet = { ...presetById("orig").rules, heal: "none", hp: [5, 5] };

/** 部屋を作る要求のルールを QUICK に、制限時間を turnSeconds に差し替える */
async function quickRoom(host: Player, turnSeconds: number) {
  await host.page.route("**/api/rooms", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    await route.continue({ postData: JSON.stringify({ ...body, rules: QUICK, turnSeconds }) });
  });
}

/** 2 人が参加して 1 局を終局まで打ち、両者の終局画面が出た状態にする。作成者が先手 */
async function finishedPair(browser: Browser, info: TestInfo, turnSeconds = 0) {
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await quickRoom(host, turnSeconds);
  const url = await createRoomFromSetup(host, null, "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  await playToEnd(host, guest);
  await waitResult(host);
  await waitResult(guest);
  return { host, guest };
}

const note = (p: Page) => p.locator("#result-rematch-note");
const key = (p: Page, action: string) => p.locator(`#result [data-rematch=${action}]`);
/** 終局画面の成績表の「通算」の行（先手・後手の列の順） */
const recordRow = (p: Page) => p.locator("#result-detail .score tbody tr").filter({ has: p.locator("th", { hasText: "通算" }) }).locator("td");
/** 届いた state から、成績表の「通算」の行に出るはずの文（先手・後手の列の順） */
function recordCells(p: Player): string[] {
  const mine = p.last!.record;
  const seats = p.last!.you === 0 ? [mine, flipRecord(mine)] : [flipRecord(mine), mine];
  return seats.map(recordText);
}
const rematchSent = (p: Player) => p.sent.filter((t) => t.includes('"rematch"')).map((t) => JSON.parse(t));

test("申し込む → 断る → もう一度申し込む（二重押しは 1 回）→ 受ける: 同じ部屋・同じルール・同じ制限時間で、先手と後手が入れ替わった 2 局目を終局まで打つ", async ({ browser }, info) => {
  const pre = prefix(info);
  const { host, guest } = await finishedPair(browser, info, 45);
  expect([host.last!.gameNo, host.last!.you, guest.last!.you]).toEqual([1, 0, 1]);
  await expect(key(host.page, "request")).toHaveText("再戦");
  await expect(note(host.page)).toBeHidden();
  // 1 局目の通算は終局画面にだけ出す（名札は 2 局目から）
  const w1 = host.last!.view.result!.winner;
  expect(w1).not.toBeNull();
  expect(host.last!.record).toEqual(w1 === 0 ? { wins: 1, losses: 0, draws: 0 } : { wins: 0, losses: 1, draws: 0 });
  expect(guest.last!.record).toEqual(flipRecord(host.last!.record));
  for (const p of [host, guest]) {
    await expect(recordRow(p.page)).toHaveText(recordCells(p));
    await expect(p.page.locator(".plate-record")).toHaveCount(0);
  }

  // 申し込む: 自分は返事待ち、相手には申し込みと「受ける」「断る」
  await key(host.page, "request").click();
  await expect(note(host.page)).toHaveText("再戦の返事待ち");
  await expect(key(host.page, "cancel")).toHaveText("取り消し");
  await expect(note(guest.page)).toHaveText("相手から再戦の申し込み");
  await expect(key(guest.page, "request")).toHaveText("受ける");
  await expect(key(guest.page, "decline")).toHaveText("断る");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-asked.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-offer.png` });

  // 断る: 申し込んだ側に「断られました」、もう一度申し込める
  await key(guest.page, "decline").click();
  await expect(note(host.page)).toHaveText("再戦を断られました");
  await expect(note(guest.page)).toHaveText("再戦を断りました");
  await expect(key(host.page, "request")).toBeEnabled();
  await expect(key(guest.page, "request")).toHaveText("再戦");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-declined.png` });

  // 盤面を見ている間は駒台の場所に同じ鍵と状態。二重押し（ダブルクリック）でも申し込みは 1 回だけ送る
  await host.page.locator("#result-view").click();
  await expect(host.page.locator("#tray-rematch-note")).toHaveText("再戦を断られました");
  const before = rematchSent(host).length;
  await host.page.locator("#hand [data-rematch=request]").dblclick();
  await expect(host.page.locator("#tray-rematch-note")).toHaveText("再戦の返事待ち");
  expect(rematchSent(host).slice(before)).toEqual([{ type: "rematch", action: "request", gameNo: 1 }]);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-hand.png` });
  // 相手の終局画面は開いたまま、申し込みに切り替わる
  await expect(note(guest.page)).toHaveText("相手から再戦の申し込み");

  // 受ける: 2 局目。先手と後手が入れ替わり、終局画面は閉じる
  await key(guest.page, "request").click();
  await expect.poll(() => [host.last?.gameNo, guest.last?.gameNo]).toEqual([2, 2]);
  await waitPlaying(host, guest);
  expect([host.last!.you, guest.last!.you]).toEqual([1, 0]);
  expect(host.last!.view.history).toEqual([]);
  expect(host.last!.view.rules).toEqual(QUICK);
  for (const p of [host, guest]) {
    await expect(p.page.locator("#result")).toBeHidden();
    await expect(p.page.locator("#log .log-item")).toHaveCount(0);
  }
  await expect(guest.page.locator("#toast")).toHaveText("再戦開始　あなたは先手");
  await expect(host.page.locator("#toast")).toHaveText("再戦開始　あなたは後手");
  // 再戦は抽選でなく入れ替えなので、抽選の演出は出さない
  await expect(guest.page.locator(".fx-toss")).toHaveCount(0);
  await expect(host.page.locator(".fx-toss")).toHaveCount(0);
  // 自分は下の名札のまま（作成者は後手の席）。新しい先手（参加者）が操作でき、同じ制限時間の時計が先手の名札に出る
  await expect(host.page.locator("#seat-bottom #player-1")).toHaveCount(1);
  await expect(guest.page.locator("#seat-bottom #player-0")).toHaveCount(1);
  await expect(guest.page.locator("#status")).toHaveText("あなたの番");
  await expect(host.page.locator("#status")).toHaveText("相手の番");
  await expect(guest.page.locator(".board.acting")).toBeVisible();
  await expect(host.page.locator(".board.acting")).toHaveCount(0);
  await expect(guest.page.locator("#player-0 #turn-clock")).toBeVisible();
  expect(guest.last!.clock!.limitMs).toBe(45_000);
  // 2 局目から名札に通算。席が入れ替わっても作成者の 1 局目の結果は作成者の名札に出る
  await expect(host.page.locator("#player-1 .plate-record")).toHaveText(recordText(host.last!.record));
  await expect(host.page.locator("#player-0 .plate-record")).toHaveText(recordText(flipRecord(host.last!.record)));
  await expect(guest.page.locator("#player-0 .plate-record")).toHaveText(recordText(guest.last!.record));
  expect(guest.last!.record).toEqual(flipRecord(host.last!.record));
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-game2.png` });
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-game2-host.png` });

  // 2 局目を終局まで打つ（決着の演出から終局画面まで。結果は両者で一致）
  await playToEnd(guest, host);
  await waitResult(host);
  await waitResult(guest);
  expect(guest.last!.view.result).toEqual(host.last!.view.result);
  await expect(key(host.page, "request")).toHaveText("再戦");
  expect(host.last!.gameNo).toBe(2);
  // 両者が同じ打ち方なので 2 局目は同じ席が勝ち、人としては 1 勝 1 敗。両者の終局画面と名札に出る
  expect(guest.last!.view.result!.winner).toBe(w1);
  expect(host.last!.record).toEqual({ wins: 1, losses: 1, draws: 0 });
  expect(guest.last!.record).toEqual({ wins: 1, losses: 1, draws: 0 });
  for (const p of [host, guest]) {
    await expect(recordRow(p.page)).toHaveText(["1勝1敗", "1勝1敗"]);
    await expect(p.page.locator(".plate-record")).toHaveText(["1勝1敗", "1勝1敗"]);
  }
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-record-host.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-record-guest.png` });
  // 再読み込み（トークンで同じ席に戻る）しても通算は残る
  host.last = null;
  await host.page.reload();
  await waitResult(host);
  await expect(recordRow(host.page)).toHaveText(["1勝1敗", "1勝1敗"]);
  await expect(host.page.locator(".plate-record")).toHaveCount(2);
});

test("申し込み中の再読み込み・同時の申し込み・相手の退室（新しい部屋で再戦）", async ({ browser }, info) => {
  const pre = prefix(info);
  const { host, guest } = await finishedPair(browser, info);

  // 申し込み中に再読み込みしても、申し込みは残る（トークンで同じ席に戻る）
  await key(host.page, "request").click();
  await expect(note(guest.page)).toHaveText("相手から再戦の申し込み");
  host.last = null;
  await host.page.reload();
  await waitResult(host);
  await expect(note(host.page)).toHaveText("再戦の返事待ち");
  await expect(note(guest.page)).toHaveText("相手から再戦の申し込み");
  // 取り消すと相手の申し込みの表示も消える
  await key(host.page, "cancel").click();
  await expect(note(guest.page)).toBeHidden();
  await expect(key(guest.page, "request")).toHaveText("再戦");

  // 同時の申し込み: どちらが先でも成立し、2 局目は 1 つだけ
  await Promise.all([key(host.page, "request").click(), key(guest.page, "request").click()]);
  await expect.poll(() => [host.last?.gameNo, guest.last?.gameNo]).toEqual([2, 2]);
  await waitPlaying(host, guest);
  expect([host.last!.you, guest.last!.you]).toEqual([1, 0]);
  await guest.page.waitForTimeout(500);
  expect(host.last!.gameNo).toBe(2);
  expect(guest.frames.some((t) => t.includes('"gameNo":3'))).toBe(false);

  // 2 局目を終えて、相手が部屋を抜ける（メニューから別の対局を始める）
  await playToEnd(guest, host);
  await waitResult(host);
  await waitResult(guest);
  await key(guest.page, "request").click();
  await expect(note(host.page)).toHaveText("相手から再戦の申し込み");
  await guest.page.locator("#result-menu").click();
  await guest.page.locator("#menu-cpu").click();
  await guest.page.locator("[data-level=easy]").click();
  await expect(guest.page.locator("#game")).toBeVisible();
  // 申し込みは取り下げられ、退室が分かる。同じ部屋では申し込めないので、新しい部屋を作る
  await expect(note(host.page)).toHaveText("相手が退室しました");
  await expect(key(host.page, "request")).toHaveCount(0);
  await expect(key(host.page, "new")).toHaveText("新しい部屋で再戦");
  // 相手が抜けても、この部屋の 2 局分の通算はそのまま
  const rec = host.last!.record;
  expect(rec.wins + rec.losses + rec.draws).toBe(2);
  await expect(recordRow(host.page)).toHaveText(recordCells(host));
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-rematch-left.png` });
  const old = new URL(host.page.url()).search;
  await key(host.page, "new").click();
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "invite");
  await expect(host.page).not.toHaveURL(new RegExp(`\\${old}$`));
  // 新しい部屋の作成者の席は今の席（2 局目は後手）
  await expect(host.page.locator(".online-seat")).toHaveText("後手");
});
