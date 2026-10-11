// 副将（スキルありで隠し王ありのルール）: 王を決めた後の副将の指定・期限での自動指定・名札と盤の印、
// 2 人対戦で副将を返す（罰 15）→ 次の副将の期限が始まる → 偵察で副将を特定 → 返す（罰 30）。
// 2 人対戦の手順はエンジンで先に探し（viceplan.ts）、同じ手を盤で打つ。配るカードは crypto を差し替えて決め、時計は page.clock で止める

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { SKILL_ORDER, type SkillId } from "../src/engine/skills";
import { findPlan } from "./viceplan";
import { noHorizontalScroll, seedPage, startGame, stubDraws } from "./helpers";

const SHOT = "screenshots";
/** 先手に配る 3 枚の先頭を id にする crypto の値（後手・CPU は 0 で、配る先頭は応急手当） */
const dealFirst = (id: SkillId) => [(SKILL_ORDER.indexOf(id) + 0.5) / SKILL_ORDER.length, 0, 0, 0, 0, 0, 0];

const isTouch = (page: Page) => page.viewportSize()!.width < 500;
const pre = (page: Page) => (isTouch(page) ? "sp" : "pc");

async function tapOrClick(page: Page, sel: string) {
  const el = page.locator(sel).first();
  if (isTouch(page)) await el.tap();
  else await el.click();
}

/** (r, c) に置く。タッチは 1 回目で予測・2 回目で確定 */
async function place(page: Page, r: number, c: number) {
  const cell = page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
  if (isTouch(page)) {
    await cell.tap();
    await cell.tap();
  } else {
    await page.mouse.move(0, 0);
    await cell.click();
  }
}

/** 人間が置けるマスに 1 手打つ（王を決める手なら「この駒を王にする」を押してから） */
async function humanMove(page: Page, king = false) {
  if (king) await tapOrClick(page, "#king-toggle");
  const cell = page.locator(".cell.can-take").first();
  if (isTouch(page)) {
    await cell.tap();
    await cell.tap();
  } else {
    await page.mouse.move(0, 0);
    await cell.click();
  }
}

/** 人間の手番（盤を操作できる）になるまで時計を進める */
async function untilActing(page: Page) {
  for (let i = 0; i < 30 && (await page.locator(".board.acting").count()) === 0; i++) await page.clock.runFor(1000);
  await expect(page.locator(".board.acting")).toBeVisible();
}

