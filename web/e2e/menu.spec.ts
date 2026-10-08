// メニュー: 起動時にメニューが出て、設定画面を経ずに標準ルールで始まること（CPU 対戦の手番は抽選）・CPU の強さ・マルチ・設定メニューの保存と反映・
// 保存が読めないときは標準・対局中にメニューへ出て戻れること。スクリーンショットは web/screenshots/ に保存する。

import { expect, test, type Page } from "@playwright/test";
import { chooseMove, CPU_LEVEL_NAME, type CpuLevel } from "../src/engine/cpu";
import { createGame, viewFor } from "../src/engine/game";
import { defaultRules, PIECES, presetById, type RuleSet } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { ruleLines, sentenceText } from "../src/ui/ruletext";
import { cellAt, draws, noHorizontalScroll, openSettings, rng, saveSettings, seedPage, startGame, stubDraws } from "./helpers";

const SHOT = "screenshots";
const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");

async function ruleCardIs(page: Page, r: RuleSet) {
  await expect(page.locator("#rules4 li")).toHaveText(ruleLines(r).map(sentenceText));
}

test("開くとメニュー。CPU対戦 → 強さを選ぶと、設定画面を経ずに標準ルールで始まる", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // 手番の抽選（既定はランダム）を先手にする
  await stubDraws(page, [0.1]);
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#game")).toBeHidden();
  await expect(page.locator("#menu-main .menu-btn:visible")).toHaveText(["CPU対戦", "マルチ", "遊び方 おすすめ", "設定"]);
  await expect(page.locator("#menu-rule-name")).toHaveText("標準");
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-menu.png` });

  await page.locator("#menu-cpu").click();
  // 強さの名前の右に、その強さでのあなたの 1 手の制限時間
  await expect(page.locator("#menu-levels [data-level]")).toHaveText(["イージー 制限なし", "ノーマル 45秒", "ハード 20秒"]);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-menu-levels.png` });
  // 戻る・Esc で 1 つ前へ
  await page.locator("#menu-levels .menu-back").click();
  await expect(page.locator("#menu-main")).toBeVisible();
  await page.locator("#menu-cpu").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#menu-main")).toBeVisible();

  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=hard]").click();
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#game")).toBeVisible();
  await ruleCardIs(page, defaultRules());
  await expect(page.locator("#rules4-name")).toHaveText("ルール 標準");
  await expect(page.locator("#toast")).toHaveText("抽選で先手になりました");
  expect(await draws(page)).toBe(1);
  await expect(page.locator("#player-1")).toContainText("CPU");
  await expect(page.locator(".board.acting")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-menu-hard-game.png` });
  expect(errors).toEqual([]);
});

test("設定を保存していなければ CPU 対戦の手番は対局ごとに抽選（後手なら CPU から打つ）", async ({ page }) => {
  await stubDraws(page, [0.9, 0.1]);
  await seedPage(page, 1);
  await page.goto("/");
  await openSettings(page);
  await expect(page.locator("input[name=side][value=random]")).toBeChecked();
  await page.locator("#setup-cancel").click();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=normal]").click();
  await expect(page.locator("#toast")).toHaveText("抽選で後手になりました");
  await expect(page.locator("#player-1")).toContainText("あなた");
  await expect(page.locator("#log .log-item.move")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".board.acting")).toBeVisible();
  // メニューから新しい対局を始めると引き直す
  await page.locator("#btn-menu").click();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=easy]").click();
  await expect(page.locator("#toast")).toHaveText("抽選で先手になりました");
  await expect(page.locator("#player-0")).toContainText("あなた");
  await expect(page.locator("#log .log-item.move")).toHaveCount(0);
  expect(await draws(page)).toBe(2);
});

test("強さごとに CPU の手が違う（種付き乱数で、エンジンの chooseMove と同じ手を打つ）", async ({ browser }) => {
  // 種 8 では、標準の初手がイージー 金・ノーマル 金・ハード 横 と分かれる（人間が後手で CPU が先に打つ）。
  // 回復が低い方−1 だと初手はどの手もダメージ 2・回復 0 の同点で、イージーとノーマルは同じ手になる
  const seed = 8;
  const expected = (["easy", "normal", "hard"] as CpuLevel[]).map((level) => ({
    level,
    move: chooseMove(viewFor(createGame(defaultRules()), 0), level, rng(seed))!,
  }));
  expect(new Set(expected.map((e) => e.move.kind)).size).toBeGreaterThanOrEqual(2);
  for (const { level, move } of expected) {
    const page = await browser.newPage();
    await seedPage(page, seed);
    await page.goto("/");
    await startGame(page, { side: 1, level });
    const cell = cellAt(page, move.r, move.c);
    await expect(cell).toHaveClass(/\blast\b/, { timeout: 10_000 });
    await expect(cell.locator(".stone")).toHaveClass(new RegExp(`\\bk-${move.kind}\\b`));
    await expect(cell.locator(".stone-name")).toHaveText(PIECES[move.kind].name);
    await page.close();
  }
});

test("マルチ → この端末で 2 人。オンラインの入口は /api がない公開先では出ない", async ({ page }) => {
  await page.goto("/");
  await page.locator("#menu-multi").click();
  await expect(page.locator("#menu-pvp")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-menu-multi.png` });
  await page.locator("#menu-pvp").click();
  await expect(page.locator("#game")).toBeVisible();
  await ruleCardIs(page, defaultRules());
  await expect(page.locator("#player-0")).toContainText("先手");
  await expect(page.locator("#player-1")).toContainText("後手");
  await expect(page.locator("#player-0")).not.toContainText("あなた");
});

