// CPU 対戦（強さごと）と同じ端末の 2 人対戦の通算（localStorage kyosho:record）をヘッドレスブラウザで確かめる。
// 短い対局（4 手で打ち切り）を置ける手から打って終え、終局画面の勝ち負けから期待する通算を数える。
// 確かめること: 2 局目から終局画面・名札に出る・強さごとに分ける・途中でやめた対局と遊び方の実戦は数えない・再読み込みで残る・
// 待ったを使った対局と引き分けも数える・設定メニューの「通算を消す」（画面内の確認）・壊れた保存や localStorage がなくても対局できる。

import { expect, test, type Page } from "@playwright/test";
import { createGame, playMove } from "../src/engine/game";
import { presetById, type RuleSet } from "../src/engine/rules";
import type { MatchRecord } from "../src/net/protocol";
import { flipRecord, recordText } from "../src/ui/outcome";
import { RECORD_KEY } from "../src/ui/record";
import { encodeRules } from "../src/ui/query";
import { cellAt, greedy, noHorizontalScroll, openSettings, play, seedPage, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const ORIG = presetById("orig").rules;
/** 4 手で打ち切り（体力判定） */
const SHORT: RuleSet = { ...ORIG, maxPlies: 4 };
/** 歩 1 枚ずつ: 返す駒が最も多い手と 2 手読みの CPU では、1 手ずつ打って体力も石数も同じで引き分け（result.spec の DRAW） */
const DRAW: RuleSet = { ...ORIG, hand: { fu: 1, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 } };
/** 2 人対戦で両者が返す駒の最も多い手を打つと、先手が 11 手で勝つ（result.spec の PVP_BLACK） */
const PVP_BLACK: RuleSet = { ...ORIG, hp: [5, 5] };

const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");
const isTouch = (page: Page) => prefix(page) === "sp";
const zero = (): MatchRecord => ({ wins: 0, losses: 0, draws: 0 });
const plates = (page: Page) => page.locator(".plate-record");
/** 終局画面の成績表の「通算」の行（先手・後手の列の順） */
const recordRow = (page: Page) =>
  page.locator("#result-detail .score tbody tr").filter({ has: page.locator("th", { hasText: "通算" }) }).locator("td");

/** 置ける手（選んでいる駒で返せるマスの先頭）を 1 手打つ。マウスは 1 回、タッチは 2 回 */
async function playAny(page: Page) {
  const cell = page.locator(".cell.can-take").first();
  const [r, c] = [Number(await cell.getAttribute("data-r")), Number(await cell.getAttribute("data-c"))];
  if (isTouch(page)) {
    await cellAt(page, r, c).tap();
    await cellAt(page, r, c).tap();
  } else {
    await cellAt(page, r, c).click();
  }
}

/** 置ける手を打ち続けて終局させ、終局画面の見出しを返す */
async function finish(page: Page): Promise<string> {
  for (let n = 0; n < 40; n++) {
    if (await waitHumanTurnOrEnd(page)) break;
    const before = await page.locator("#log .log-item").count();
    await playAny(page);
    await expect(page.locator("#log .log-item")).not.toHaveCount(before);
  }
  await expect(page.locator("#result")).toHaveAttribute("open", "");
  return (await page.locator("#result-winner").textContent()) ?? "";
}

/** CPU 対戦の終局画面の見出しを、人間から見た通算に足す */
function addCpu(r: MatchRecord, headline: string): MatchRecord {
  if (headline === "あなたの勝ち") return { ...r, wins: r.wins + 1 };
  if (headline === "CPU の勝ち") return { ...r, losses: r.losses + 1 };
  expect(headline).toBe("引き分け");
  return { ...r, draws: r.draws + 1 };
}

/** 2 人対戦の終局画面の見出しを、先手から見た通算に足す */
function addPvp(r: MatchRecord, headline: string): MatchRecord {
  if (headline === "先手の勝ち") return { ...r, wins: r.wins + 1 };
  if (headline === "後手の勝ち") return { ...r, losses: r.losses + 1 };
  expect(headline).toBe("引き分け");
  return { ...r, draws: r.draws + 1 };
}

/** 先手・後手の名札の通算（人間が先手の CPU 対戦・2 人対戦は、先手から見た通算 r） */
async function expectPlates(page: Page, r: MatchRecord) {
  await expect(page.locator("#player-0 .plate-record")).toHaveText(recordText(r));
  await expect(page.locator("#player-1 .plate-record")).toHaveText(recordText(flipRecord(r)));
}

async function expectRow(page: Page, r: MatchRecord) {
  await expect(recordRow(page)).toHaveText([recordText(r), recordText(flipRecord(r))]);
}

/** 終局画面から再戦（同じ設定でもう一局） */
async function rematch(page: Page) {
  await page.locator("#result-rematch").click();
  await expect(page.locator("#result")).not.toHaveAttribute("open", "");
}

test("CPU 対戦: 同じ強さの 2 局目から終局画面と名札に通算。強さごとに分け、途中でやめた対局は数えず、再読み込みでも残る", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await seedPage(page, 5);
  await page.goto(`/?${encodeRules(SHORT)}`);
  await startGame(page, { level: "normal" });

  // 1 局目: 数えるが、まだ出さない
  let normal = addCpu(zero(), await finish(page));
  await expect(recordRow(page)).toHaveCount(0);
  await expect(plates(page)).toHaveCount(0);

  // 2 局目: 名札に 1 局目までの通算、終局画面に 2 局目までの通算
  await rematch(page);
  await expectPlates(page, normal);
  await expect(page.locator("#player-0 .plate-record")).toHaveAttribute("title", `CPU ノーマルとの対局の通算 ${recordText(normal)}`);
  normal = addCpu(normal, await finish(page));
  await expectRow(page, normal);
  await expectPlates(page, normal);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-record-cpu-result.png` });
  await page.locator("#result-view").click();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-record-cpu-plate.png` });
  if (isTouch(page)) await noHorizontalScroll(page, 375);

  // ハードは別に数える（まだ 0 局なので出ない）。途中でメニューに戻って新しい対局にした分は数えない
  await page.locator("#btn-menu").click();
  await startGame(page, { level: "hard" });
  await expect(plates(page)).toHaveCount(0);
  await waitHumanTurnOrEnd(page);
  await playAny(page);
  await page.locator("#btn-menu").click();
  await startGame(page, { level: "normal" });
  await expectPlates(page, normal);

  // 再読み込みしても残る。ハードは数えていない
  await page.reload();
  await startGame(page, { level: "normal" });
  await expectPlates(page, normal);
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), RECORD_KEY);
  expect(saved.cpu.normal).toEqual(normal);
  expect(saved.cpu.hard).toEqual(zero());
  expect(saved.pvp).toEqual(zero());
  expect(errors).toEqual([]);
});

