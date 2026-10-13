// 投稿用の素材を本番ビルドから撮る（npm run promo）。e2e ではないので npm run e2e には入れない。
// 出力はリポジトリ直下の promo/（スクリーンショット・動画の元・OGP とカバーの画像）と web/public/（OGP・apple-touch-icon・PWA のアイコン icons/）。
// 動画は録画した 1 局から見せ場の区間を promo/src/parts/segments.txt に書き、promo/make-video.sh が ffmpeg でつなぐ。
// CPU の乱数（Math.random）とカードの配り（crypto）は種で固定し、撮り直しても同じ対局になるようにする

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { cellAt, openSettings, saveSettings, seedPage, startGame, waitHumanTurnOrEnd } from "../e2e/helpers";

test.describe.configure({ mode: "serial" });

/** リポジトリ直下の promo/（絶対パス、末尾は /） */
const promoDir = () => test.info().file.replace(/web\/capture\/[^/]+$/, "promo/");
const publicDir = () => test.info().file.replace(/capture\/[^/]+$/, "public/");

const CPU_SEED = 20261013;
const DEAL_SEED = 7;
/** 動画で見せるカード（どれも指定なしで使える）。配られた中で先に並ぶものを選ぶ */
const PREFER = ["strong", "omni", "fool", "firstaid", "wall", "bigheal"];
/** PC の画面（録画と PC のスクリーンショット）。PC のレイアウトは縦に約 900px 要るので、はみ出さない 3:2 にする */
const PC = { width: 1440, height: 960 };

/** crypto.getRandomValues（カードの配り・手番の抽選）を種付きにする。page.goto の前に呼ぶ */
async function seedCrypto(page: Page, seed: number) {
  await page.addInitScript((s) => {
    let a = s >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(arr: T): T => {
      const v = arr as unknown as ArrayBufferView;
      const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (let i = 0; i < u8.length; i += 4) {
        const x = next();
        for (let j = 0; j < 4 && i + j < u8.length; j++) u8[i + j] = (x >>> (8 * j)) & 255;
      }
      return arr;
    }) as Crypto["getRandomValues"];
  }, seed);
}

async function selectKind(page: Page, kind: string) {
  const btn = page.locator(`#hand-buttons .piece-btn[data-kind=${kind}]`);
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

type Move = { kind: string; r: number; c: number; score: number };

/** 置ける手をすべて狙って、予測のダメージ＋回復が最も大きい手（駒台の駒を順に選び、マスに合わせてバッジを読む） */
async function bestMove(page: Page): Promise<Move> {
  const kinds = await page
    .locator("#hand-buttons .piece-btn[data-kind]:not([disabled])")
    .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.kind!));
  let best: Move | null = null;
  for (const kind of kinds) {
    await selectKind(page, kind);
    const cells = await page
      .locator(".cell.open")
      .evaluateAll((cs) => cs.map((c) => [Number((c as HTMLElement).dataset.r), Number((c as HTMLElement).dataset.c)] as const));
    for (const [r, c] of cells) {
      await cellAt(page, r, c).hover();
      const score = await cellAt(page, r, c).evaluate((el) => {
        const n = (s: string) => Number(el.querySelector(s)?.textContent?.replace("+", "") ?? 0);
        return n(".dmg-badge") + n(".heal-badge");
      });
      if (!best || score > best.score) best = { kind, r, c, score };
    }
  }
  expect(best).not.toBeNull();
  return best!;
}

/** 配られた 3 枚から PREFER の順で 1 枚を選ぶ（先頭の強打がなければ配り直す。動画で配り直しも見せる）。選んだカードの id */
async function pickCard(page: Page, shot?: string): Promise<string> {
  const pick = page.locator("#skill-pick");
  await expect(pick).toBeVisible();
  // 3 枚が配られて表に返るのを待つ
  await page.waitForTimeout(1500);
  const dealt = () => pick.locator(".tarot[data-skill]").evaluateAll((ts) => ts.map((t) => (t as HTMLElement).dataset.skill!));
  let ids = await dealt();
  if (!ids.includes(PREFER[0]) && (await page.locator("#skill-pick-reroll").isEnabled())) {
    await page.locator("#skill-pick-reroll").click();
    await page.waitForTimeout(1500);
    ids = await dealt();
  }
  const id = PREFER.find((p) => ids.includes(p)) ?? ids[0];
  await pick.locator(`.tarot[data-skill=${id}]`).click();
  await page.waitForTimeout(700);
  if (shot) await page.screenshot({ path: shot, scale: "css" });
  await page.locator("#skill-pick-ok").click();
  await expect(pick).toBeHidden();
  return id;
}