test("設定で変えたルールは次の対局と再読み込み後に使われる。変えなければ・やめたら標準のまま", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  // やめる: 保存しない
  await openSettings(page);
  await page.locator(".preset[data-preset=king]").click();
  await page.locator("#setup-cancel").click();
  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#menu-rule-name")).toHaveText("標準");
  await openSettings(page);
  await expect(page.locator(".preset[aria-pressed=true]")).toHaveAttribute("data-preset", "std");

  // 保存: メニューのルール名が変わり、次の対局がそのルール
  await page.locator(".preset[data-preset=king]").click();
  await saveSettings(page);
  await expect(page.locator("#menu-rule-name")).toHaveText("隠し王");
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-menu-saved.png` });
  await startGame(page);
  await ruleCardIs(page, presetById("king").rules);

  // クエリなしで開き直しても、保存したルール
  await page.goto("/");
  await expect(page.locator("#menu-rule-name")).toHaveText("隠し王");
  await startGame(page, { mode: "pvp" });
  await ruleCardIs(page, presetById("king").rules);

  // 共有された URL のルールは保存より優先（保存は書き換えない）
  await page.goto(`/?${encodeRules(presetById("v10").rules)}`);
  await expect(page.locator("#menu-note")).toHaveText("URL の設定で遊びます");
  await expect(page.locator("#menu-rule-name")).toHaveText("v1.0（取る）");
  await page.goto("/");
  await expect(page.locator("#menu-rule-name")).toHaveText("隠し王");
  expect(errors).toEqual([]);
});

test("保存した設定が壊れている・ストレージが使えないときは標準で始まる", async ({ browser }) => {
  for (const broken of ["{broken", JSON.stringify({ rules: "take=zzz&hp1=-3", side: "x", host: 1 }), "throw"]) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript((v) => {
      if (v === "throw") {
        Storage.prototype.getItem = () => {
          throw new Error("denied");
        };
        Storage.prototype.setItem = () => {
          throw new Error("denied");
        };
      } else {
        window.localStorage.setItem("kyosho:settings", v);
      }
    }, broken);
    await page.goto("/");
    await expect(page.locator("#menu-rule-name")).toHaveText("標準");
    await openSettings(page);
    await expect(page.locator("input[name=side][value=random]")).toBeChecked();
    // 保存できなくても（ストレージが使えない）この対局には使われる
    await page.locator(".preset[data-preset=dir]").click();
    await saveSettings(page);
    await expect(page.locator("#menu-rule-name")).toHaveText("方向駒");
    await startGame(page);
    await ruleCardIs(page, presetById("dir").rules);
    expect(errors).toEqual([]);
    await page.close();
  }
});

test("対局中にメニューへ出て「対局に戻る」で続けられる。終局後はメニューから新しい対局", async ({ page }) => {
  await seedPage(page, 3);
  await page.goto(`/?${encodeRules({ ...presetById("v10").rules, hp: [5, 5] })}`);
  await startGame(page, { level: "easy" });
  const cell = page.locator(".cell.can-take").first();
  await cell.click();
  // CPU（イージー）が応じて人間の手番に戻る
  await expect(page.locator("#ply")).toHaveText(/^2 \//, { timeout: 10_000 });
  await page.locator("#btn-menu").click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#game")).toBeHidden();
  await expect(page.locator("#menu-resume")).toBeVisible();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-menu-resume.png` });
  await page.locator("#menu-resume").click();
  await expect(page.locator("#game")).toBeVisible();
  await expect(page.locator("#ply")).toHaveText(/^2 \//);
  await expect(page.locator(".board.acting")).toBeVisible();

  // 新しい対局を始めると前の対局は捨て、0 手から
  await page.locator("#btn-menu").click();
  await startGame(page, { level: "normal" });
  await expect(page.locator("#ply")).toHaveText(/^0 \//);
  await expect(page.locator("#menu-resume")).toBeHidden();
});

test("終局画面の下の行に CPU の強さが出る", async ({ page }) => {
  await seedPage(page, 1);
  await page.goto(`/?${encodeRules({ ...presetById("v10").rules, hp: [5, 5] })}`);
  await startGame(page, { level: "hard" });
  for (let i = 0; i < 40 && !(await page.locator("#result").isVisible()); i++) {
    await page.waitForFunction(() => !!document.querySelector("#result[open]") || !!document.querySelector(".board.acting"), undefined, {
      timeout: 30_000,
    });
    if (await page.locator("#result").isVisible()) break;
    const take = page.locator(".cell.can-take");
    await ((await take.count()) > 0 ? take.first() : page.locator(".cell.open").first()).click();
  }
  await expect(page.locator("#result")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".score-foot")).toContainText(`CPU ${CPU_LEVEL_NAME.hard}`);
  await page.locator("#result-menu").click();
  await expect(page.locator("#menu")).toBeVisible();
  // 終局後も盤には戻れる（「結果を見る」）
  await expect(page.locator("#menu-resume")).toBeVisible();
});
