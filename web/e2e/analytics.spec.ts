// アクセス解析（Cloudflare Web Analytics）: localhost では計測スクリプトを読まず、cloudflareinsights.com へ何も送らない。
// 本番のホスト名で開いたときだけ読む（トークンがあれば 1 回だけ、空なら読まない）。本番のホスト名へのリクエストは
// page.route で手元の vite preview に流し、cloudflareinsights.com へのリクエストは外へ出さずにここで返す。

import { expect, test, type Page } from "@playwright/test";
import { BEACON_SRC, BEACON_TOKEN } from "../src/ui/analytics";
import { startGame } from "./helpers";

const PROD = "https://kyosho.rukiharukichi.com";
const INSIGHTS = /cloudflareinsights\.com/;

/** 計測スクリプトの要素の数 */
const beaconScripts = (page: Page) => page.locator(`script[src="${BEACON_SRC}"]`).count();

/** 本番のホスト名を手元の vite preview に流す。cloudflareinsights.com は abort なら失敗させ、そうでなければ空のスクリプトで返す */
async function routeProd(page: Page, baseURL: string, insights: "stub" | "abort") {
  const hits: string[] = [];
  const escaped: string[] = [];
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith(PROD) && !INSIGHTS.test(u) && !u.startsWith("data:")) escaped.push(u);
  });
  await page.route(INSIGHTS, async (route) => {
    hits.push(route.request().url());
    if (insights === "abort") await route.abort("blockedbyclient");
    else await route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
  });
  await page.route(`${PROD}/**`, async (route) => {
    const u = new URL(route.request().url());
    const res = await route.fetch({ url: `${baseURL}${u.pathname}${u.search}` });
    await route.fulfill({ response: res });
  });
  return { hits, escaped };
}

test("localhost では計測スクリプトを読まず、cloudflareinsights.com へ何も送らない", async ({ page }) => {
  const sent: string[] = [];
  page.on("request", (req) => {
    if (INSIGHTS.test(req.url())) sent.push(req.url());
  });
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
  await startGame(page, { preset: "std", level: "easy" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await page.reload();
  await expect(page.locator("#menu")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await beaconScripts(page)).toBe(0);
  expect(sent).toEqual([]);
});

test("本番のホスト名ではトークンがあれば計測スクリプトを 1 回だけ読む", async ({ page, baseURL }) => {
  const { hits, escaped } = await routeProd(page, baseURL!, "stub");
  await page.goto(`${PROD}/`);
  await expect(page.locator("#menu")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const expected = BEACON_TOKEN === "" ? 0 : 1;
  expect(await beaconScripts(page)).toBe(expected);
  expect(hits.filter((u) => u === BEACON_SRC)).toHaveLength(expected);
  if (expected === 1) {
    const config = await page.locator(`script[src="${BEACON_SRC}"]`).getAttribute("data-cf-beacon");
    expect(JSON.parse(config!)).toEqual({ token: BEACON_TOKEN });
    expect(await page.locator(`script[src="${BEACON_SRC}"]`).evaluate((s: HTMLScriptElement) => s.defer)).toBe(true);
  }
  // 画面の中を移っても増えない
  await startGame(page, { preset: "std", level: "easy" });
  await expect(page.locator(".board.acting")).toBeVisible();
  expect(await beaconScripts(page)).toBe(expected);
  expect(escaped).toEqual([]);
});

test("計測スクリプトを読めなくても（広告ブロッカーなど）対局はそのまま始められる", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { escaped } = await routeProd(page, baseURL!, "abort");
  await page.goto(`${PROD}/`);
  await expect(page.locator("#menu")).toBeVisible();
  await startGame(page, { preset: "std", level: "easy" });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator("#hand-buttons .piece-btn").first()).toBeVisible();
  expect(errors).toEqual([]);
  expect(escaped).toEqual([]);
});
