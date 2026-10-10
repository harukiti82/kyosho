// スキル（プリセット「スキルあり」）: 対局の前に 3 枚から 1 枚を選ぶ・名札のゲージが溜まる・満タンで使う・使った演出・8 枚それぞれの効果。
// 配るカードは crypto を差し替えて決め（stubDraws）、CPU（イージー）の手は Math.random を種付きにして再現する。時計は page.clock で進める

import { expect, test, type Page } from "@playwright/test";
import { presetById, type PieceKind } from "../src/engine/rules";
import { SKILL_ORDER, SKILLS, type SkillId } from "../src/engine/skills";
import { noHorizontalScroll, seedPage, startGame, stubDraws } from "./helpers";

const SHOT = "screenshots";
const RULES = presetById("skill").rules;

/** 先手（人間）に配る 3 枚の先頭を id にする crypto の値（配る順は 先手 3 回・後手 3 回・CPU が選ぶ 1 回） */
const dealFirst = (id: SkillId) => [(SKILL_ORDER.indexOf(id) + 0.5) / SKILL_ORDER.length, 0, 0, 0, 0, 0, 0];

const isTouch = (page: Page) => page.viewportSize()!.width < 500;
const pre = (page: Page) => (isTouch(page) ? "sp" : "pc");

async function tapOrClick(page: Page, sel: string) {
  const el = page.locator(sel).first();
  if (isTouch(page)) await el.tap();
  else await el.click();
}

/** 人間が置けるマスに 1 手打つ（prefer の駒が置ければその駒で）。タッチは 1 回目で予測・2 回目で確定 */
async function humanMove(page: Page, prefer: PieceKind[] = []) {
  for (const k of prefer) {
    const b = page.locator(`#hand-buttons .piece-btn[data-kind=${k}]:not([disabled])`);
    if ((await b.count()) > 0) {
      await tapOrClick(page, `#hand-buttons .piece-btn[data-kind=${k}]`);
      break;
    }
  }
  const take = page.locator(".cell.can-take");
  const cell = (await take.count()) > 0 ? take.first() : page.locator(".cell.open").first();
  if (isTouch(page)) {
    await cell.tap();
    await cell.tap();
  } else {
    await page.mouse.move(0, 0);
    await cell.click();
  }
}

/** 名札のカードが押せる（満タンで使える）まで打つ。終局したら失敗 */
async function chargeUntilReady(page: Page, prefer: PieceKind[] = []) {
  for (let i = 0; i < 300; i++) {
    if ((await page.locator("#skill-use").count()) > 0) return;
    if (await page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open)) throw new Error("使えるようになる前に終局した");
    if ((await page.locator(".board.acting").count()) > 0) await humanMove(page, prefer);
    await page.clock.runFor(1000);
  }
  throw new Error("満タンにならない");
}

/** 対局を始めて、先頭に配られた id を選ぶ */
async function startWith(page: Page, id: SkillId, seed = 3) {
  await stubDraws(page, dealFirst(id));
  await seedPage(page, seed);
  await page.clock.install();
  await page.goto("/");
  await startGame(page, { preset: "skill", side: 0, level: "easy", cards: false });
  const dialog = page.locator("#skill-pick");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".tarot")).toHaveCount(3);
  await expect(dialog.locator(".tarot").first()).toHaveAttribute("data-skill", id);
  await tapOrClick(page, `#skill-pick .tarot[data-skill=${id}]`);
  await expect(dialog.locator(`.tarot[data-skill=${id}]`)).toHaveAttribute("aria-pressed", "true");
  await tapOrClick(page, "#skill-pick-ok");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast")).toContainText(`あなたは${SKILLS[id].name}`);
}

