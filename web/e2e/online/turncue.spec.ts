// オンライン対戦の手番の知らせ: 相手が打ち終えたら自分の画面にだけ「あなたの番」。自分の手の後には出さない。
// 対局の始め（相手がそろった）には先手に出し、再読み込みの直後の手番には出さない（次の手番からまた出す）。
// 帯はすぐ消えるので MutationObserver で記録する（再読み込みすると空から数え直す）

import { expect, test, type Page } from "@playwright/test";
import { createRoomFromSetup, joinFromInvite, newPlayer, playTurn, prefix, SHOT, waitPlaying } from "./net";

async function recordCues(page: Page) {
  await page.addInitScript(() => {
    const cues: { text: string; acting: boolean }[] = [];
    (window as unknown as { __cues: typeof cues }).__cues = cues;
    new MutationObserver((ms) => {
      for (const m of ms) {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement && n.classList.contains("fx-turn")) cues.push({ text: n.textContent ?? "", acting: !!document.querySelector(".board.acting") });
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

const cueCount = (page: Page) => page.evaluate(() => (window as unknown as { __cues: unknown[] }).__cues.length);
const cueList = (page: Page) => page.evaluate(() => (window as unknown as { __cues: { text: string; acting: boolean }[] }).__cues);

test("相手が打ち終えたら自分の画面にだけ出る。再読み込みの直後は出さない", async ({ browser }, info) => {
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  await recordCues(host.page);
  await recordCues(guest.page);
  const url = await createRoomFromSetup(host, "std", "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  // 対局の始め: 先手（作成者）にだけ
  await expect.poll(() => cueCount(host.page)).toBe(1);
  expect(await cueCount(guest.page)).toBe(0);

  // 作成者が打つ → 参加者にだけ出る
  await playTurn(host);
  await expect.poll(() => cueCount(guest.page)).toBe(1);
  await guest.page.screenshot({ path: `${SHOT}/${prefix(info)}-online-turncue.png` });
  expect(await cueList(guest.page)).toEqual([{ text: "あなたの番", acting: true }]);
  expect(await cueCount(host.page)).toBe(1);

  // 参加者の番のまま再読み込み: 局面が戻って打てるが、知らせは出さない
  await guest.page.reload();
  await expect(guest.page.locator(".board.acting")).toBeVisible({ timeout: 15_000 });
  await guest.page.waitForTimeout(1500);
  expect(await cueCount(guest.page)).toBe(0);

  // 再読み込みの後も、次の手番からは出す
  await playTurn(guest);
  await expect.poll(() => cueCount(host.page)).toBe(2);
  await playTurn(host);
  await expect.poll(() => cueCount(guest.page)).toBe(1);
  expect(await cueCount(host.page)).toBe(2);
});
