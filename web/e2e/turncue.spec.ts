// 手番の知らせ（「あなたの番」）: 操作できる手番が新しく始まったときだけ盤に斜めの帯が出て、1 秒ほどで消える。
// CPU 対戦は自分の番だけ・2 人対戦は両者の番（名前があれば「〇〇の番」）・抽選の演出の後・動きを減らす設定・遊び方のステップ・終局後。
// 帯はすぐ消えるので MutationObserver で出た時刻・消えた時刻・そのときの画面を記録して後から確かめる。
// スクリーンショットは web/screenshots/*-turncue-*.png

import { expect, test, type Page } from "@playwright/test";
import { noHorizontalScroll, openSettings, seedPage, skipToss, startGame, stubDraws } from "./helpers";
import { TURN_CUE_MS, TURN_CUE_REDUCED_MS } from "../src/ui/turncue";

const SHOT = "screenshots";
const pre = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");

interface Cue {
  text: string;
  cls: string;
  at: number;
  gone: number | null;
  /** 帯の中心の高さと幅（出た時点の画面の座標） */
  mid: number;
  left: number;
  width: number;
  /** 出た時点で盤を操作できたか・抽選と決着の演出が出ていたか・手数 */
  acting: boolean;
  toss: boolean;
  finale: boolean;
  ply: string;
}

/** 手番の知らせの帯を記録する（page.goto の前に呼ぶ。再読み込みすると空から数え直す） */
async function recordCues(page: Page) {
  await page.addInitScript(() => {
    const cues: Cue[] = [];
    (window as unknown as { __cues: Cue[] }).__cues = cues;
    const live = new Map<Node, number>();
    new MutationObserver((ms) => {
      for (const m of ms) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement) || !n.classList.contains("fx-turn")) continue;
          const r = n.getBoundingClientRect();
          live.set(n, cues.length);
          cues.push({
            text: n.textContent ?? "",
            cls: n.className,
            at: performance.now(),
            gone: null,
            mid: r.top + r.height / 2,
            left: r.left,
            width: r.width,
            acting: !!document.querySelector(".board.acting"),
            toss: !!document.querySelector(".fx-toss"),
            finale: !!document.querySelector(".fx-finale"),
            ply: document.querySelector("#ply")?.textContent ?? "",
          });
        }
        for (const n of m.removedNodes) {
          const i = live.get(n);
          if (i !== undefined) cues[i].gone = performance.now();
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

const cues = (page: Page) => page.evaluate(() => (window as unknown as { __cues: Cue[] }).__cues);
const frameBox = async (page: Page) => (await page.locator("#board-frame").boundingBox())!;
const moves = (page: Page) => page.locator("#log .log-item.move");

/** 帯の動きを出し切った所（入り終えて抜ける前）で止めて撮る */
async function shotCue(page: Page, path: string) {
  await page.locator(".fx-turn").evaluate((el) =>
    el.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = 600;
    }),
  );
  await page.screenshot({ path });
}

/** 盤の置けるマスの先頭（取れるマスがあればその先頭）に、選んでいる駒で置く（タッチは 1 回目で予測・2 回目で確定） */
async function playFirstOpen(page: Page) {
  const take = page.locator("#board .cell.can-take");
  const cell = ((await take.count()) > 0 ? take : page.locator("#board .cell.open")).first();
  if (page.viewportSize()!.width < 600) {
    await cell.tap();
    await cell.tap();
  } else {
    await cell.click();
  }
}

test("CPU 対戦: 自分の番が始まるたびに「あなたの番」が盤の下寄りに出て消える。出ている間も盤を打てる", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await seedPage(page, 11);
  await recordCues(page);
  await page.goto("/");
  await startGame(page, { preset: "std", side: 0, level: "easy" });
  // 対局の最初の自分の手番
  const band = page.locator(".fx-turn");
  await expect(band).toBeVisible();
  await expect(band).toHaveText("あなたの番");
  await shotCue(page, `${SHOT}/${pre(page)}-turncue-cpu.png`);
  const box = await frameBox(page);
  let seen = await cues(page);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ text: "あなたの番", acting: true, toss: false });
  expect(seen[0].cls).toContain("p0");
  // 盤の幅で、手番の人（下の席）の側
  expect(Math.abs(seen[0].width - box.width)).toBeLessThanOrEqual(2);
  expect(seen[0].mid).toBeGreaterThan(box.y + box.height / 2);
  expect(seen[0].mid).toBeLessThan(box.y + box.height);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  // 帯はタップを盤に通す（帯の中心の下にあるのは盤のマス）
  const through = await band.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".cell");
  });
  expect(through).toBe(true);
  // 出ている間に打てる。打つと帯は消える（CPU の番）
  await playFirstOpen(page);
  await expect(moves(page)).toHaveCount(1);
  seen = await cues(page);
  expect(seen[0].gone).not.toBeNull();
  expect(seen[0].gone! - seen[0].at).toBeLessThan(TURN_CUE_MS);
  // CPU が打ち終えたら次の自分の番の知らせ。自分の手の後（CPU の番）には出ない
  await expect.poll(async () => (await cues(page)).length, { timeout: 10_000 }).toBe(2);
  await expect(moves(page)).toHaveCount(2);
  // 1 秒ほどで消える
  await expect.poll(async () => (await cues(page))[1].gone, { timeout: 5_000 }).not.toBeNull();
  seen = await cues(page);
  expect(seen[1]).toMatchObject({ text: "あなたの番", acting: true });
  expect(seen[1].gone! - seen[1].at).toBeGreaterThanOrEqual(TURN_CUE_MS - 100);
  expect(seen[1].gone! - seen[1].at).toBeLessThan(TURN_CUE_MS + 500);
  await expect(band).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("CPU 対戦の抽選: 石を投げる演出の間は出さず、終わってから出す", async ({ page }) => {
  await seedPage(page, 3);
  await stubDraws(page, [0.1]);
  await recordCues(page);
  await page.goto("/");
  await startGame(page, { preset: "std", side: "random" });
  await expect(page.locator(".fx-toss")).toBeVisible();
  await page.waitForTimeout(400);
  expect(await cues(page)).toHaveLength(0);
  await skipToss(page, 0);
  await expect.poll(async () => (await cues(page)).length).toBe(1);
  expect((await cues(page))[0]).toMatchObject({ text: "あなたの番", acting: true, toss: false });
});

