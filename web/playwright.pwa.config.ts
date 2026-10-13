import { defineConfig, devices } from "@playwright/test";

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
  use: { headless: true },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
    },
  ],
});
