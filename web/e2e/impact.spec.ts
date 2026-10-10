// ダメージの段階の演出・効果音・終局の成績をヘッドレスブラウザで確かめる。
// 段階は「ダメージ ÷ 受けた側の体力上限」で決まるので、原案に体力だけ変えた設定を URL で渡し、同じ 1 手目（d3 に歩・1 ダメージ）で
// 小（体力 40 → 2.5%）・中（20 → 5%）・大（10 → 10%）・特大（5 → 20%）を出す。
// CPU の手は、ページの Math.random を種付き乱数にして Node 側の「鏡の対局」で予測する（演出は Math.random を使わない）。

import { expect, test, type Page } from "@playwright/test";
import { chooseLookahead } from "../src/engine/cpu";
import { createGame, lastMoveOf, playMove, viewFor } from "../src/engine/game";
import { presetById, type RuleSet } from "../src/engine/rules";
import { hitOf, statsOf, tierOf, type Tier } from "../src/ui/impact";
import { encodeRules } from "../src/ui/query";
import { cellAt, greedy, noHorizontalScroll, play, rng, seedPage, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const ORIG = presetById("orig").rules;
const withHp = (hp: [number, number]): RuleSet => ({ ...ORIG, hp });
const TEXT: Record<Exclude<Tier, "small">, string> = { mid: "ナイス！", big: "会心！", huge: "痛恨！" };

const moveCount = (page: Page) => page.locator("#log .log-item.move").count();
const isMobile = (name: string) => name === "mobile";

async function open(page: Page, rules: RuleSet, mode: "cpu" | "pvp" = "cpu") {
  await page.goto(`/?${encodeRules(rules)}`);
  await startGame(page, { mode });
}

/** 演出が終わって人間が操作できるようになったら、置けるマスに 1 手打てる（打てたら true） */
async function canPlayAfterFx(page: Page, touch: boolean) {
  if (await waitHumanTurnOrEnd(page)) return false;
  const before = await moveCount(page);
  const cell = page.locator(".cell.open").first();
  if (touch) {
    await cell.tap();
    await cell.tap();
  } else {
    await cell.click();
  }
  await expect.poll(() => moveCount(page)).toBeGreaterThan(before);
  return true;
}

for (const project of ["desktop", "mobile"] as const) {
  const pre = project === "desktop" ? "pc" : "sp";

  test.describe(project === "desktop" ? "PC 幅" : "スマホ幅 375px", () => {
    test.beforeEach(({}, info) => test.skip(info.project.name !== project, `${project} のみ`));

    test("段階ごとの演出: 小・中・大・特大の数字と文言、大以上の揺れ・粒、特大の発光。演出の後に操作できる", async ({ page }, info) => {
      const touch = isMobile(info.project.name);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const cases: [Tier, number][] = [["small", 40], ["mid", 20], ["big", 10], ["huge", 5]];
      for (const [tier, hp1] of cases) {
        const rules = withHp([40, hp1]);
        // 鏡の盤で同じ 1 手目の段階を確かめておく
        const m = lastMoveOf(playMove(createGame(rules), 2, 3, "fu"))!;
        expect(tierOf(rules, m)).toBe(tier);
        await open(page, rules);
        await play(page, 2, 3, "fu", touch);
        const pop = cellAt(page, 2, 3).locator(".dmg-pop");
        await expect(pop).toHaveClass(new RegExp(`t-${tier}`));
        await expect(pop).toHaveText("1 ダメージ ＋1 回復");
        const banner = page.locator(".fx-banner");
        if (tier === "small") {
          await expect(banner).toHaveCount(0);
        } else {
          await expect(banner).toHaveText(TEXT[tier]);
          await expect(banner).toHaveClass(new RegExp(`attack t-${tier}`));
        }
        // 演出の途中（文言が出きったところ）を撮る
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${SHOT}/${pre}-impact-${tier}.png` });
        if (tier === "big" || tier === "huge") {
          // 演出の間は盤を操作できない（次の入力と CPU の着手を待たせる）
          await expect(page.locator("#board")).not.toHaveClass(/acting/);
          await expect(page.locator(".fx-spark")).toHaveCount(tier === "huge" ? 18 : 10);
          await expect(page.locator("#board")).toHaveClass(new RegExp(`fx-shake t-${tier}`));
          await expect(page.locator("#player-1")).toHaveClass(/fx-hurt/);
        } else {
          await expect(page.locator(".fx-spark")).toHaveCount(0);
        }
        await expect(page.locator(".fx-flash")).toHaveCount(tier === "huge" ? 1 : 0);
        if (touch) await noHorizontalScroll(page, 375);
        expect(await canPlayAfterFx(page, touch)).toBe(true);
        // 演出の要素は時間で消える
        await expect(page.locator(".fx-banner")).toHaveCount(0, { timeout: 3000 });
      }
      expect(errors).toEqual([]);
    });

    test("被弾演出: CPU から受けた大ダメージは赤系（文言・画面の縁・自分の体力カード）", async ({ page }, info) => {
      const touch = isMobile(info.project.name);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const seed = 3;
      await seedPage(page, seed);
      // 先手（自分）の体力 5: CPU の 1 ダメージで 20% → 特大の被弾
      const rules = withHp([5, 200]);
      let s = playMove(createGame(rules), 2, 3, "fu");
      const c = chooseLookahead(viewFor(s, 1), rng(seed))!;
      s = playMove(s, c.r, c.c, c.kind, { king: c.king });
      const cpuMove = lastMoveOf(s)!;
      expect(tierOf(rules, cpuMove)).toBe("huge");
      await open(page, rules);
      await play(page, 2, 3, "fu", touch);
      const banner = page.locator(".fx-banner.hurt");
      await expect(banner).toHaveText("痛恨の一撃！", { timeout: 5000 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOT}/${pre}-impact-hurt.png` });
      await expect(page.locator(".fx-vignette.t-huge")).toHaveCount(1);
      await expect(page.locator(".fx-flash.hurt")).toHaveCount(1);
      await expect(page.locator(".fx-spark.hurt").first()).toBeAttached();
      await expect(page.locator("#player-0")).toHaveClass(/fx-hurt/);
      await expect(cellAt(page, cpuMove.r, cpuMove.c).locator(".dmg-pop")).toHaveClass(/hurt/);
      await expect(page.locator("#board")).not.toHaveClass(/acting/);
      if (touch) await noHorizontalScroll(page, 375);
      expect(await canPlayAfterFx(page, touch)).toBe(true);
      expect(errors).toEqual([]);
    });

    test("特大の溜め（返す駒を順にめくる）・連続する特大・1 手で体力 0 の後に終局画面と成績（CPU 対戦）", async ({ page }, info) => {
      const touch = isMobile(info.project.name);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const seed = 8;
      await seedPage(page, seed);
      // 後手（CPU）の体力 5: 自分のダメージはどれも 20% 以上で特大。返す駒が最も多い手を打って数手で倒す
      const rules = withHp([200, 5]);
      await open(page, rules);
      const rand = rng(seed);
      let s = createGame(rules);
      let built = 0;
      let huge = 0;
      for (;;) {
        if (await waitHumanTurnOrEnd(page)) break;
        const ch = greedy(s);
        s = playMove(s, ch.r, ch.c, ch.kind);
        const m = lastMoveOf(s)!;
        expect(tierOf(rules, m)).toBe("huge");
        huge++;
        // 前の手の文言はフェードアウトの終わりまで残る（入力の待ちより長い）。消えてから打ち、この手の文言だけを確かめる
        await expect(page.locator(".fx-banner")).toHaveCount(0);
        await play(page, ch.r, ch.c, ch.kind, touch);
        if (m.targets.length >= 2) {
          // めくる駒ごとに遅れをずらす（置いたマスに近い順）
          const delays = await page
            .locator(".board .stone.flipped.fx-wait")
            .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.animationDelay));
          expect(delays).toHaveLength(m.targets.length);
          expect(new Set(delays).size).toBe(m.targets.length);
          built++;
        }
        await expect(page.locator(".fx-banner")).toHaveText("痛恨！");
        // 演出の最中も横にはみ出さない（特大の数字 .dmg-pop は 1.45 倍に膨らむので、右寄りの列でも盤の中に収める。App.fitPop）。
        // 文言が出た直後と、数字がいちばん大きくなる頃（溜めの後 0.25 秒前後）の 2 回測る
        if (touch) {
          await noHorizontalScroll(page, 375);
          await page.waitForTimeout(250);
          await noHorizontalScroll(page, 375);
        }
        if (s.result) {
          // 演出の途中では終局画面を出さない
          expect(await page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open)).toBe(false);
          await page.screenshot({ path: `${SHOT}/${pre}-impact-ko.png` });
          break;
        }
        while (!s.result && s.turn === 1) {
          const c = chooseLookahead(viewFor(s, 1), rand)!;
          s = playMove(s, c.r, c.c, c.kind, { king: c.king });
        }
      }
      expect(s.result?.reason).toBe("ko");
      expect(built).toBeGreaterThan(0);
      expect(huge).toBeGreaterThanOrEqual(2);
      await expect(page.locator("#result")).toBeVisible();
      await expect(page.locator("#result-winner")).toHaveText("あなたの勝ち");
      const stats = page.locator("#result-stats .stats");
      await expect(stats).toHaveCount(1);
      await expect(stats.locator(".stats-title")).toHaveText("あなたの成績");
      const mine = statsOf(s)[0];
      const best = mine.best!;
      await expect(stats).toContainText(`最大ダメージ${best.hit.total} ${best.move.ply} 手目`);
      await expect(stats).toContainText(`返した駒 ${best.move.targets.length} 個で ${best.hit.base}`);
      await expect(stats).toContainText(`会心以上${mine.bigHits} 回`);
      // 端の駒の力・隠し王がない設定では、その行を出さない
      await expect(stats).not.toContainText("端の駒");
      await expect(stats).not.toContainText("相手の王");
      if (touch) await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/${pre}-impact-stats.png` });
      expect(errors).toEqual([]);
    });
  });
}

test.describe("PC 幅（設定・音・2 人対戦）", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("動きを減らす設定: 揺れ・粒・溜め・発光を出さず、数字と文言だけ", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, withHp([40, 5]));
    await play(page, 2, 3, "fu", false);
    await expect(page.locator(".fx-banner")).toHaveText("痛恨！");
    await expect(cellAt(page, 2, 3).locator(".dmg-pop.t-huge")).toHaveText("1 ダメージ ＋1 回復");
    await expect(page.locator(".fx-spark, .fx-flash, .fx-vignette, .fx-wait")).toHaveCount(0);
    await expect(page.locator("#board")).not.toHaveClass(/fx-shake/);
    await expect(page.locator("#player-1")).not.toHaveClass(/fx-hurt/);
    await page.screenshot({ path: `${SHOT}/pc-impact-reduced.png` });
    expect(await canPlayAfterFx(page, false)).toBe(true);
  });

  test("効果音: 初回の操作まで AudioContext を作らない・消音は再読み込み後も保たれる・消音中は作らない", async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "warning" || m.type() === "error") warnings.push(m.text());
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __ac: number; AudioContext: typeof AudioContext };
      w.__ac = 0;
      const Orig = w.AudioContext;
      w.AudioContext = class extends Orig {
        constructor(o?: AudioContextOptions) {
          super(o);
          w.__ac++;
        }
      };
    });
    const created = () => page.evaluate(() => (window as unknown as { __ac: number }).__ac);
    await page.goto(`/?${encodeRules(withHp([40, 10]))}`);
    await expect(page.locator("#menu")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await created()).toBe(0);
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "false");
    await startGame(page);
    // 対局を始める操作（メニューの CPU対戦 → 強さ）で初めて作る
    expect(await created()).toBe(1);
    await play(page, 2, 3, "fu", false);
    await expect(page.locator(".fx-banner")).toHaveText("会心！");
    await page.locator("#btn-mute").click();
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#btn-mute")).toHaveAttribute("title", "効果音: オフ");

    await page.reload();
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "true");
    await startGame(page);
    await play(page, 2, 3, "fu", false);
    await expect(page.locator(".fx-banner")).toHaveText("会心！");
    expect(await created()).toBe(0);
    // 消音を解除するとその操作で作る
    await page.locator("#btn-mute").click();
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "false");
    expect(await created()).toBe(1);
    await page.screenshot({ path: `${SHOT}/pc-impact-mute.png` });
    expect(warnings.filter((w) => /AudioContext|autoplay/i.test(w))).toEqual([]);
  });

  test("2 人対戦: どちらの攻撃も祝福の演出・受けた側の体力カードに被弾・演出中の連打で二重に置けない・両者の成績", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // 体力 10: 1 ダメージで 10% → 大
    const rules = withHp([10, 10]);
    await open(page, rules, "pvp");
    let s = createGame(rules);
    // 先手: 同じマスをダブルクリックしても 1 手だけ
    await cellAt(page, 2, 3).dblclick();
    s = playMove(s, 2, 3, "fu");
    await expect(page.locator(".fx-banner")).toHaveText("会心！");
    await expect(page.locator(".fx-banner")).toHaveClass(/attack/);
    await expect(page.locator("#player-1")).toHaveClass(/fx-hurt/);
    // 演出中は後手の置けるマスを連打しても置けない
    const next = greedy(s);
    for (let i = 0; i < 3; i++) await cellAt(page, next.r, next.c).click({ force: true });
    expect(await moveCount(page)).toBe(1);
    await page.screenshot({ path: `${SHOT}/pc-impact-pvp.png` });
    // 演出が終われば後手が打てる。後手の攻撃も祝福の演出で、先手の体力カードに被弾
    await expect(page.locator("#board")).toHaveClass(/acting/, { timeout: 3000 });
    // 先手の文言はフェードアウトの終わりまで残る（入力の待ちより長い）。消えてから打ち、後手の手の文言だけを確かめる
    await expect(page.locator(".fx-banner")).toHaveCount(0);
    await cellAt(page, next.r, next.c).click();
    s = playMove(s, next.r, next.c, next.kind);
    expect(await moveCount(page)).toBe(2);
    await expect(page.locator(".fx-banner")).toHaveClass(/attack/);
    await expect(page.locator(".fx-banner.hurt")).toHaveCount(0);
    await expect(page.locator("#player-0")).toHaveClass(/fx-hurt/);
    // 終局まで両者とも返す駒が最も多い手
    while (!s.result) {
      if (await waitHumanTurnOrEnd(page)) break;
      const ch = greedy(s);
      await play(page, ch.r, ch.c, ch.kind, false);
      s = playMove(s, ch.r, ch.c, ch.kind);
    }
    await expect(page.locator("#result")).toBeVisible({ timeout: 5000 });
    const stats = page.locator("#result-stats .stats");
    await expect(stats).toHaveCount(2);
    await expect(stats.locator(".stats-title")).toHaveText(["先手の成績", "後手の成績"]);
    const all = statsOf(s);
    for (const p of [0, 1] as const) {
      const b = all[p].best!;
      await expect(stats.nth(p)).toContainText(`最大ダメージ${hitOf(rules, b.move).total} ${b.move.ply} 手目`);
      await expect(stats.nth(p)).toContainText(`会心以上${all[p].bigHits} 回`);
    }
    await page.screenshot({ path: `${SHOT}/pc-impact-pvp-stats.png` });
    expect(errors).toEqual([]);
  });

  test("拠点（隠し王・端の駒の力あり）の成績: 上乗せの合計と王の行が出る", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // 体力を下げて数手で終わらせる（隠し王は期限の手で自動）
    const anchor = presetById("anchor").rules;
    const rules: RuleSet = { ...anchor, hp: [12, 12] };
    await open(page, rules, "pvp");
    let s = createGame(rules);
    while (!s.result) {
      if (await waitHumanTurnOrEnd(page)) break;
      const ch = greedy(s);
      await play(page, ch.r, ch.c, ch.kind, false);
      s = playMove(s, ch.r, ch.c, ch.kind);
    }
    await expect(page.locator("#result")).toBeVisible({ timeout: 5000 });
    const all = statsOf(s);
    const stats = page.locator("#result-stats .stats");
    for (const p of [0, 1] as const) {
      await expect(stats.nth(p)).toContainText(`反対側の駒の分合計 ${all[p].anchorTotal}`);
      await expect(stats.nth(p)).toContainText(all[p].kingHit ? "相手の王返した" : "相手の王返せなかった");
    }
    await page.screenshot({ path: `${SHOT}/pc-impact-anchor-stats.png` });
    expect(errors).toEqual([]);
  });
});
