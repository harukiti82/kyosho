// ヘッドレスブラウザで実際に対局して画面遷移と表示を確かめる。
// スクリーンショットは web/screenshots/ に保存する。

import { expect, test, type Page } from "@playwright/test";
import { availableKinds, createGame, movesFor, playMove, type GameState } from "../src/engine/game";
import type { PieceKind } from "../src/engine/rules";

const SHOT = "screenshots";

async function noHorizontalScroll(page: Page, width: number) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

async function startGame(page: Page, opts: { mode?: "cpu" | "pvp"; side?: 0 | 1; kaku?: boolean } = {}) {
  await expect(page.locator("#setup")).toBeVisible();
  await page.locator(`input[name=mode][value=${opts.mode ?? "cpu"}]`).check();
  if ((opts.mode ?? "cpu") === "cpu") await page.locator(`input[name=side][value="${opts.side ?? 0}"]`).check();
  if (opts.kaku) await page.locator("input[name=kaku]").check();
  await page.locator("#setup-start").click();
  await expect(page.locator("#setup")).toBeHidden();
}

/** 人間の手番（持ち駒が押せる）か終局画面のどちらかになるまで待つ。終局なら true */
async function waitHumanTurnOrEnd(page: Page): Promise<boolean> {
  await page.waitForFunction(
    () => !!document.querySelector("#result[open]") || !!document.querySelector("#hand-buttons .piece-btn:not([disabled])"),
    undefined,
    { timeout: 30_000 },
  );
  return page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open);
}

const boardSnapshot = (page: Page) =>
  page.locator(".cell").evaluateAll((cells) => cells.map((c) => c.getAttribute("aria-label")).join("|"));
const stoneCount = (page: Page) => page.locator(".board .stone:not(.ghost)").count();

/** 持ち駒を選ぶ（選択中のボタンをもう一度押すと解除されるので、未選択のときだけ押す） */
async function selectPiece(page: Page, kind: PieceKind | null, touch = false) {
  const btn = kind
    ? page.locator(`#hand-buttons .piece-btn[data-kind=${kind}]`)
    : page.locator("#hand-buttons .piece-btn:not([disabled])").first();
  if ((await btn.getAttribute("aria-pressed")) === "true") return;
  if (touch) await btn.tap();
  else await btn.click();
}

/**
 * 持ち駒を選び、先頭の合法マスに置く。touch なら 1 回目のタップで予測、2 回目で確定。
 * check のときは予測を確かめたところで止め、そのマスを返す
 */
async function humanMove(page: Page, kind: PieceKind | null, touch: boolean, check = false) {
  await selectPiece(page, kind, touch);
  const cell = page.locator(".cell.legal").first();
  const before = await stoneCount(page);
  if (touch) {
    await cell.tap();
    // 1 回目のタップでは置かれず、予測が出る
    await expect(page.locator("#preview")).toContainText("攻撃");
    await expect(page.locator("#preview")).toContainText("もう一度タップ");
    expect(await stoneCount(page)).toBe(before);
    if (check) return cell;
    await cell.tap();
  } else {
    await cell.hover();
    await expect(page.locator("#preview")).toContainText("攻撃");
    await expect(page.locator("#preview")).toContainText("回復");
    if (check) return cell;
    await cell.click();
  }
  return null;
}

