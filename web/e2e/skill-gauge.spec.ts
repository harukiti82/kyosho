// スキルのゲージが溜まる演出: バーが伸びて「+N」・溜めマスから光の粒・満タンの光と満タンの間の光の筋・動きを減らす設定・待った・決着の一手。
// 2 人対戦で盤の DOM を押して打つ（CPU の手を待たない）。page.clock を止めて演出の後片付けのタイマーを止め、CSS のアニメーションは途中で止めて撮る。
// 演出の要素は MutationObserver で記録する（すぐ消えるので、出たことを後から確かめる）

import { expect, test, type Page } from "@playwright/test";
import { SKILL_ORDER, type SkillId } from "../src/engine/skills";
import { noHorizontalScroll, seedPage, startGame, stubDraws } from "./helpers";

const SHOT = "screenshots";
const pre = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");

/** 両者に配る 3 枚の先頭を id にする crypto の値（配る順は 先手 3 回・後手 3 回） */
const dealBoth = (id: SkillId) => {
  const v = (SKILL_ORDER.indexOf(id) + 0.5) / SKILL_ORDER.length;
  return [v, 0, 0, v, 0, 0, 0];
};

interface Seen {
  /** #fx に出た演出の要素（クラスと文字） */
  fx: { cls: string; text: string }[];
  /** 伸びる演出で描いた名札の札（名札の id と札のクラス） */
  chips: { who: string; cls: string }[];
}

/** 演出の要素を記録する（page.goto の前に呼ぶ） */
async function recordFx(page: Page) {
  await page.addInitScript(() => {
    const seen: Seen = { fx: [], chips: [] };
    (window as unknown as { __gauge: Seen }).__gauge = seen;
    new MutationObserver((ms) => {
      for (const m of ms) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (/fx-gauge|fx-zone/.test(n.className)) seen.fx.push({ cls: n.className, text: n.textContent ?? "" });
          for (const c of [n, ...n.querySelectorAll<HTMLElement>(".plate-skill")]) {
            if (c.classList.contains("plate-skill") && c.classList.contains("grow")) seen.chips.push({ who: c.closest(".player-card")?.id ?? "", cls: c.className });
          }
        }
      }
      // 初期化のスクリプトの時点では documentElement がまだないので document を見る
    }).observe(document, { childList: true, subtree: true });
  });
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { __gauge: Seen }).__gauge);
const clearSeen = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __gauge: Seen }).__gauge;
    s.fx.length = 0;
    s.chips.length = 0;
  });

/** page.clock の時刻を止める（この後は runFor で進めた分だけタイマーが動く） */
async function pauseClock(page: Page) {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
}

/**
 * 手番の人の手を 1 手打つ（盤の DOM を押す）。zone なら溜めマスに置ける駒とマスを探して置き、置けなければ打たずに false。
 * 打ったら打った人（0 / 1）
 */
async function playOne(page: Page, zone: boolean): Promise<0 | 1 | false> {
  // 駒を選ぶと盤はその場で描き直る（page.clock を止めている間は requestAnimationFrame も止まるので待たない）
  return page.evaluate((wantZone) => {
    const turn = document.querySelector(".player-card.active")?.id === "player-1" ? 1 : 0;
    const buttons = [...document.querySelectorAll<HTMLElement>("#hand-buttons .piece-btn:not([disabled])")];
    for (const b of buttons) {
      b.click();
      const cell = document.querySelector<HTMLElement>(wantZone ? ".cell.open.zone" : ".cell.open");
      if (cell) {
        cell.click();
        return turn as 0 | 1;
      }
    }
    return false;
  }, zone);
}

/** 溜めマスに置けるまで打ち（置けない手番は置けるマスの先頭）、溜めマスに置いた手の直後で止める。打った人を返す */
async function playUntilZone(page: Page, beforeZone?: () => Promise<void>): Promise<0 | 1> {
  for (let i = 0; i < 60; i++) {
    if (await page.locator("#result[open]").count()) break;
    await page.clock.runFor(2000);
    if ((await page.locator(".board.acting").count()) === 0) continue;
    const canZone = await page.evaluate(() => {
      for (const b of document.querySelectorAll<HTMLElement>("#hand-buttons .piece-btn:not([disabled])")) {
        b.click();
        if (document.querySelector(".cell.open.zone")) return true;
      }
      return false;
    });
    if (canZone) {
      await beforeZone?.();
      const who = await playOne(page, true);
      if (who !== false) return who;
    }
    await playOne(page, false);
  }
  throw new Error("溜めマスに置けなかった");
}