/** 設定メニューで CPU 対戦の手番を先手に保存する（抽選の演出を出さない）。メニューに戻る */
async function saveFirstSeat(page: Page) {
  await openSettings(page);
  await page.locator(`label:has(> input[name=side][value="0"])`).click();
  await saveSettings(page);
  await expect(page.locator("#menu")).toBeVisible();
}

type Window = { from: number; to: number; score: number; skill?: { from: number; to: number } };

/**
 * PC で CPU（イージー）と 1 局を打つ。種で固定しているので、何度打っても同じ対局になる。
 * record なら録画して見せ場の区間を測る（録画中に撮るとその瞬間の録画が乱れるので、撮らない）。
 * record でなければ録画せずにスクリーンショットだけを撮る
 */
async function playPc(browser: Browser, record: boolean) {
  const out = promoDir();
  const context: BrowserContext = await browser.newContext({
    viewport: PC,
    deviceScaleFactor: 2,
    ...(record ? { recordVideo: { dir: `${out}src/parts/raw`, size: PC } } : {}),
  });
  const page = await context.newPage();
  const start = Date.now();
  const at = () => (Date.now() - start) / 1000;
  const shot = async (name: string) => {
    if (!record) await page.screenshot({ path: `${out}screenshots/${name}.png`, scale: "css" });
  };
  await seedPage(page, CPU_SEED);
  await seedCrypto(page, DEAL_SEED);
  await page.goto("/");
  await saveFirstSeat(page);
  await page.mouse.move(PC.width - 10, PC.height - 10);

  // 区間 1: メニュー → CPU対戦 → 強さ → カードを選ぶ → 盤
  const intro = { from: at(), to: 0 };
  await page.waitForTimeout(1800);
  await shot("pc-menu");
  await page.locator("#menu-cpu").click();
  await page.waitForTimeout(900);
  await page.locator(`#menu-levels [data-level=easy]`).click();
  const card = await pickCard(page, record ? undefined : `${out}screenshots/pc-cards.png`);
  await waitHumanTurnOrEnd(page);
  await page.waitForTimeout(600);
  intro.to = at();

  const windows: Window[] = [];
  const moves: Move[] = [];
  let top = -1;
  for (let i = 0; ; i++) {
    if (await waitHumanTurnOrEnd(page)) break;
    let skill: Window["skill"];
    const use = page.locator("#skill-use");
    if (await use.isVisible()) {
      const from = at();
      await page.waitForTimeout(400);
      await use.click();
      await waitHumanTurnOrEnd(page);
      await page.waitForTimeout(300);
      skill = { from, to: at() };
    }
    const m = await bestMove(page);
    moves.push(m);
    await selectKind(page, m.kind);
    await page.mouse.move(PC.width - 10, PC.height - 10);
    const from = at();
    await page.waitForTimeout(300);
    await cellAt(page, m.r, m.c).hover();
    await page.waitForTimeout(1100);
    // 対局中の画面: 中盤以降でダメージの大きい手の予測を出した所（盤だけの切り抜きは OGP・カバーに使う）
    if (!record && i >= 4 && m.score > top) {
      top = m.score;
      await shot("pc-game");
      await page.locator(".board-frame").screenshot({ path: `${out}src/parts/board.png` });
    }
    await cellAt(page, m.r, m.c).click();
    const end = await waitHumanTurnOrEnd(page);
    await page.waitForTimeout(end ? 2500 : 300);
    windows.push({ from, to: at(), score: m.score, skill });
    if (end) break;
  }
  await expect(page.locator("#result")).toBeVisible();
  await shot("pc-result");
  const winner = await page.locator("#result-winner").textContent();
  await context.close();
  if (record) await page.video()!.saveAs(`${out}src/parts/play.webm`);
  return { intro, windows, moves, card, winner };
}

let recorded: Move[] = [];

test("PC: 1 局を録画し、動画の区間を書き出す", async ({ browser }) => {
  const out = promoDir();
  mkdirSync(`${out}src/parts`, { recursive: true });
  const { intro, windows, moves, card, winner } = await playPc(browser, true);
  recorded = moves;

  // 見せ場の区間: 始まり・最初の 2 手・最初にスキルを使った手・最もダメージの大きい手・決着の手
  const last = windows[windows.length - 1];
  const used = windows.find((w) => w.skill);
  const big = windows.slice(2, -1).reduce<Window | undefined>((b, w) => (!b || w.score > b.score ? w : b), undefined);
  const picked = [windows[0], windows[1], used, big !== used ? big : undefined, last].filter((w): w is Window => !!w);
  const segs: [number, number][] = [[intro.from, intro.to]];
  for (const w of [...new Set(picked)].sort((a, b) => a.from - b.from)) {
    if (w.skill) segs.push([w.skill.from, w.skill.to]);
    segs.push([w.from, w.to]);
  }
  const total = segs.reduce((s, [a, b]) => s + b - a, 0);
  writeFileSync(`${out}src/parts/segments.txt`, segs.map(([a, b]) => `${a.toFixed(2)} ${b.toFixed(2)}`).join("\n") + "\n");
  console.log(`カード ${card} / ${winner} / 人間の手 ${windows.length} / 動画 ${total.toFixed(1)} 秒`);
  expect(winner).toBe("あなたの勝ち");
  expect(total).toBeGreaterThanOrEqual(20);
  expect(total).toBeLessThanOrEqual(40);
});