/** 終局後: 盤面を見る → マスをクリックしても何も変わらない */
async function checkBoardFrozen(page: Page) {
  await page.locator("#result-view").click();
  await expect(page.locator("#result")).toBeHidden();
  const snap = await boardSnapshot(page);
  const status = await page.locator("#status").textContent();
  for (const i of [0, 19, 63]) await page.locator(".cell").nth(i).click({ force: true });
  expect(await boardSnapshot(page)).toBe(snap);
  await expect(page.locator("#status")).toHaveText(status!);
  await expect(page.locator("#result")).toBeHidden();
}

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("CPU 対戦（先手）: 駒を選んで置き、予測を見て、終局まで進む", async ({ page }) => {
    await page.goto("/");
    await page.screenshot({ path: `${SHOT}/pc-setup.png` });
    await startGame(page);
    await expect(page.locator("#player-0")).toContainText("65");
    await expect(page.locator("#player-1")).toContainText("66");

    // 1 手目: 飛を選ぶと合法マスが強調され、ホバーで予測が出る
    expect(await page.locator(".cell.legal").count()).toBe(4);
    await selectPiece(page, "hi");
    await expect(page.locator(".board.selecting")).toHaveCount(1);
    const cell = (await humanMove(page, "hi", false, true))!;
    await expect(page.locator(".cell.will-flip")).toHaveCount(1);
    await page.screenshot({ path: `${SHOT}/pc-preview.png` });
    await cell.click();
    await expect(page.locator("#log .log-item")).toHaveCount(1);

    let moves = 1;
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      // 2 手目も飛。以降は飛が尽きて押せないことを確かめる
      if (moves === 1) await humanMove(page, "hi", false);
      else {
        if (moves === 2) {
          await expect(page.locator("#hand-buttons .piece-btn[data-kind=hi]")).toBeDisabled();
          await expect(page.locator("#hand-buttons .piece-btn[data-kind=hi]")).toContainText("×0");
          await page.screenshot({ path: `${SHOT}/pc-midgame.png` });
        }
        await humanMove(page, null, false);
      }
      moves++;
    }
    await expect(page.locator("#result-winner")).toHaveText(/あなたの勝ち|CPU の勝ち|引き分け/);
    await expect(page.locator("#result-reason")).toHaveText(/体力 0|体力判定|石数|引き分け/);
    await page.screenshot({ path: `${SHOT}/pc-result.png` });
    await checkBoardFrozen(page);

    // 再戦で初期状態に戻る
    await page.locator("#btn-rematch").click();
    await expect(page.locator("#player-0 .hp-num")).toHaveText("65");
    await expect(page.locator("#log .log-item")).toHaveCount(0);
  });

  test("2 人対戦: パス通知を含めて終局まで進む", async ({ page }) => {
    const seq = findGameWithPass();
    await page.goto("/");
    await startGame(page, { mode: "pvp" });
    await expect(page.locator("#status")).toContainText("先手の番");
    let sawPass = false;
    for (const [i, m] of seq.moves.entries()) {
      await selectPiece(page, m.kind);
      await page.locator(`.cell[data-r="${m.r}"][data-c="${m.c}"]`).click();
      if (seq.passAfter.includes(i)) {
        await expect(page.locator("#toast")).toBeVisible();
        await expect(page.locator("#toast")).toContainText("パス");
        await expect(page.locator("#log .log-item.pass").first()).toContainText("パス");
        if (!sawPass) await page.screenshot({ path: `${SHOT}/pc-pass.png` });
        sawPass = true;
      }
    }
    expect(sawPass).toBe(true);
    await expect(page.locator("#result")).toBeVisible();
    await expect(page.locator("#result-winner")).toHaveText(seq.winnerText);
    await checkBoardFrozen(page);
  });

  test("角あり・CPU 対戦（後手）: 角が使え、終局まで進む", async ({ page }) => {
    await page.goto("/");
    await startGame(page, { side: 1, kaku: true });
    await expect(page.locator("#player-1 .hp-max")).toHaveText("/ 65");
    // CPU（先手）が先に打つ
    await expect(page.locator("#log .log-item")).toHaveCount(1, { timeout: 5000 });
    let first = true;
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      if (first) {
        await expect(page.locator("#hand-buttons .piece-btn[data-kind=kaku]")).toContainText("×2");
        await expect(page.locator("#hand-buttons .piece-btn[data-kind=fu]")).toContainText("×12");
        await humanMove(page, "kaku", false);
        await expect(page.locator("#log .log-item").first()).toContainText("角1");
        first = false;
      } else {
        await humanMove(page, null, false);
      }
    }
    await expect(page.locator("#result-winner")).toBeVisible();
    await page.screenshot({ path: `${SHOT}/pc-kaku-result.png` });
  });
});

test.describe("スマホ幅 375px", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "スマホ幅のみ"));

  test("CPU 対戦をタップ操作で終局まで進め、横スクロールが出ない", async ({ page }) => {
    await page.goto("/");
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-setup.png` });
    await startGame(page);
    await noHorizontalScroll(page, 375);

    const cell = (await humanMove(page, "kin", true, true))!;
    await page.screenshot({ path: `${SHOT}/sp-preview.png`, fullPage: true });
    await noHorizontalScroll(page, 375);
    await cell.tap();
    await expect(page.locator("#log .log-item")).toHaveCount(1);

    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      await humanMove(page, null, true);
      await noHorizontalScroll(page, 375);
    }
    await expect(page.locator("#toast")).toBeHidden();
    await page.screenshot({ path: `${SHOT}/sp-result.png` });
    await noHorizontalScroll(page, 375);
    await page.locator("#result-view").tap();
    await page.screenshot({ path: `${SHOT}/sp-final-board.png`, fullPage: true });

    await page.locator("#btn-rules").tap();
    await expect(page.locator("#rules")).toContainText("回復の早見表");
    // 冒頭から読める（末尾のボタンにフォーカスしてスクロールしない）
    expect(await page.locator("#rules").evaluate((d) => d.scrollTop)).toBe(0);
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-rules.png` });
  });
});

// ---- 2 人対戦の手順探索 ----

/** 種付き乱数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 途中でパスが起きて終局する手順をエンジンで探す（UI で同じ手順をクリックして再生する） */
function findGameWithPass() {
  for (let seed = 1; seed < 20000; seed++) {
    const rand = rng(seed);
    let s: GameState = createGame({ kaku: false });
    const moves: { r: number; c: number; kind: PieceKind }[] = [];
    const passAfter: number[] = [];
    while (!s.result) {
      const ms = movesFor(s, s.turn);
      const m = ms[Math.floor(rand() * ms.length)];
      const kinds = availableKinds(s.hands[s.turn]);
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const before = s.history.length;
      s = playMove(s, m.r, m.c, kind);
      moves.push({ r: m.r, c: m.c, kind });
      if (s.history.slice(before).some((e) => e.type === "pass")) passAfter.push(moves.length - 1);
    }
    if (passAfter.length > 0) {
      const w = s.result.winner;
      return { moves, passAfter, winnerText: w === null ? "引き分け" : `${w === 0 ? "先手" : "後手"}の勝ち` };
    }
  }
  throw new Error("パスの起きる手順が見つからない");
}
