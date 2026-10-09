// 取られる駒の警告「!」の表示の切り替え: 既定はオフ・設定メニューで保存・対局中の切り替え（保存は変えない）・古い保存・遊び方は常にオン。
// 「!」の場所はページの Math.random を種付きにした CPU（ノーマル）の鏡の対局で、エンジンの threatenedPieces と照らし合わせる。

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { chooseMove } from "../src/engine/cpu";
import { createGame, legalCells, playableKinds, playMove, previewMove, threatenedPieces, viewFor, type GameState } from "../src/engine/game";
import { presetById } from "../src/engine/rules";
import { LESSONS, TUTORIAL_KEY } from "../src/ui/lessons";
import { SETTINGS_KEY } from "../src/ui/setup";
import { cellAt, noHorizontalScroll, openSettings, openTab, play, rng, saveSettings, seedPage, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const STD = presetById("std").rules;
const isMobile = (name: string) => name === "mobile";
const toggle = (page: Page) => page.locator("#btn-threat");
const threatCells = (page: Page) =>
  page.locator(".cell:has(.threat)").evaluateAll((cs) => cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort());
const saved = (page: Page) => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY);

/** 鏡の対局を 1 手（人間は置ける手の先頭、CPU はノーマルを同じ乱数で）進め、人間の手番にする */
async function advance(page: Page, s: GameState, rand: () => number, touch: boolean): Promise<GameState> {
  const kind = playableKinds(s)[0];
  const [r, c] = legalCells(s, kind)[0];
  await play(page, r, c, kind, touch);
  s = playMove(s, r, c, kind);
  while (!s.result && s.turn === 1) {
    const ch = chooseMove(viewFor(s, 1), "normal", rand)!;
    s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
  }
  expect(await waitHumanTurnOrEnd(page)).toBe(false);
  return s;
}

test("既定はオフ。対局中に切り替えるとすぐ出て、保存した設定は変わらない。新しい対局で保存した設定に戻る", async ({ page }, info) => {
  const touch = isMobile(info.project.name);
  const SEED = 11;
  await seedPage(page, SEED);
  await page.goto("/");
  await startGame(page);
  const rand = rng(SEED);
  let s = createGame(STD);
  const before = await saved(page);
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");

  // 自分の駒が返されうる局面まで進める（オフの間は「!」も凡例の「!」も出ない）
  await openTab(page, "legend-box");
  for (let i = 0; threatenedPieces(s, 0).length === 0; i++) {
    expect(i).toBeLessThan(10);
    s = await advance(page, s, rand, touch);
  }
  await expect(page.locator(".cell .threat")).toHaveCount(0);
  await expect(page.locator("#legend .key-threat")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/${touch ? "sp" : "pc"}-threat-off.png` });

  // オンにするとすぐ出る（エンジンの threatenedPieces と同じマス）
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  const want = threatenedPieces(s, 0).map(([r, c]) => cellName(r, c)).sort();
  await expect.poll(() => threatCells(page)).toEqual(want);
  await expect(page.locator("#legend .key-threat")).toHaveCount(1);
  await page.screenshot({ path: `${SHOT}/${touch ? "sp" : "pc"}-threat-on.png` });
  if (touch) await noHorizontalScroll(page, 375);
  // 保存した設定は変えない
  expect(await saved(page)).toBe(before);

  // 打っても対局の間はオンのまま
  s = await advance(page, s, rand, touch);
  await expect.poll(() => threatCells(page)).toEqual(threatenedPieces(s, 0).map(([r, c]) => cellName(r, c)).sort());

  // オフに戻すと消える
  await toggle(page).click();
  await expect(page.locator(".cell .threat")).toHaveCount(0);
  await expect(page.locator("#legend .key-threat")).toHaveCount(0);

  // 新しい対局は保存した設定（オフ）から
  await toggle(page).click();
  await page.locator("#btn-menu").click();
  await startGame(page, { side: "saved" });
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("オフなら吹き出し・予測の文に返されうる警告を出さず、ダメージの予測は出す。オンなら出す", async ({ page }) => {
    const SEED = 11;
    await seedPage(page, SEED);
    await page.goto("/");
    await startGame(page);
    const rand = rng(SEED);
    let s = createGame(STD);
    for (let i = 0; i < 3; i++) s = await advance(page, s, rand, false);
    await page.mouse.move(0, 0);
    // 置いた駒そのものが返されうるマス（オンなら警告が出る）
    const kind = playableKinds(s)[0];
    const exposedAt = legalCells(s, kind).filter(([r, c]) => previewMove(s, r, c, kind)!.exposed.some(([y, x]) => y === r && x === c));
    expect(exposedAt.length).toBeGreaterThan(0);
    const [r, c] = exposedAt[0];
    const pv = previewMove(s, r, c, kind)!;
    const btn = page.locator(`#hand-buttons .piece-btn[data-kind=${kind}]`);
    if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    for (const on of [false, true]) {
      if (on) await toggle(page).click();
      await cellAt(page, r, c).hover();
      await expect(cellAt(page, r, c).locator(".pv-bubble, .dmg-badge").first()).toBeVisible();
      if (pv.damage > 0) await expect(cellAt(page, r, c).locator(".dmg-badge")).toHaveText(String(pv.damage));
      await expect(cellAt(page, r, c).locator(".bb-warn")).toHaveCount(on ? 1 : 0);
      await expect(page.locator("#preview .warn")).toHaveCount(on ? 1 : 0);
      await page.mouse.move(0, 0);
    }
  });

  test("設定メニューでオンにして保存すると、次の対局から出る。再読み込みしても残る", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    await expect(page.locator("input[name=threat][value='0']")).toBeChecked();
    await page.locator("#opt-threat").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/pc-threat-setup.png` });
    await page.locator('label:has(> input[name=threat][value="1"])').click();
    await saveSettings(page);
    expect(JSON.parse((await saved(page))!).threat).toBe(true);
    await page.reload();
    await startGame(page);
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await openTab(page, "legend-box");
    await expect(page.locator("#legend .key-threat")).toHaveCount(1);
    // 対局中にオフにしても保存はオンのまま
    await toggle(page).click();
    expect(JSON.parse((await saved(page))!).threat).toBe(true);
    await page.locator("#btn-menu").click();
    await openSettings(page);
    await expect(page.locator("input[name=threat][value='1']")).toBeChecked();
  });

  test("項目のない古い保存はオフ", async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ side: "0", timeCpu: "20" })), SETTINGS_KEY);
    await page.goto("/");
    await startGame(page, { side: "saved" });
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("遊び方は保存がオフでも常にオン。「予測を読む」で「!」が出て、切り替えの鍵は出さない", async ({ page }) => {
    const step = LESSONS.findIndex((l) => l.title === "予測を読む");
    await page.addInitScript(
      ([key, i]) => {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem(key, JSON.stringify({ step: i, reached: i, done: false }));
          sessionStorage.setItem("seeded", "1");
        }
      },
      [TUTORIAL_KEY, step] as const,
    );
    await page.goto("/");
    await page.locator("#menu-learn").click();
    await expect(page.locator("#coach-title")).toHaveText("予測を読む");
    await expect(page.locator(".cell .threat").first()).toBeVisible();
    await expect(toggle(page)).toBeHidden();
  });
});
