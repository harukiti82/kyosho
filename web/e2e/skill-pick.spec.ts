// スキルのカードを選ぶ画面の動きと効果音: 3 枚が 1 枚ずつ配られて表に返る・配る音・合わせた音（マウス）・選んだ音・決めた音。
// 動きを減らす設定では配る動きを出さず（配る音は 1 回）、消音では鳴らさない。配り直し（1 局 1 回。人間と、3 枚とも弱いときの CPU）。
// 音は AudioParam.setValueAtTime に渡った周波数で見分ける（sound.ts: 配る 659・合わせる 1319・選ぶ 988・決める 784 → 1175）

import { expect, test, type Page } from "@playwright/test";
import { SKILL_ORDER, SKILLS } from "../src/engine/skills";
import { draws, noHorizontalScroll, startGame, stubDraws } from "./helpers";

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

/** 配る crypto の値: 11 枚の並びで先頭に id を引く */
const first = (id: (typeof SKILL_ORDER)[number]) => (SKILL_ORDER.indexOf(id) + 0.5) / SKILL_ORDER.length;

/** CPU 対戦（イージー）の「スキルあり」を、カードを選ぶ画面まで進める。人間に 強打・大回復・応急手当、CPU に 応急手当・大回復・強打（配り直さない）を配る */
async function openPick(page: Page, more: number[] = []) {
  await recordFreqs(page);
  await stubDraws(page, [first("strong"), 0, 0, 0, 0, 0, 0, ...more]);
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

test.describe("配り直し", () => {
  test("1 局 1 回: 押すと前と重ならない 3 枚が同じ動きと音で配られ、鍵は押せなくなる。二度押しでも 1 回", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // 配り直しは残りの 8 枚（全方向・補充・鉄壁・偵察・王の移し替え・連続行動・運命の輪・巻き戻し）から 連続行動・運命の輪・全方向
    await openPick(page, [5.5 / 8, 5.5 / 7, 3.5 / 6]);
    const tarots = page.locator("#skill-pick .tarot");
    const ids = () => tarots.evaluateAll((cs) => cs.map((c) => (c as HTMLElement).dataset.skill));
    await expect(tarots).toHaveCount(3);
    const before = await ids();
    expect(before).toEqual(["strong", "bigheal", "firstaid"]);
    const reroll = page.locator("#skill-pick-reroll");
    await expect(reroll).toHaveText("配り直し");
    await expect(reroll).toBeEnabled();
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    // 1 枚選んでから配り直しても、選んだ状態は持ち越さない
    if (isTouch(page)) await tarots.first().tap();
    else await tarots.first().click();
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-pick-reroll-before.png` });
    const dealt = await draws(page);
    await clearFreqs(page);
    // 二度押し（PC はダブルクリック・タッチは 2 回タップ）
    if (isTouch(page)) {
      await reroll.tap();
      await reroll.tap({ force: true });
    } else await reroll.dblclick();
    await expect.poll(ids).toEqual(["fool", "wheel", "omni"]);
    for (const id of await ids()) expect(before).not.toContain(id);
    expect(await draws(page)).toBe(dealt + 3);
    // 新しい 3 枚も 1 枚ずつ配られて表に返り、1 枚ごとに配る音
    await expect(page.locator("#skill-pick .tarot-row")).toHaveClass(/\bdealing\b/);
    await expect.poll(async () => count(await freqs(page), DEAL)).toBe(3);
    await expect(reroll).toBeDisabled();
    await expect(page.locator("#skill-pick-ok")).toBeDisabled();
    await expect(tarots.locator("[aria-pressed=true]")).toHaveCount(0);
    await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-pick-reroll.png` });
    // 押せない鍵を押しても何も変わらない
    await reroll.click({ force: true });
    expect(await ids()).toEqual(["fool", "wheel", "omni"]);
    expect(await draws(page)).toBe(dealt + 3);
    // 新しい 3 枚から選んで始める
    const card = page.locator("#skill-pick .tarot[data-skill=wheel]");
    if (isTouch(page)) await card.tap();
    else await card.click();
    await page.locator("#skill-pick-ok").click();
    await expect(page.locator("#skill-pick")).toBeHidden();
    await expect(page.locator("#player-0 .plate-skill .ps-name")).toHaveText(SKILLS.wheel.name);
    expect(errors).toEqual([]);
  });

  test("CPU は配られた 3 枚がどれも弱いカード（巻き戻し・大回復・偵察）なら配り直してから選ぶ", async ({ page }) => {
    // CPU の 3 枚: 巻き戻し・大回復・偵察 → 配り直しは残り 8 枚から 応急手当・強打・全方向 → 2 枚目の強打を選ぶ
    await stubDraws(page, [first("strong"), 0, 0, 10.5 / 11, 0, 4.5 / 9, 0, 0, 0, 0.5]);
    await page.goto("/");
    await startGame(page, { preset: "skill", side: 0, level: "easy", cards: false });
    await expect(page.locator("#skill-pick")).toBeVisible();
    // 配る 6 回・CPU の配り直し 3 回・CPU が選ぶ 1 回
    expect(await draws(page)).toBe(10);
    await page.locator("#skill-pick .tarot[data-skill=strong]").click();
    await page.locator("#skill-pick-ok").click();
    await expect(page.locator("#skill-pick")).toBeHidden();
    await expect(page.locator("#player-1 .plate-skill .ps-name")).toHaveText(SKILLS.strong.name);
  });
});