const cellOf = async (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((c) => [Number((c as HTMLElement).dataset.r), Number((c as HTMLElement).dataset.c)] as [number, number]);

async function startCpu(page: Page) {
  await stubDraws(page, dealFirst("strong"));
  await seedPage(page, 5);
  await page.clock.install();
  await page.goto("/");
  await startGame(page, { preset: "skill", side: 0, level: "easy", cards: false });
  await tapOrClick(page, "#skill-pick .tarot[data-skill=strong]");
  await tapOrClick(page, "#skill-pick-ok");
  await expect(page.locator("#skill-pick")).toBeHidden();
  await page.clock.runFor(1000);
}

test.describe("副将", () => {
  test("王を決めた後に盤の自分の駒（王以外）を副将に決める。名札と盤に自分だけ見え、CPU の副将は期限の後「?」", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await startCpu(page);
    // 王を決める前は副将の鍵も名札の副将も出ない
    await expect(page.locator("#vice-toggle")).toHaveCount(0);
    await expect(page.locator("#player-0 .vice-tag")).toHaveCount(0);
    await humanMove(page, true);
    await untilActing(page);
    const king = await cellOf(page, ".cell:has(.stone.king)");
    // 王を決めた後: 名札は「未定」、鍵は「あと7手」
    await expect(page.locator("#player-0 .vice-tag.unset")).toContainText("未定");
    await expect(page.locator("#vice-toggle .king-cap")).toHaveText("あと7手");
    await tapOrClick(page, "#vice-toggle");
    await expect(page.locator("#status")).toHaveText("副将にする駒を選ぶ");
    const targets = page.locator(".cell.skill-target");
    expect(await targets.count()).toBeGreaterThan(0);
    // 王の駒は選べない
    await expect(page.locator(`.cell.skill-target[data-r="${king[0]}"][data-c="${king[1]}"]`)).toHaveCount(0);
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-pick.png` });
    // やめると元に戻る
    await tapOrClick(page, "#skill-cancel");
    await expect(page.locator(".cell.skill-target")).toHaveCount(0);
    await tapOrClick(page, "#vice-toggle");
    const at = await cellOf(page, ".cell.skill-target");
    await tapOrClick(page, ".cell.skill-target");
    const name = cellName(at[0], at[1]);
    await expect(page.locator("#toast")).toContainText(`${name} の`);
    await expect(page.locator("#toast")).toContainText("を副将にしました。CPUには見えません");
    await expect(page.locator("#player-0 .vice-tag")).toContainText(name);
    await expect(page.locator(`.cell[data-r="${at[0]}"][data-c="${at[1]}"] .vice-mark`)).toBeVisible();
    await expect(page.locator(".vice-mark")).toHaveCount(1);
    await expect(page.locator("#vice-toggle")).toHaveCount(0);
    // ルールカードに副将の行
    await expect(page.locator("#rules4-list")).toContainText("副将を返されたら体力−15");
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-set.png` });
    // CPU が王の期限（7 手）を打ち終えると、CPU の副将は「?」（場所は見えない）
    for (let i = 0; i < 12 && (await page.locator("#player-1 .vice-tag.unknown").count()) === 0; i++) {
      await humanMove(page);
      await untilActing(page);
    }
    await expect(page.locator("#player-1 .vice-tag.unknown")).toContainText("？");
    // 自分の副将が返されていなければ印はそのまま（返されたら取り消し線）
    const lost = await page.locator("#player-0 .vice-tag.lost").count();
    if (lost === 0) await expect(page.locator(".vice-mark")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("期限の手までに決めなければ、その手で置いた駒が自動で副将になる", async ({ page }) => {
    await startCpu(page);
    await humanMove(page, true);
    await untilActing(page);
    for (let left = 7; left >= 1; left--) {
      await expect(page.locator("#vice-toggle .king-cap")).toHaveText(`あと${left}手`);
      if (left === 1) await expect(page.locator("#vice-toggle")).toHaveAttribute("title", /期限の手です/);
      await humanMove(page);
      if (left === 1) await expect(page.locator("#toast")).toContainText("が自動で副将になりました");
      await untilActing(page);
    }
    await expect(page.locator("#player-0 .vice-tag")).not.toHaveClass(/unset/);
    await expect(page.locator(".vice-mark")).toHaveCount(1);
  });

  test("2 人対戦: 副将を返すと罰 15、返された側は 7 手以内に次の副将。偵察で特定した副将を返すと罰 30", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const plan = findPlan(4, "firstaid")!;
    expect(plan).not.toBeNull();
    await stubDraws(page, dealFirst("scout"));
    await page.clock.install();
    await page.goto("/");
    await startGame(page, { preset: "skill", mode: "pvp", cards: false });
    await tapOrClick(page, "#skill-pick .tarot[data-skill=scout]");
    await tapOrClick(page, "#skill-pick-ok");
    await tapOrClick(page, "#skill-pick .tarot[data-skill=firstaid]");
    await tapOrClick(page, "#skill-pick-ok");
    await expect(page.locator("#skill-pick")).toBeHidden();
    await page.clock.runFor(1000);

    const hp = async () => [Number(await page.locator("#player-0 .hp-num").textContent()), Number(await page.locator("#player-1 .hp-num").textContent())];
    for (const [i, st] of plan.steps.entries()) {
      await expect(page.locator(".board.acting")).toBeVisible();
      if (st.type === "vice") {
        await tapOrClick(page, "#vice-toggle");
        await tapOrClick(page, `.cell.skill-target[data-r="${st.at[0]}"][data-c="${st.at[1]}"]`);
        await expect(page.locator(".cell.skill-target")).toHaveCount(0);
        continue;
      }
      if (st.type === "skill") {
        await tapOrClick(page, "#skill-use");
        const fx = page.locator(".fx-skill");
        await expect(fx).toBeVisible();
        if (i === plan.scoutVice) {
          await expect(fx.locator(".cast-result")).toHaveText("副将を特定");
          await page.clock.runFor(2200);
          // 後手の副将の場所が先手にだけ見える（盤の「副」と名札）
          const v = plan.steps.slice(0, i).filter((x) => x.type === "vice").at(-1)!;
          if (v.type !== "vice") throw new Error("副将の手順がない");
          await expect(page.locator(".vice-cand.scouted")).toHaveCount(1);
          await expect(page.locator(`.cell[data-r="${v.at[0]}"][data-c="${v.at[1]}"] .vice-cand.scouted`)).toBeVisible();
          await expect(page.locator("#player-1 .vice-tag.scouted")).toContainText(cellName(v.at[0], v.at[1]));
          if (isTouch(page)) await noHorizontalScroll(page, 375);
          await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-scouted.png` });
        } else {
          await page.clock.runFor(2200);
        }
        await expect(fx).toHaveCount(0);
        continue;
      }
      // 打つ: 駒を選び、王を決める手なら鍵を押してから置く
      await tapOrClick(page, `#hand-buttons .piece-btn[data-kind=${st.kind}]`);
      if (st.king) await tapOrClick(page, "#king-toggle");
      await place(page, st.r, st.c);
      if (i === plan.hit15 || i === plan.hit30) {
        const pen = i === plan.hit15 ? 15 : 30;
        await expect(page.locator(".vice-pop")).toHaveText(`副将 −${pen}`);
        await expect(page.locator("#toast")).toContainText(`副将を返した。後手の副将は`);
        await expect(page.locator("#toast")).toContainText(`体力−${pen}`);
        if (isTouch(page)) await noHorizontalScroll(page, 375);
        await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-hit${pen}.png` });
      }
      await page.clock.runFor(2500);
      expect(await hp()).toEqual(plan.hp[i].map((x) => Math.max(0, x)));
      if (i === plan.hit15) {
        await expect(page.locator("#log .log-item.move").first()).toContainText("副将を返した・体力−15");
        // 返された後手: 名札は取り消し線、次の手番で次の副将を決める（あと 7 手）
        await expect(page.locator("#player-1 .vice-tag.lost")).toBeVisible();
        await expect(page.locator(".board.acting")).toBeVisible();
        await expect(page.locator("#vice-toggle .king-cap")).toHaveText("あと7手");
        if (isTouch(page)) await noHorizontalScroll(page, 375);
        await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-next.png` });
      }
      if (i === plan.hit30) {
        await expect(page.locator("#log .log-item.move").first()).toContainText("副将を返した・体力−30");
        await expect(page.locator(".vice-cand.scouted")).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  });
});