/** 使った演出を途中（表を向いたところ）で止めて撮り、演出を終わらせる */
async function shootCast(page: Page, id: SkillId) {
  const fx = page.locator(".fx-skill");
  await expect(fx).toBeVisible();
  await expect(fx).toHaveAttribute("data-skill", id);
  await fx.evaluate((el) => {
    for (const a of el.getAnimations({ subtree: true })) {
      a.pause();
      a.currentTime = 650;
    }
  });
  await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-cast-${id}.png` });
  await page.clock.runFor(1500);
  await expect(fx).toHaveCount(0);
}

/** 最新の棋譜の手（引き出しの棋譜）。自分の手を打ったあと */
const lastLog = (page: Page) => page.locator("#log .log-item.move").first();

test.describe("スキル", () => {
  test("3 枚から 1 枚を選び、名札にゲージが出る。選ぶまで盤は動かず、Esc では閉じない", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await stubDraws(page, dealFirst("strong"));
    await seedPage(page, 3);
    await page.goto("/");
    await startGame(page, { preset: "skill", side: 0, level: "easy", cards: false });
    const dialog = page.locator("#skill-pick");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#status")).toHaveText("カードを選んでいます");
    // 選ぶ前は「このカードにする」を押せない。CPU のカードは名札に出ない
    await expect(page.locator("#skill-pick-ok")).toBeDisabled();
    await expect(page.locator(".plate-skill")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await tapOrClick(page, "#skill-pick .tarot >> nth=1");
    await expect(page.locator("#skill-pick-detail .rule-point")).not.toBeEmpty();
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-pick.png` });
    await tapOrClick(page, "#skill-pick .tarot >> nth=0");
    await tapOrClick(page, "#skill-pick-ok");
    await expect(dialog).toBeHidden();
    // 両者のカードが名札に出る（CPU は配られた先頭の応急手当）
    await expect(page.locator("#player-0 .plate-skill .ps-name")).toHaveText("強打");
    await expect(page.locator("#player-1 .plate-skill .ps-name")).toHaveText("応急手当");
    await expect(page.locator("#player-0 .plate-skill .ps-state")).toHaveText("あと26");
    await expect(page.locator("#toast")).toHaveText("あなたは強打、CPUは応急手当");
    // 溜めマス（c3・f3・c6・f6）と、ルールカードのスキルの行
    await expect(page.locator(".cell.zone")).toHaveCount(4);
    await expect(page.locator("#rules4-list")).toContainText("ゲージが満タンでスキルを使う");
    await expect(page.locator("#board")).toHaveClass(/acting/);
    expect(errors).toEqual([]);
  });

  test("2 人対戦: 先手・後手の順に選ぶ", async ({ page }) => {
    await page.goto("/");
    await startGame(page, { preset: "skill", mode: "pvp", cards: false });
    const who = page.locator("#skill-pick .pick-who");
    await expect(who).toContainText("先手のカード");
    await tapOrClick(page, "#skill-pick .tarot >> nth=0");
    await tapOrClick(page, "#skill-pick-ok");
    await expect(who).toContainText("後手のカード");
    await tapOrClick(page, "#skill-pick .tarot >> nth=2");
    await tapOrClick(page, "#skill-pick-ok");
    await expect(page.locator("#skill-pick")).toBeHidden();
    await expect(page.locator(".plate-skill")).toHaveCount(2);
    await expect(page.locator("#toast")).toContainText("先手は");
    await expect(page.locator("#board")).toHaveClass(/acting/);
  });

  // 8 枚それぞれ: 満タンまで打って使い、効果が盤・名札・棋譜に出る
  const CASES: { id: SkillId; seed?: number; prefer?: PieceKind[]; use: (page: Page) => Promise<void> }[] = [
    {
      id: "firstaid",
      use: async (page) => {
        const before = Number(await page.locator("#player-0 .hp-num").textContent());
        await tapOrClick(page, "#skill-use");
        await shootCast(page, "firstaid");
        await expect(page.locator("#player-0 .hp-num")).toHaveText(String(Math.min(RULES.hp[0], before + 2)));
        await humanMove(page);
        await expect(lastLog(page)).toContainText("応急手当 +");
      },
    },
    {
      id: "bigheal",
      use: async (page) => {
        const before = Number(await page.locator("#player-0 .hp-num").textContent());
        await tapOrClick(page, "#skill-use");
        await shootCast(page, "bigheal");
        await expect(page.locator("#player-0 .hp-num")).toHaveText(String(Math.min(RULES.hp[0], before + 10)));
        await humanMove(page);
        await expect(lastLog(page)).toContainText("大回復 +");
      },
    },
    {
      id: "strong",
      use: async (page) => {
        await tapOrClick(page, "#skill-use");
        await shootCast(page, "strong");
        await expect(page.locator("#player-0 .plate-skill.armed .ps-state")).toHaveText("発動");
        // 予測の吹き出しに ×1.5 の内訳
        const cell = page.locator(".cell.can-take").first();
        if (isTouch(page)) await cell.tap();
        else await cell.hover();
        await expect(page.locator(".pv-bubble .bb-skill")).toContainText("× 1.5");
        await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-strong.png` });
        if (isTouch(page)) await cell.tap();
        else await cell.click();
        await expect(lastLog(page)).toContainText("強打・");
      },
    },
    {
      id: "omni",
      use: async (page) => {
        const before = await page.locator(".cell.open").count();
        await tapOrClick(page, "#skill-use");
        await shootCast(page, "omni");
        // 駒の矢印に関係なく 8 方向に挟めるので、置けるマスは減らない
        expect(await page.locator(".cell.open").count()).toBeGreaterThanOrEqual(before);
        await humanMove(page);
        await expect(lastLog(page)).toContainText("全方向・");
      },
    },
    {
      id: "refill",
      // 飛（3 個）を先に使い切る
      prefer: ["hi", "kaku"],
      use: async (page) => {
        await tapOrClick(page, "#skill-use");
        if ((await page.locator(".skill-aim").count()) > 0) {
          await expect(page.locator("#status")).toHaveText("戻す駒を選ぶ");
          if (isTouch(page)) await noHorizontalScroll(page, 375);
          await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-refill-pick.png` });
          await tapOrClick(page, ".skill-aim [data-refill]");
        }
        await shootCast(page, "refill");
        await expect(page.locator("#hand-buttons .piece-btn:not([disabled])").first()).toBeVisible();
        await humanMove(page);
        await expect(lastLog(page)).toContainText("補充 ");
      },
    },
    {
      id: "wall",
      use: async (page) => {
        await tapOrClick(page, "#skill-use");
        await shootCast(page, "wall");
        await humanMove(page);
        await expect(page.locator("#player-0 .plate-skill .ps-state")).toHaveText("鉄壁中");
        // CPU の次の手のダメージが半分
        for (let i = 0; i < 10 && !(await page.locator(".board.acting").count()); i++) await page.clock.runFor(1000);
        await expect(page.locator("#log .log-item.move.p1").first()).toContainText("鉄壁で半分");
      },
    },
    {
      id: "scout",
      use: async (page) => {
        await tapOrClick(page, "#skill-use");
        await shootCast(page, "scout");
        await expect(page.locator(".king-cand.scouted")).toHaveCount(1);
        await expect(page.locator("#player-1 .king-tag.scouted")).toBeVisible();
        await humanMove(page);
        await expect(lastLog(page)).toContainText("偵察・");
      },
    },
    {
      id: "kingmove",
      use: async (page) => {
        await tapOrClick(page, "#skill-use");
        await expect(page.locator("#status")).toHaveText("王を移す駒を選ぶ");
        const targets = page.locator(".cell.skill-target");
        expect(await targets.count()).toBeGreaterThan(0);
        if (isTouch(page)) await noHorizontalScroll(page, 375);
        await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-kingmove-pick.png` });
        const to = await targets.first().evaluate((c) => `${"abcdefgh"[Number((c as HTMLElement).dataset.c)]}${Number((c as HTMLElement).dataset.r) + 1}`);
        await tapOrClick(page, ".cell.skill-target");
        await shootCast(page, "kingmove");
        await expect(page.locator("#player-0 .king-tag")).toContainText(to);
        await humanMove(page);
        await expect(lastLog(page)).toContainText("王の移し替え・");
      },
    },
  ];

  for (const c of CASES) {
    test(`${SKILLS[c.id].name}: 満タンまで溜めて使う`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await startWith(page, c.id, c.seed);
      await chargeUntilReady(page, c.prefer);
      await expect(page.locator("#skill-use")).toHaveClass(/ready/);
      await expect(page.locator("#skill-use .ps-state")).toHaveText("満タン");
      if (isTouch(page)) await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-full-${c.id}.png` });
      await c.use(page);
      await page.clock.runFor(500);
      if (isTouch(page)) await noHorizontalScroll(page, 375);
      if (c.id !== "strong") await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-${c.id}.png` });
      // 使ったらゲージは 0 から溜め直す（この手で返した分は溜まる）
      await expect(page.locator("#player-0 .plate-skill .ps-state")).not.toHaveText("満タン");
      expect(errors).toEqual([]);
    });
  }

  test("満タンでも使えないときは「満タン」の代わりに理由を出して光らせない。押すと理由のトースト。押せる高さは広い", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // 使えるようになった光（.just-full）が出たら記録する
    await page.addInitScript(() => {
      const w = window as unknown as { __justFull: string[] };
      w.__justFull = [];
      new MutationObserver((ms) => {
        for (const m of ms) {
          for (const n of m.addedNodes) {
            if (n instanceof HTMLElement) for (const c of n.querySelectorAll(".plate-skill.just-full")) w.__justFull.push(c.closest(".player-card")?.id ?? "");
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    // 補充は使い切った駒（数字 3 以下）しか戻せない。歩・横で打って、飛・角を残したまま満タンにする
    await startWith(page, "refill");
    const chip = page.locator("#player-0 .plate-skill");
    for (let i = 0; i < 300 && !(await chip.evaluate((c) => c.classList.contains("full"))); i++) {
      if (await page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open)) throw new Error("満タンになる前に終局した");
      if ((await page.locator(".board.acting").count()) > 0) await humanMove(page, ["fu", "yoko"]);
      await page.clock.runFor(1000);
    }
    await page.clock.runFor(2000);
    await expect(page.locator(".board.acting")).toBeVisible();
    await expect(chip).toHaveClass(/\bheld\b/);
    await expect(chip.locator(".ps-state")).toHaveText("戻せる駒なし");
    // 押せない札: #skill-use はなく、光の筋も回らない。使えるようになった光は一度も出ていない
    await expect(page.locator("#skill-use")).toHaveCount(0);
    expect(await chip.evaluate((c) => getComputedStyle(c, "::after").animationName)).toBe("none");
    expect(await page.evaluate(() => (window as unknown as { __justFull: string[] }).__justFull)).not.toContain("player-0");
    // 押せる高さ: 見た目の帯（19px 前後）より広い鍵（PC 30px 以上・タッチ 42px 以上）。帯の上の余白を押しても鍵に当たる
    const hit = page.locator("#player-0 .skill-hit");
    const box = (await hit.boundingBox())!;
    const band = (await chip.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(isTouch(page) ? 42 : 30);
    expect(band.height).toBeLessThan(24);
    const x = band.x + band.width / 2;
    const y = box.y + 3;
    expect(y).toBeLessThan(band.y);
    expect(await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest(".skill-hit"), [x, y])).toBe(true);
    if (isTouch(page)) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await expect(page.locator("#toast")).toHaveText("補充　戻せる駒がない");
    // 押しても盤はそのまま（打っていない）
    await expect(page.locator(".board.acting")).toBeVisible();
    if (isTouch(page)) await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-held.png` });
    expect(errors).toEqual([]);
  });
});
