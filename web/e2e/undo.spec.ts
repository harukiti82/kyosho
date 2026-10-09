// 待った（CPU 対戦のイージーだけ）をヘッドレスブラウザで確かめる。
// ページの Math.random を種付きにし、Node 側で同じ種のイージーの CPU を動かす「鏡の対局」と盤を照らし合わせる
// （待ったの後の CPU の応手も、続きの乱数で決まるので再現できる）。

import { expect, test, type Page } from "@playwright/test";
import { chooseMove } from "../src/engine/cpu";
import { createGame, legalCells, playableKinds, playMove, viewFor, type GameState } from "../src/engine/game";
import { presetById } from "../src/engine/rules";
import { clockText } from "../src/ui/clock";
import { UNDO_LIMIT } from "../src/ui/undo";
import { noHorizontalScroll, openSettings, play, rng, saveSettings, seedPage, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const STD = presetById("std").rules;
const isMobile = (name: string) => name === "mobile";

/** 盤の石（持ち主と駒種）。予測のゴースト石は除く */
const boardOf = (page: Page) =>
  page.locator("#board .cell").evaluateAll((cs) =>
    cs.map((c) => {
      const s = c.querySelector(".stone:not(.ghost)");
      if (!s) return "";
      const owner = s.classList.contains("p0") ? 0 : 1;
      const kind = [...s.classList].find((k) => k.startsWith("k-"))!.slice(2);
      return `${owner}:${kind}`;
    }),
  );
const boardSig = (s: GameState) => s.board.flat().map((x) => (x ? `${x.owner}:${x.kind}` : ""));

/** 体力・持ち駒の数・手数（画面の表示） */
const statusOf = (page: Page) =>
  page.evaluate(() => ({
    hp: [...document.querySelectorAll("#player-0 .hp-num, #player-1 .hp-num")].map((e) => e.textContent),
    hand: [...document.querySelectorAll("#hand-buttons .piece-count")].map((e) => e.textContent),
    ply: document.querySelector("#ply")!.textContent,
    log: document.querySelectorAll("#log .log-item").length,
  }));

/** 人間の手（置ける手の先頭）。打った後の局面 */
function humanMove(s: GameState) {
  const kind = playableKinds(s)[0];
  const [r, c] = legalCells(s, kind)[0];
  return { r, c, kind, next: playMove(s, r, c, kind) };
}

/** 鏡の対局: CPU（イージー）の手番の間、同じ乱数で打つ */
function cpuReplies(s: GameState, rand: () => number): GameState {
  while (!s.result && s.turn === 1) {
    const ch = chooseMove(viewFor(s, 1), "easy", rand)!;
    s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
  }
  return s;
}

const undoBtn = (page: Page) => page.locator("#btn-undo");

test("イージー: 1 手打って CPU が応じた後に待った → 手の前に戻る。3 回で押せなくなる（鏡の対局と一致）", async ({ page }, info) => {
  const touch = isMobile(info.project.name);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const SEED = 21;
  await seedPage(page, SEED);
  await page.goto("/");
  await startGame(page, { level: "easy" });
  const rand = rng(SEED);
  let s = createGame(STD);

  // 1 手も打っていないときは押せない
  await expect(undoBtn(page)).toBeVisible();
  await expect(undoBtn(page)).toBeDisabled();
  await expect(undoBtn(page)).toHaveAccessibleName(`待った 残り${UNDO_LIMIT}回`);

  for (let used = 0; used < UNDO_LIMIT; used++) {
    // 残す手（1 手と CPU の応手）で局面を進めてから、次の手を戻す
    const keep = humanMove(s);
    await play(page, keep.r, keep.c, keep.kind, touch);
    // CPU の手番の間は押せない
    await expect(undoBtn(page)).toBeDisabled();
    s = cpuReplies(keep.next, rand);
    expect(await waitHumanTurnOrEnd(page)).toBe(false);
    expect(await boardOf(page)).toEqual(boardSig(s));

    // 打つ前の画面を覚えて、戻す手を打つ
    const sBefore = s;
    const before = { board: await boardOf(page), status: await statusOf(page) };
    const m = humanMove(s);
    await play(page, m.r, m.c, m.kind, touch);
    s = cpuReplies(m.next, rand);
    expect(await waitHumanTurnOrEnd(page)).toBe(false);
    expect(await boardOf(page)).toEqual(boardSig(s));
    if (used === 0) await page.screenshot({ path: `${SHOT}/${touch ? "sp" : "pc"}-undo-before.png` });

    await expect(undoBtn(page)).toBeEnabled();
    await undoBtn(page).click();
    // 盤・体力・持ち駒・手数・棋譜が手の前に戻り、自分の手番
    expect(await boardOf(page)).toEqual(before.board);
    expect(await statusOf(page)).toEqual(before.status);
    await expect(page.locator(".board.acting")).toHaveCount(1);
    await expect(page.locator("#status")).toHaveText("あなたの番");
    await expect(page.locator("#btn-undo .undo-left")).toHaveText(String(UNDO_LIMIT - 1 - used));
    await expect(undoBtn(page)).toHaveAccessibleName(`待った 残り${UNDO_LIMIT - 1 - used}回`);
    if (used === 0) {
      await page.screenshot({ path: `${SHOT}/${touch ? "sp" : "pc"}-undo-after.png` });
      if (touch) await noHorizontalScroll(page, 375);
    }
    // 鏡の対局も手の前へ（この後の CPU は続きの乱数で応じる）
    s = sBefore;
  }

  // 使い切ったら押せない。打っても押せないまま
  await expect(undoBtn(page)).toBeDisabled();
  const m = humanMove(s);
  await play(page, m.r, m.c, m.kind, touch);
  s = cpuReplies(m.next, rand);
  await waitHumanTurnOrEnd(page);
  expect(await boardOf(page)).toEqual(boardSig(s));
  await expect(undoBtn(page)).toBeDisabled();
  await expect(page.locator("#btn-undo .undo-left")).toHaveText("0");
  expect(errors).toEqual([]);
});

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("ノーマル・ハード・2 人対戦・遊び方のステップでは待ったを出さない", async ({ page }) => {
    await seedPage(page, 3);
    await page.goto("/");
    for (const level of ["normal", "hard"] as const) {
      await startGame(page, { level });
      await expect(page.locator(".board.acting")).toHaveCount(1);
      await expect(undoBtn(page)).toHaveCount(0);
      await page.locator("#btn-menu").click();
    }
    await startGame(page, { mode: "pvp" });
    await expect(page.locator(".board.acting")).toHaveCount(1);
    await expect(undoBtn(page)).toHaveCount(0);
    await page.locator("#btn-menu").click();
    await page.locator("#menu-learn").click();
    await expect(page.locator("#coach")).toBeVisible();
    await expect(undoBtn(page)).toHaveCount(0);
  });

  test("CPU が先手: CPU の初手は戻さない", async ({ page }) => {
    const SEED = 8;
    await seedPage(page, SEED);
    await page.goto("/");
    await startGame(page, { level: "easy", side: 1 });
    const rand = rng(SEED);
    // CPU（先手）の初手
    let s = createGame(STD);
    const ch = chooseMove(viewFor(s, 0), "easy", rand)!;
    s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
    await waitHumanTurnOrEnd(page);
    await expect(page.locator("#ply")).toHaveText("1 手");
    await expect(undoBtn(page)).toBeDisabled();
    const before = await boardOf(page);
    expect(before).toEqual(boardSig(s));
    // 人間は後手（1）。置ける手の先頭を打つ
    const kind = playableKinds(s)[0];
    const [r, c] = legalCells(s, kind)[0];
    await play(page, r, c, kind, false);
    await expect(page.locator("#ply")).toHaveText("3 手", { timeout: 10_000 });
    await waitHumanTurnOrEnd(page);
    await undoBtn(page).click();
    await expect(page.locator("#ply")).toHaveText("1 手");
    expect(await boardOf(page)).toEqual(before);
    // CPU の初手の前には戻れない
    await expect(undoBtn(page)).toBeDisabled();
    await expect(page.locator("#btn-undo .undo-left")).toHaveText(String(UNDO_LIMIT - 1));
  });

  test("王を決めた手を戻すと、王は未定・期限の数え方も手の前に戻る", async ({ page }) => {
    await seedPage(page, 4);
    await page.goto("/");
    await startGame(page, { level: "easy" });
    const deadline = STD.king.deadline;
    await expect(page.locator("#king-toggle")).toContainText(`あと${deadline}手`);
    await expect(page.locator("#player-0 .king-tag")).toContainText("未定");
    const s = createGame(STD);
    const m = humanMove(s);
    await page.locator("#king-toggle").click();
    await play(page, m.r, m.c, m.kind, false);
    await waitHumanTurnOrEnd(page);
    await expect(page.locator("#player-0 .king-tag")).not.toContainText("未定");
    await expect(page.locator("#king-toggle")).toHaveCount(0);
    await undoBtn(page).click();
    await expect(page.locator("#player-0 .king-tag")).toContainText("未定");
    await expect(page.locator("#king-toggle")).toContainText(`あと${deadline}手`);
    await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "false");
    // 王の印は盤から消える
    await expect(page.locator("#board .stone.p0.king")).toHaveCount(0);
  });

  test("制限時間あり: 待った後は自分の手番の時計を最初から数え直す", async ({ page }) => {
    await seedPage(page, 6);
    await page.goto("/");
    await openSettings(page);
    await page.locator('label:has(> input[name=timeCpu][value="20"])').click();
    await saveSettings(page);
    await startGame(page, { level: "easy" });
    const num = page.locator("#turn-clock .clock-num");
    await expect(num).toHaveText(clockText(20_000));
    const m = humanMove(createGame(STD));
    await page.waitForTimeout(2_200);
    await expect(num).not.toHaveText(clockText(20_000));
    await play(page, m.r, m.c, m.kind, false);
    await waitHumanTurnOrEnd(page);
    await page.waitForTimeout(2_200);
    await expect(num).not.toHaveText(clockText(20_000));
    await undoBtn(page).click();
    await expect(num).toHaveText(clockText(20_000));
    await expect(page.locator("#turn-clock")).not.toHaveClass(/paused/);
  });

  test("決着の一手の後（終局後）は待ったを出さない。成績に待ったの回数", async ({ page }) => {
    await seedPage(page, 2);
    // 体力 5 の v1.0（数手で決着する）
    await page.goto("/?hp1=5&hp2=5");
    await startGame(page, { level: "easy" });
    // 1 回使ってから終局まで打つ（最初の手で決着したら使わない）
    await waitHumanTurnOrEnd(page);
    let used = 0;
    for (;;) {
      // 取るルールは空きマスならどこでも置ける。取れるマスがなければ置けるマスに置く
      const take = page.locator(".cell.can-take");
      await ((await take.count()) > 0 ? take : page.locator(".cell.open")).first().click();
      if (await waitHumanTurnOrEnd(page)) break;
      if (used === 0) {
        await undoBtn(page).click();
        used = 1;
      }
    }
    await expect(page.locator("#result-stats")).toContainText(`待った${used} 回`);
    await page.locator("#result-view").click();
    await expect(undoBtn(page)).toHaveCount(0);
  });
});
