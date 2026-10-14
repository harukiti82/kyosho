// PWA: manifest・Service Worker・オフラインで開き直して遊べること・新しい版への切り替え・SW が横取りしないもの。
// ほかの e2e は SW を止めて動かす（playwright.config.ts の serviceWorkers: "block"）。ここだけ SW を許す。
// 確かめる先はローカルの vite preview の 2 つ（本番と同じ / と、GitHub Pages と同じサブパス /kyosho/）。
// PWA_TARGETS に URL をカンマ区切りで渡すと、その公開先を確かめる（npx playwright test -c playwright.pwa.config.ts）

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { choosePreset, openSettings, saveSettings } from "./helpers";

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const PORT = Number(env.E2E_PORT ?? 4179);
const TARGETS = (env.PWA_TARGETS ?? `http://localhost:${PORT}/,http://localhost:${PORT + 1}/kyosho/`)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

test.use({ serviceWorkers: "allow" });

/** SW が有効になって画面を受け持つまで待ち、scope と版（キャッシュの名前）を返す */
async function waitControlled(page: Page): Promise<{ scope: string; caches: string[] }> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 30_000 });
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, caches: (await caches.keys()).filter((k) => k.startsWith("kyosho-")) };
  });
}

/** オフラインで開き直しても画面が出るように: 初回 → SW が受け持つまで待つ */
async function install(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("#menu")).toBeVisible();
  return waitControlled(page);
}

/** CPU 対戦（スキルなし・イージー・先手）を始めて 1 手打つ。打った後に手数が進むことを見る */
async function playOneMove(page: Page, touch: boolean) {
  await openSettings(page);
  await choosePreset(page, "std");
  await page.locator('label:has(> input[name=side][value="0"])').click();
  await saveSettings(page);
  await expect(page.locator("#menu")).toBeVisible();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=easy]").click();
  await expect(page.locator(".board.acting")).toBeVisible({ timeout: 15_000 });
  const before = await page.locator("#ply").textContent();
  const btn = page.locator("#hand-buttons .piece-btn:not(.blocked)").first();
  if (touch) await btn.tap();
  else await btn.click();
  const cell = page.locator(".cell.can-take, .cell.open").first();
  if (touch) {
    await cell.tap();
    await cell.tap();
  } else await cell.click();
  await expect(page.locator("#ply")).not.toHaveText(before ?? "");
}