/** 盤と名札の位置（演出の前後で同じこと） */
const layout = (page: Page) =>
  page.evaluate(() =>
    ["#board", "#player-0", "#player-1"].map((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v));
    }),
  );

/** CSS のアニメーションを ms の時点で止める（演出の途中を撮る） */
async function freezeAt(page: Page, ms: number) {
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
}
const resume = (page: Page) => page.evaluate(() => document.getAnimations().forEach((a) => a.play()));

/** 2 人対戦の「スキルあり」を、両者に id を配って（先頭を選んで）始め、時計を止める */
async function startPvp(page: Page, id: SkillId) {
  await recordFx(page);
  await stubDraws(page, dealBoth(id));
  await seedPage(page, 5);
  await page.clock.install();
  await page.goto("/");
  await startGame(page, { preset: "skill", mode: "pvp" });
  await expect(page.locator(".plate-skill")).toHaveCount(2);
  await expect(page.locator(".plate-skill .ps-name").first()).toHaveText(id === "wall" ? "鉄壁" : /.+/);
  await pauseClock(page);
}

test.describe("スキルのゲージが溜まる演出", () => {
  test("溜めマスに置くと光の粒がゲージへ飛び、バーが伸びて「+N」が出る。受けた側も伸びる。盤と名札は動かない", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await startPvp(page, "strong");
    let before: number[][] = [];
    const mover = await playUntilZone(page, async () => {
      before = await layout(page);
      await clearSeen(page);
    });
    const chip = page.locator(`#player-${mover} .plate-skill`);
    await expect(chip).toHaveClass(/\bgrow\b/);
    await expect(page.locator(".fx-gauge-orb").first()).toBeAttached();
    await expect(page.locator(".fx-zone-ring").first()).toBeAttached();
    await expect(page.locator(".fx-gauge-gain").first()).toHaveText(/^\+\d+$/);
    // 光の粒はゲージの先端へ向かう（粒の行き先がゲージの高さ）
    const aim = await page.evaluate((p) => {
      const orb = document.querySelector<HTMLElement>(".fx-gauge-orb")!;
      const g = document.querySelector(`#player-${p} .ps-gauge`)!.getBoundingClientRect();
      const y = parseFloat(orb.style.top) + parseFloat(orb.style.getPropertyValue("--dy"));
      return { y, top: g.top, bottom: g.bottom };
    }, mover);
    expect(aim.y).toBeGreaterThanOrEqual(aim.top - 1);
    expect(aim.y).toBeLessThanOrEqual(aim.bottom + 1);
    // 途中を撮る: 粒が飛んでいるところ・伸びて「+N」が浮かんだところ。どちらも盤と名札の位置は同じ
    await freezeAt(page, 300);
    expect(await layout(page)).toEqual(before);
    if (pre(page) === "sp") await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-gauge-zone.png` });
    await freezeAt(page, 820);
    expect(await layout(page)).toEqual(before);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-gauge-gain.png` });
    await resume(page);

    // 演出が終われば片付く。受けた側の伸びる演出も（どこかの手で）出ている
    await page.clock.runFor(3000);
    await expect(page.locator(".fx-gauge-orb, .fx-zone-ring, .fx-gauge-gain")).toHaveCount(0);
    for (let i = 0; i < 6; i++) {
      if ((await seen(page)).chips.some((c) => c.who !== `player-${mover}`)) break;
      await playOne(page, false);
      await page.clock.runFor(2000);
    }
    expect((await seen(page)).chips.map((c) => c.who)).toContain(`player-${1 - mover}`);
    expect(errors).toEqual([]);
  });

  test("満タンになった瞬間に札が光り、満タンの間は光の筋が横切る。使って 0 に戻るときは伸びる演出を出さない", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // 鉄壁はゲージ 20（短い）
    await startPvp(page, "wall");
    let full: string | null = null;
    for (let i = 0; i < 80 && !full; i++) {
      await page.clock.runFor(2000);
      if (await page.locator("#result[open]").count()) break;
      if ((await page.locator(".board.acting").count()) === 0) continue;
      await clearSeen(page);
      if ((await playOne(page, true)) === false) await playOne(page, false);
      const s = await seen(page);
      full = s.chips.find((c) => /just-full/.test(c.cls))?.who ?? null;
    }
    expect(full).not.toBeNull();
    const chip = page.locator(`#${full} .plate-skill`);
    await expect(chip).toHaveClass(/\bfull\b/);
    await expect(chip.locator(".ps-state")).toHaveText("満タン");
    await expect(page.locator(".fx-gauge-flare").first()).toBeAttached();
    // 札が白く光ったところ（伸び終わり + 少し）を撮る
    const growAt = await chip.evaluate((c) => parseFloat(getComputedStyle(c).getPropertyValue("--grow-at")) || 0);
    await freezeAt(page, Math.max(0, growAt) + 700);
    if (pre(page) === "sp") await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/${pre(page)}-skill-gauge-full.png` });
    await resume(page);
    await page.clock.runFor(3000);
    await expect(page.locator(".fx-gauge-flare")).toHaveCount(0);
    // 満タンの間: 描き直した後（盤のマスに合わせると予測で描き直す）も光の筋（::after）が回り続ける
    await page.locator(".cell.open").first().hover();
    await expect(chip).not.toHaveClass(/just-full/);
    expect(await chip.evaluate((c) => getComputedStyle(c, "::after").animationName)).toBe("gauge-shine");
    // 光の筋が右端まで横切ったところでも、ページは横に広がらない
    await freezeAt(page, 840);
    if (pre(page) === "sp") await noHorizontalScroll(page, 375);
    await resume(page);

    // 満タンの人の手番まで進めて使う。0 に戻るが、伸びる演出・「+N」は出ない
    for (let i = 0; i < 4 && (await page.locator("#skill-use").count()) === 0; i++) {
      await playOne(page, false);
      await page.clock.runFor(2000);
    }
    await expect(page.locator("#skill-use")).toBeVisible();
    await clearSeen(page);
    await page.locator("#skill-use").click();
    await expect(page.locator(".plate-skill.armed .ps-state")).toHaveText("発動");
    const used = await seen(page);
    expect(used.chips).toEqual([]);
    expect(used.fx).toEqual([]);
    await expect(page.locator(".plate-skill.armed .ps-gauge")).toHaveAttribute("style", "--g:0");
    expect(errors).toEqual([]);
  });

  test("決着の一手で溜まっても壊れない（決着の演出を出して終局画面へ）", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await recordFx(page);
    await stubDraws(page, dealBoth("strong"));
    await page.clock.install();
    // 体力 2 ずつ: 最初に 2 以上のダメージを与えた手で決着
    await page.goto("/?take=flip&gate=0&dmg=sum&heal=none&hp1=2&hp2=2&dir=all&anc=none&skill=1");
    await startGame(page, { mode: "pvp" });
    await pauseClock(page);
    for (let i = 0; i < 30 && !(await page.locator("#result[open]").count()); i++) {
      if ((await page.locator(".board.acting").count()) > 0) await playOne(page, false);
      await page.clock.runFor(1500);
    }
    await page.clock.runFor(4000);
    await expect(page.locator("#result")).toHaveAttribute("open", "");
    expect((await seen(page)).chips.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test.describe("PC 幅: 動きを減らす設定・待った", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("動きを減らす設定: 伸ばさず・粒も「+N」も出さず、値だけ変わる", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await startPvp(page, "strong");
    const states = () => page.locator(".plate-skill .ps-state").allTextContents();
    expect(await states()).toEqual(["あと26", "あと26"]);
    await playUntilZone(page);
    await page.clock.runFor(2000);
    const s = await seen(page);
    expect(s.fx).toEqual([]);
    expect(s.chips).toEqual([]);
    expect((await states()).some((t) => t !== "あと26")).toBe(true);
    await expect(page.locator(".plate-skill.grow, .plate-skill.just-full")).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/pc-skill-gauge-reduced.png` });
  });

  test("待った（イージー）でゲージが戻るときは演出しない", async ({ page }) => {
    await recordFx(page);
    await stubDraws(page, [(SKILL_ORDER.indexOf("strong") + 0.5) / SKILL_ORDER.length, 0, 0, 0, 0, 0, 0]);
    await seedPage(page, 3);
    await page.clock.install();
    await page.goto("/");
    await startGame(page, { preset: "skill", side: 0, level: "easy" });
    await expect(page.locator(".plate-skill")).toHaveCount(2);
    await pauseClock(page);
    const before = await page.locator("#player-0 .ps-state").textContent();
    await playOne(page, false);
    // CPU の応手まで
    await page.clock.runFor(4000);
    await expect(page.locator("#board")).toHaveClass(/acting/);
    expect((await seen(page)).chips.length).toBeGreaterThan(0);
    await page.clock.runFor(3000);
    await clearSeen(page);
    await page.locator("#btn-undo").click();
    await expect(page.locator("#player-0 .ps-state")).toHaveText(before!);
    const s = await seen(page);
    expect(s.chips).toEqual([]);
    expect(s.fx).toEqual([]);
  });
});
