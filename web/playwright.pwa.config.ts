import { defineConfig, devices } from "@playwright/test";
import { clearedState } from "./e2e/intro";

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ORIGINS = (env.PWA_TARGETS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((u) => new URL(u).origin);

// 公開先（本番・GitHub Pages）で PWA を確かめる（e2e/pwa.spec.ts だけ。サーバーは起こさない）。
// PWA_TARGETS="https://kyosho.rukiharukichi.com/,https://harukiti82.github.io/kyosho/" npx playwright test -c playwright.pwa.config.ts
export default defineConfig({
  testDir: "e2e",
  // e2e/online/pwa.spec.ts（サーバーが要る）は拾わない
  testMatch: "pwa.spec.ts",
  testIgnore: "online/**",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // 初めての人の遊び方の必須を解いておく（メニューから CPU 対戦を始める）
  use: { headless: true, storageState: clearedState(ORIGINS) },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
    },
  ],
});