test("2 人対戦: 席ごとに数え、2 局目から先手・後手の名札と終局画面に出す", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await seedPage(page, 1);
  await page.goto(`/?${encodeRules(SHORT)}`);
  await startGame(page, { mode: "pvp" });
  let pvp = addPvp(zero(), await finish(page));
  await expect(recordRow(page)).toHaveCount(0);
  await rematch(page);
  await expectPlates(page, pvp);
  pvp = addPvp(pvp, await finish(page));
  await expectRow(page, pvp);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-record-pvp-result.png` });

  // 先手の勝ち（両者が返す駒の最も多い手）。席の向き: 先手の名札に先手の勝ち、後手の名札に後手の負け
  await page.goto(`/?${encodeRules(PVP_BLACK)}`);
  await startGame(page, { mode: "pvp" });
  await expectPlates(page, pvp);
  let s = createGame(PVP_BLACK);
  while (!s.result) {
    await page.waitForSelector(".board.acting", { timeout: 30_000 });
    const ch = greedy(s);
    await play(page, ch.r, ch.c, ch.kind, isTouch(page));
    s = playMove(s, ch.r, ch.c, ch.kind);
  }
  expect(await finish(page)).toBe("先手の勝ち");
  pvp = addPvp(pvp, "先手の勝ち");
  await expectPlates(page, pvp);
  await expectRow(page, pvp);
  // 設定メニューの一覧（先手と後手の勝ち数・引き分け）
  await page.locator("#result-menu").click();
  await openSettings(page);
  const p = pvp;
  await expect(page.locator("#record-sum li")).toHaveText([`2人対戦 先手${p.wins}勝 後手${p.losses}勝${p.draws > 0 ? ` ${p.draws}分` : ""}`]);
  expect(errors).toEqual([]);
});

test("待ったを使った対局・引き分けも数える。遊び方ではない CPU 対戦だけ", async ({ page }) => {
  await seedPage(page, 1);
  await page.goto(`/?${encodeRules(DRAW)}`);
  // 引き分け（result.spec の DRAW と同じ手: 返す駒が最も多い手と 2 手読みの CPU）
  await startGame(page, { level: "normal" });
  const m = greedy(createGame(DRAW));
  await play(page, m.r, m.c, m.kind, isTouch(page));
  expect(await finish(page)).toBe("引き分け");
  // 待った: イージーで 1 手打って CPU が応じた後に戻し、打ち直して終局まで
  await page.goto(`/?${encodeRules(SHORT)}`);
  await startGame(page, { level: "easy" });
  await waitHumanTurnOrEnd(page);
  await playAny(page);
  await expect(page.locator("#btn-undo")).toBeEnabled({ timeout: 15_000 });
  await page.locator("#btn-undo").click();
  const easy = addCpu(zero(), await finish(page));
  await expect(page.locator("#result-stats")).toContainText("待った");
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), RECORD_KEY);
  expect(saved.cpu.normal).toEqual({ wins: 0, losses: 0, draws: 1 });
  expect(saved.cpu.easy).toEqual(easy);
});

test("設定メニューの「通算を消す」は画面内で確かめてから消す。やめれば残る", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // 保存済みの通算（ノーマル 3勝2敗・ハード 1勝0敗1分・2 人対戦）
  await page.addInitScript((k) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      const r = (wins: number, losses: number, draws: number) => ({ wins, losses, draws });
      localStorage.setItem(k, JSON.stringify({ cpu: { easy: r(0, 0, 0), normal: r(3, 2, 0), hard: r(1, 0, 1) }, pvp: r(2, 1, 0) }));
    }
  }, RECORD_KEY);
  await page.goto("/");
  await startGame(page, { level: "normal" });
  await expectPlates(page, { wins: 3, losses: 2, draws: 0 });
  await page.locator("#btn-menu").click();
  await openSettings(page);
  const sum = page.locator("#record-sum li");
  await expect(sum).toHaveText(["ノーマル 3勝2敗", "ハード 1勝0敗1分", "2人対戦 先手2勝 後手1勝"]);
  await page.locator("#record-clear").scrollIntoViewIfNeeded();

  // 押すと確認に替わる（ブラウザのダイアログは出さない）。やめると残る
  page.on("dialog", (d) => errors.push(`dialog: ${d.message()}`));
  await page.locator("#record-clear").click();
  await expect(page.locator("#record-confirm")).toBeVisible();
  await expect(page.locator("#record-clear")).toBeHidden();
  await expect(page.locator("#record-keep")).toBeFocused();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-record-confirm.png` });
  if (isTouch(page)) await noHorizontalScroll(page, 375);
  await page.locator("#record-keep").click();
  await expect(page.locator("#record-confirm")).toBeHidden();
  await expect(sum).toHaveCount(3);

  // 消す: 設定の「保存」を待たずに消える。消す鍵は押せなくなる
  await page.locator("#record-clear").click();
  await page.locator("#record-erase").click();
  await expect(sum).toHaveText(["なし"]);
  await expect(page.locator("#record-status")).toHaveText("消しました");
  await expect(page.locator("#record-clear")).toBeDisabled();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-record-cleared.png` });
  await page.locator("#setup-cancel").click();
  await startGame(page, { level: "normal" });
  await expect(plates(page)).toHaveCount(0);
  await page.reload();
  await openSettings(page);
  await expect(sum).toHaveText(["なし"]);
  expect(errors).toEqual([]);
});

test("壊れた保存データ・localStorage が使えない状態でも対局でき、数え直す", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "PC 幅のみ（新しいコンテキストを作る）");
  // 壊れた保存: 0 から数え、終えた対局で正しい形に上書きする
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((k) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(k, "{broken");
    }
  }, RECORD_KEY);
  await seedPage(page, 2);
  await page.goto(`/?${encodeRules(SHORT)}`);
  await startGame(page, { level: "normal" });
  await expect(plates(page)).toHaveCount(0);
  const r = addCpu(zero(), await finish(page));
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), RECORD_KEY);
  expect(saved.cpu.normal).toEqual(r);
  await ctx.close();

  // localStorage が使えない: 例外で止まらず、この画面の間は数える
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  await page2.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await seedPage(page2, 2);
  await page2.goto(`/?${encodeRules(SHORT)}`);
  await startGame(page2, { level: "normal" });
  const r2 = addCpu(zero(), await finish(page2));
  await rematch(page2);
  await expectPlates(page2, r2);
  await ctx2.close();
  expect(errors).toEqual([]);
});
