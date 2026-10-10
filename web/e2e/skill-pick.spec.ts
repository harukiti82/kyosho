// スキルのカードを選ぶ画面の動きと効果音: 3 枚が 1 枚ずつ配られて表に返る・配る音・合わせた音（マウス）・選んだ音・決めた音。
// 動きを減らす設定では配る動きを出さず（配る音は 1 回）、消音では鳴らさない。
// 音は AudioParam.setValueAtTime に渡った周波数で見分ける（sound.ts: 配る 659・合わせる 1319・選ぶ 988・決める 784 → 1175）

import { expect, test, type Page } from "@playwright/test";
import { SKILL_ORDER } from "../src/engine/skills";
import { startGame, stubDraws } from "./helpers";

const SHOT = "screenshots";
const isTouch = (page: Page) => page.viewportSize()!.width < 500;
const pre = (page: Page) => (isTouch(page) ? "sp" : "pc");

const DEAL = 659;
const HOVER = 1319;
const SELECT = 988;
const DECIDE = [784, 1175];

/** 鳴らした音の周波数を記録する（page.goto の前に呼ぶ） */
async function recordFreqs(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __freqs: number[] };
    w.__freqs = [];
    const orig = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (v: number, t: number) {
      if (v > 100) w.__freqs.push(Math.round(v));
      return orig.call(this, v, t);
    };
  });
}
const freqs = (page: Page) => page.evaluate(() => (window as unknown as { __freqs: number[] }).__freqs);
const count = (fs: number[], f: number) => fs.filter((x) => x === f).length;
const clearFreqs = (page: Page) => page.evaluate(() => ((window as unknown as { __freqs: number[] }).__freqs.length = 0));

/** CPU 対戦（イージー）の「スキルあり」を、カードを選ぶ画面まで進める */
async function openPick(page: Page) {
  await recordFreqs(page);
  await stubDraws(page, [(SKILL_ORDER.indexOf("strong") + 0.5) / SKILL_ORDER.length, 0, 0, 0, 0, 0, 0]);
  await page.goto("/");
  await startGame(page, { preset: "skill", side: 0, level: "easy", cards: false });
  await expect(page.locator("#skill-pick")).toBeVisible();
}

test.describe("カードを選ぶ画面の動きと音", () => {
  test("3 枚が 1 枚ずつ配られて表に返り、1 枚ごとに配る音。合わせる・選ぶ・決めるでも鳴る", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await openPick(page);
    const row = page.locator("#skill-pick .tarot-row");
    await expect(row).toHaveClass(/\bdealing\b/);
    await expect(row.locator(".tarot-cover")).toHaveCount(3);
    // 1 枚ずつずらして配る（2 枚目・3 枚目は遅れて始まる）
    const delays = await row.locator(".tarot").evaluateAll((cs) => cs.map((c) => c.getAnimations()[0]?.effect?.getTiming().delay));
    expect(delays).toEqual([0, 180, 360]);
    // 途中を撮る: 1 枚目は返り終わる手前、2 枚目は裏のまま、3 枚目は飛んでくるところ
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = 430;
      }
    });
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-pick-deal-mid.png` });
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-pick-deal-end.png` });
    // 配る音は 3 回
    await expect.poll(async () => count(await freqs(page), DEAL)).toBe(3);

    // 合わせた音（マウスだけ）・選んだ音・決めた音
    await clearFreqs(page);
    const card = page.locator("#skill-pick .tarot").nth(1);
    if (!isTouch(page)) {
      await card.hover();
      await expect.poll(async () => count(await freqs(page), HOVER)).toBe(1);
      // 続けて動かしても間引く（同じカードの上で行き来しても 90 ミリ秒の間は 1 回）
      await page.locator("#skill-pick .tarot").nth(2).hover();
      await card.hover();
      expect(count(await freqs(page), HOVER)).toBeLessThanOrEqual(3);
    }
    if (isTouch(page)) await card.tap();
    else await card.click();
    await expect.poll(async () => count(await freqs(page), SELECT)).toBe(1);
    // 同じカードをもう一度押しても選んだ音は鳴らさない
    if (isTouch(page)) await card.tap();
    else await card.click();
    expect(count(await freqs(page), SELECT)).toBe(1);
    await page.locator("#skill-pick-ok").click();
    await expect(page.locator("#skill-pick")).toBeHidden();
    await expect.poll(async () => freqs(page)).toEqual(expect.arrayContaining(DECIDE));
    expect(errors).toEqual([]);
  });
});

test.describe("PC 幅: 動きを減らす設定・消音", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("動きを減らす設定: 配る動きを出さずすぐ並べ、配る音は 1 回", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPick(page);
    const row = page.locator("#skill-pick .tarot-row");
    await expect(row.locator(".tarot")).toHaveCount(3);
    await expect(row).not.toHaveClass(/dealing/);
    await expect(row.locator(".tarot-cover")).toHaveCount(0);
    expect(await row.locator(".tarot").evaluateAll((cs) => cs.flatMap((c) => c.getAnimations()).length)).toBe(0);
    await expect.poll(async () => count(await freqs(page), DEAL)).toBe(1);
  });

  test("消音: 配る・選ぶ・決めるで鳴らさない（配る動きは出す）", async ({ page }) => {
    await recordFreqs(page);
    await page.goto("/");
    await page.locator("#btn-mute").click();
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "true");
    await startGame(page, { preset: "skill", side: 0, level: "easy", cards: false });
    await expect(page.locator("#skill-pick .tarot-row")).toHaveClass(/dealing/);
    await page.locator("#skill-pick .tarot").first().hover();
    await page.locator("#skill-pick .tarot").first().click();
    await page.locator("#skill-pick-ok").click();
    await expect(page.locator("#skill-pick")).toBeHidden();
    expect(await freqs(page)).toEqual([]);
  });
});