test("2 人対戦: 手番が替わるたびに出す。名前があれば「〇〇の番」、なければ「後手の番」。後手は盤の上寄り", async ({ page }) => {
  await recordCues(page);
  await page.goto("/");
  await openSettings(page);
  await page.locator("#setup-form input[name=name0]").fill("くろの人");
  await startGame(page, { mode: "pvp", preset: "std" });
  await expect.poll(async () => (await cues(page)).length).toBe(1);
  const box = await frameBox(page);
  let seen = await cues(page);
  expect(seen[0]).toMatchObject({ text: "くろの人の番", acting: true });
  expect(seen[0].mid).toBeGreaterThan(box.y + box.height / 2);
  await playFirstOpen(page);
  await expect.poll(async () => (await cues(page)).length).toBe(2);
  await shotCue(page, `${SHOT}/${pre(page)}-turncue-pvp.png`);
  seen = await cues(page);
  expect(seen[1]).toMatchObject({ text: "後手の番", acting: true });
  expect(seen[1].cls).toContain("p1");
  expect(seen[1].mid).toBeLessThan(box.y + box.height / 2);
  expect(seen[1].mid).toBeGreaterThan(box.y);
  await noHorizontalScroll(page, page.viewportSize()!.width);
});

test("2 人対戦の終局: 決着の後は出さない（打った手の数だけ出る）", async ({ page }) => {
  await recordCues(page);
  // 試遊のルール v1.0 の体力 5（数手で決着する）
  await page.goto("/?hp1=5&hp2=5");
  await startGame(page, { mode: "pvp" });
  for (let i = 0; i < 120 && !(await page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open)); i++) {
    if (await page.locator(".board.acting").isVisible()) {
      const before = await moves(page).count();
      await playFirstOpen(page);
      await expect.poll(() => moves(page).count()).toBeGreaterThan(before);
    } else {
      await page.waitForTimeout(200);
    }
  }
  await expect(page.locator("#result")).toHaveAttribute("open", "");
  await page.waitForTimeout(TURN_CUE_MS);
  const seen = await cues(page);
  const n = await moves(page).count();
  // 決着の手の後の手番は知らせない（パスがなければ 1 手ごとに 1 回）
  expect(seen.length).toBeLessThanOrEqual(n);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((c) => c.acting && !c.finale)).toBe(true);
});

test("動きを減らす設定: 帯は動かさず、短く出して消す", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedPage(page, 11);
  await recordCues(page);
  await page.goto("/");
  await startGame(page, { preset: "std", side: 0 });
  const band = page.locator(".fx-turn");
  await expect(band).toBeVisible();
  await expect(band).toHaveClass(/reduce/);
  const style = await band.evaluate((el) => {
    const s = getComputedStyle(el);
    return { anim: s.animationName, transform: s.transform, opacity: s.opacity };
  });
  expect(style).toEqual({ anim: "none", transform: "none", opacity: "1" });
  await expect.poll(async () => (await cues(page))[0].gone, { timeout: 5_000 }).not.toBeNull();
  const c = (await cues(page))[0];
  expect(c.gone! - c.at).toBeGreaterThanOrEqual(TURN_CUE_REDUCED_MS - 100);
  expect(c.gone! - c.at).toBeLessThan(TURN_CUE_MS);
});

test("遊び方のステップでは出さない", async ({ page }) => {
  await recordCues(page);
  await page.goto("/");
  await page.locator("#menu-learn").click();
  await expect(page.locator("#coach")).toBeVisible();
  await expect(page.locator(".board.acting")).toBeVisible();
  await page.waitForTimeout(TURN_CUE_MS);
  expect(await cues(page)).toHaveLength(0);
});
