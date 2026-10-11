// 副将（スキルありで隠し王ありのルール）: 王を決めた後に鍵を押して置く駒で副将を出す・期限での自動指定・名札と盤の印、
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
  test("王を決めた後、副将の鍵を押してから置いた駒が副将になる。名札と盤に自分だけ見え、CPU の副将は期限の前は出ない", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await startCpu(page);
    // 王を決める前は副将の鍵も名札の副将も出ない（王の鍵と副将の鍵は同時に出ない）
    await expect(page.locator("#king-toggle")).toBeVisible();
    await expect(page.locator("#vice-toggle")).toHaveCount(0);
    await expect(page.locator("#player-0 .vice-tag")).toHaveCount(0);
    await humanMove(page, true);
    await untilActing(page);
    // 王を決めた後: 名札は「未定」、鍵は「あと7手」、王の鍵はもう出ない
    await expect(page.locator("#player-0 .vice-tag.unset")).toContainText("未定");
    await expect(page.locator("#vice-toggle .king-cap")).toHaveText("あと7手");
    await expect(page.locator("#king-toggle")).toHaveCount(0);
    // 押して戻すと、置いた駒は副将にならない
    await tapOrClick(page, "#vice-toggle");
    await expect(page.locator("#vice-toggle")).toHaveAttribute("aria-pressed", "true");
    await tapOrClick(page, "#vice-toggle");
    await expect(page.locator("#vice-toggle")).toHaveAttribute("aria-pressed", "false");
    await humanMove(page);
    await untilActing(page);
    await expect(page.locator(".vice-mark")).toHaveCount(0);
    await expect(page.locator("#vice-toggle .king-cap")).toHaveText("あと6手");
    // 押してから置く: 狙ったマスの吹き出しと石に「副」
    await tapOrClick(page, "#vice-toggle");
    await expect(page.locator("#vice-toggle")).toHaveClass(/\bon\b/);
    const target = page.locator(".cell.can-take").first();
    const at = await target.evaluate((c) => [Number((c as HTMLElement).dataset.r), Number((c as HTMLElement).dataset.c)] as [number, number]);
    if (isTouch(page)) await target.tap();
    else await target.hover();
    await expect(page.locator(".pv-bubble .bb-vice")).toHaveText("副将にして置く");
    await expect(target.locator(".vice-mark.ghost")).toBeVisible();
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-arm.png` });
    if (isTouch(page)) await target.tap();
    else await target.click();
    const name = cellName(at[0], at[1]);
    await expect(page.locator("#toast")).toContainText(`${name} の`);
    await expect(page.locator("#toast")).toContainText("を副将にしました。CPUには見えません");
    await expect(page.locator("#player-0 .vice-tag")).toContainText(name);
    await expect(page.locator(`.cell[data-r="${at[0]}"][data-c="${at[1]}"] .vice-mark`)).toBeVisible();
    await expect(page.locator(".vice-mark")).toHaveCount(1);
    await untilActing(page);
    await expect(page.locator("#vice-toggle")).toHaveCount(0);
    // ルールカードに副将の行
    await expect(page.locator("#rules4-list")).toContainText("副将を返されたら体力−15");
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-set.png` });
    // CPU が副将を出す期限（王の期限 7 手 ＋ 7 手）を打ち終えるまでは、CPU の副将は出したかどうかも出ない（「?」は 2 人対戦で確かめる）
    for (let i = 0; i < 3; i++) {
      await humanMove(page);
      await untilActing(page);
      await expect(page.locator("#player-1 .vice-tag")).toHaveCount(0);
    }
    // 自分の副将が返されていなければ印はそのまま（返されたら取り消し線）
    const lost = await page.locator("#player-0 .vice-tag.lost").count();
    if (lost === 0) await expect(page.locator(".vice-mark")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("期限の手まで出さなければ、その手で置いた駒が自動で副将になる", async ({ page }) => {
    await startCpu(page);
    await humanMove(page, true);
    await untilActing(page);
    for (let left = 7; left >= 1; left--) {
      if (left > 1) await expect(page.locator("#vice-toggle .king-cap")).toHaveText(`あと${left}手`);
      if (left === 1) {
        await expect(page.locator("#vice-toggle")).toHaveAttribute("title", /期限の手です/);
        await expect(page.locator("#vice-toggle .king-cap")).toHaveText("この手で副将");
        await expect(page.locator("#vice-toggle")).toBeDisabled();
      }
      await humanMove(page);
      if (left === 1) await expect(page.locator("#toast")).toContainText("が自動で副将になりました");
      await untilActing(page);
    }
    await expect(page.locator("#player-0 .vice-tag")).not.toHaveClass(/unset/);
    // 自動で決まった副将の印（CPU にすぐ返されていれば取り消し線）
    if ((await page.locator("#player-0 .vice-tag.lost").count()) === 0) await expect(page.locator(".vice-mark")).toHaveCount(1);
  });

  test("2 人対戦: 副将を返すと罰 15、返された側は 7 手以内に次の副将。期限の後に偵察で特定した副将を返すと罰 30", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const plan = findPlan(1, "firstaid")!;
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
      if (st.type === "skill") {
        // 後手の副将の期限の後なので、後手の副将は「?」（いることだけ分かる）
        if (i === plan.scoutVice) await expect(page.locator("#player-1 .vice-tag.unknown")).toContainText("？");
        await tapOrClick(page, "#skill-use");
        const fx = page.locator(".fx-skill");
        await expect(fx).toBeVisible();
        if (i === plan.scoutVice) {
          await expect(fx.locator(".cast-result")).toHaveText("副将を特定");
          await page.clock.runFor(2200);
          // 後手の副将の場所が先手にだけ見える（盤の「副」と名札）
          const v = plan.steps.slice(0, i).filter((x) => x.type === "move" && x.player === 1 && x.vice).at(-1);
          if (v?.type !== "move") throw new Error("副将の手順がない");
          await expect(page.locator(".vice-cand.scouted")).toHaveCount(1);
          await expect(page.locator(`.cell[data-r="${v.r}"][data-c="${v.c}"] .vice-cand.scouted`)).toBeVisible();
          await expect(page.locator("#player-1 .vice-tag.scouted")).toContainText(cellName(v.r, v.c));
          if (isTouch(page)) await noHorizontalScroll(page, 375);
          await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-vice-scouted.png` });
        } else {
          await page.clock.runFor(2200);
        }
        await expect(fx).toHaveCount(0);
        continue;
      }
      // 打つ: 駒を選び、王・副将を出す手なら鍵を押してから置く
      await tapOrClick(page, `#hand-buttons .piece-btn[data-kind=${st.kind}]`);
      if (st.king) await tapOrClick(page, "#king-toggle");
      if (st.vice) await tapOrClick(page, "#vice-toggle");
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