test("PC: 同じ 1 局を録画せずに打ち、スクリーンショットを撮る", async ({ browser }) => {
  mkdirSync(`${promoDir()}screenshots`, { recursive: true });
  const { moves, winner } = await playPc(browser, false);
  // 録画した対局と同じ手順（スクリーンショットが動画と同じ対局の場面になる）。-g でこのテストだけ流したときは比べない
  if (recorded.length > 0) expect(moves).toEqual(recorded);
  expect(winner).toBe("あなたの勝ち");
});

test("PC: 遊び方のステップ", async ({ browser }) => {
  const out = promoDir();
  const context = await browser.newContext({ viewport: PC, deviceScaleFactor: 2 });
  const page = await context.newPage();
  // 遊び方の進み具合を「反対側の駒」（5 番目）のステップに置いて開く
  await page.addInitScript(() => localStorage.setItem("kyosho:tutorial", JSON.stringify({ v: 2, step: 4, reached: 4, done: false })));
  await page.goto("/");
  await page.locator("#menu-learn").click();
  await expect(page.locator("#coach")).toBeVisible();
  await page.mouse.move(PC.width - 10, PC.height - 10);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}screenshots/pc-tutorial.png`, scale: "css" });
  await context.close();
});

test("スマホ: メニューと対局中の画面", async ({ browser }) => {
  const out = promoDir();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await seedPage(page, CPU_SEED);
  await seedCrypto(page, DEAL_SEED);
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}screenshots/sp-menu.png` });
  await startGame(page, { side: 0, level: "easy", cards: false });
  await pickCard(page);
  for (let i = 0; i < 6; i++) {
    if (await waitHumanTurnOrEnd(page)) break;
    const take = page.locator(".cell.can-take");
    const cell = (await take.count()) > 0 ? take.first() : page.locator(".cell.open").first();
    await cell.tap();
    await cell.tap();
  }
  expect(await waitHumanTurnOrEnd(page)).toBe(false);
  // 1 回目のタップで予測を出した所
  const kinds = await page.locator("#hand-buttons .piece-btn[data-kind]:not([disabled])").evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.kind!));
  const strongest = ["hi", "kin", "kaku", "yoko", "fu"].find((k) => kinds.includes(k))!;
  await page.locator(`#hand-buttons .piece-btn[data-kind=${strongest}]`).tap();
  const take = page.locator(".cell.can-take");
  await (((await take.count()) > 0 ? take : page.locator(".cell.open")).first()).tap();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}screenshots/sp-game.png` });
  await context.close();
});

/** HTML を指定の大きさで開き、画像と書体が揃ってから撮る */
async function render(browser: Browser, src: string, size: { width: number; height: number }, path: string) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(src);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path });
  await context.close();
}

// OGP とカバーは録画の test が書き出す src/parts/board.png を使う（この test だけ -g で流すときは先に録画を流す）
test("OGP・カバーの画像", async ({ browser }) => {
  const out = promoDir();
  mkdirSync(`${out}images`, { recursive: true });
  await render(browser, `file://${out}src/ogp.html`, { width: 1200, height: 630 }, `${publicDir()}ogp.png`);
  await render(browser, `file://${out}src/cover.html`, { width: 630, height: 500 }, `${out}images/cover.png`);
});

// アイコンは favicon.svg だけから作るので単独で流せる（-g アイコン）
test("アイコンの画像", async ({ browser }) => {
  const out = promoDir();
  mkdirSync(`${out}images`, { recursive: true });
  await render(browser, `file://${out}src/icon.html`, { width: 180, height: 180 }, `${publicDir()}apple-touch-icon.png`);
  await render(browser, `file://${out}src/icon.html`, { width: 512, height: 512 }, `${out}images/icon-512.png`);
  // PWA の manifest のアイコン（web/public/icons/。maskable は中央の安全域に収めた別の元）
  mkdirSync(`${publicDir()}icons`, { recursive: true });
  await render(browser, `file://${out}src/icon.html`, { width: 192, height: 192 }, `${publicDir()}icons/icon-192.png`);
  await render(browser, `file://${out}src/icon.html`, { width: 512, height: 512 }, `${publicDir()}icons/icon-512.png`);
  await render(browser, `file://${out}src/icon-maskable.html`, { width: 512, height: 512 }, `${publicDir()}icons/icon-maskable-512.png`);
});
