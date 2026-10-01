import { defineConfig, devices } from "@playwright/test";

// ヘッドレスの chromium で本番ビルド（vite preview）を操作する
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4179",
    headless: true,
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4179 --strictPort",
    url: "http://localhost:4179",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
    },
  ],
});