for (const base of TARGETS) {
  const label = new URL(base).pathname === "/" ? "ルート" : `サブパス ${new URL(base).pathname}`;

  test.describe(`${label}（${base}）`, () => {
    test("manifest が読めて、インストールの条件を満たす", async ({ page }) => {
      await page.goto(base);
      const href = await page.locator('link[rel="manifest"]').getAttribute("href");
      expect(href).toBe("./manifest.webmanifest");
      const manifestUrl = new URL(href!, base).href;
      const res = await page.request.get(manifestUrl);
      expect(res.ok()).toBe(true);
      const m = await res.json();
      expect(m).toMatchObject({ short_name: "挟将", start_url: "./", scope: "./", display: "standalone" });
      // アイコン: 192・512・maskable が取れて、書いた大きさどおり
      for (const icon of m.icons as { src: string; sizes: string }[]) {
        const url = new URL(icon.src, manifestUrl).href;
        const size = await page.evaluate(async (u) => {
          const img = new Image();
          img.src = u;
          await img.decode();
          return `${img.naturalWidth}x${img.naturalHeight}`;
        }, url);
        expect(size, icon.src).toBe(icon.sizes);
      }
      expect((m.icons as { purpose: string }[]).some((i) => i.purpose === "maskable")).toBe(true);
      await waitControlled(page);
      const cdp = await page.context().newCDPSession(page);
      const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as { installabilityErrors: unknown[] };
      expect(installabilityErrors).toEqual([]);
    });

    test("SW の scope は置いた場所。オフラインで開き直してもメニューが出て、CPU 対戦を 1 手打てる", async ({ page, context }, info) => {
      const sw = await install(page, base);
      expect(sw.scope).toBe(base);
      expect(sw.caches).toHaveLength(1);
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator("#menu")).toBeVisible();
      // 入口・assets は SW から（ネットワークには行けない）
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await playOneMove(page, info.project.name === "mobile");
      await context.setOffline(false);
    });

    test("初めての人はオフラインでも遊び方から。遊び方はオフラインで始められる", async ({ page, context }) => {
      await install(page, base);
      // e2e の既定の保存（必須を解いた印）を消して、初めての人として開き直す
      await page.evaluate(() => localStorage.clear());
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator("#menu")).toBeVisible();
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await expect(page.locator("#menu-cpu")).toHaveClass(/\blocked\b/);
      await page.locator("#menu-cpu").click();
      await expect(page.locator("#menu-levels")).toBeHidden();
      await page.locator("#menu-learn").click();
      await expect(page.locator("#coach-num")).toHaveText("1/16");
      await expect(page.locator(".board.acting")).toBeVisible();
      await context.setOffline(false);
    });

    test("オフラインではオンライン対戦の入口を出さず、招待リンクは接続できない案内になる", async ({ page, context }) => {
      await install(page, base);
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator("#menu")).toBeVisible();
      await page.locator("#menu-multi").click();
      await expect(page.locator("#menu-pvp")).toBeVisible();
      await page.waitForTimeout(500);
      await expect(page.locator("#menu-online")).toBeHidden();
      await page.goto(`${base}?room=${"A".repeat(22)}`);
      await expect(page.locator("#online")).toHaveAttribute("data-view", "error");
      await context.setOffline(false);
    });

    test("/api と計測は SW を通らない（横取りしない）", async ({ page }) => {
      await install(page, base);
      const health = page.waitForResponse((r) => r.url().endsWith("/api/health"));
      await page.reload();
      const res = await health;
      expect(res.fromServiceWorker()).toBe(false);
      // SW が取りに行ったリクエストに /api・cdn-cgi・cloudflareinsights がない
      const viaSw: string[] = [];
      page.context().on("request", (r) => {
        if (r.serviceWorker()) viaSw.push(r.url());
      });
      await page.reload();
      await expect(page.locator("#menu")).toBeVisible();
      await page.waitForTimeout(500);
      expect(viaSw.filter((u) => /\/api(\/|$)|\/cdn-cgi\/|cloudflareinsights/.test(u))).toEqual([]);
    });

    test("初回の読み込みの途中で通信が切れても画面は動き、次に開いたときに SW が入る", async ({ page, context }) => {
      // SW の precache だけを通信切れにする（画面の読み込みは通す）
      const offlineSw = async (route: Parameters<Parameters<BrowserContext["route"]>[1]>[0]) =>
        route.request().serviceWorker() ? route.abort("internetdisconnected") : route.fallback();
      await context.route("**/*", offlineSw);
      await page.goto(base);
      await expect(page.locator("#menu")).toBeVisible();
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
      await page.locator("#menu-cpu").click();
      await expect(page.locator("#menu-levels")).toBeVisible();
      await context.unroute("**/*", offlineSw);
      // 通信が戻って開き直すと入り、オフラインでも開ける
      await install(page, base);
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator("#menu")).toBeVisible();
      await context.setOffline(false);
    });

    // SW 自体の差し替え（sw.js の版が変わって前の版のキャッシュが消える）は、ブラウザが取りに行く sw.js を route で
    // 差し替えられないのでここでは見ない（ビルドを 2 回出して確かめる。README「ホーム画面に追加・オフライン（PWA）」）
    test("新しい入口を出すと、1 回目の開き直しで新しい版になり、その後はオフラインでも新しい版", async ({ page, context }) => {
      await install(page, base);
      await expect(page.locator('meta[name="kyosho-build"]')).toHaveCount(0);
      // 新しい版の公開を真似る: 入口に印を足す
      await context.route(base, async (route) => {
        const res = await route.fetch();
        const html = (await res.text()).replace("<head>", '<head><meta name="kyosho-build" content="next" />');
        await route.fulfill({ response: res, body: html });
      });
      await page.reload();
      await expect(page.locator('meta[name="kyosho-build"]')).toHaveCount(1);
      await expect(page.locator("#menu")).toBeVisible();
      await context.unroute(base);
      // 取れた入口はキャッシュも更新している（オフラインで開き直しても新しい版）
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator('meta[name="kyosho-build"]')).toHaveCount(1);
      await expect(page.locator("#menu")).toBeVisible();
      await context.setOffline(false);
    });

    test("Service Worker が使えないブラウザでも、登録しないだけで画面は動く", async ({ page }) => {
      await page.addInitScript(() => {
        delete (Navigator.prototype as { serviceWorker?: unknown }).serviceWorker;
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      await expect(page.locator("#menu")).toBeVisible();
      expect(await page.evaluate(() => "serviceWorker" in navigator)).toBe(false);
      await page.locator("#menu-cpu").click();
      await expect(page.locator("#menu-levels")).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}
