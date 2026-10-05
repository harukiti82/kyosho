import { defineConfig, devices } from "@playwright/test";

// オンライン対戦の e2e（npm run e2e:online）。本番と同じ構成（1 つの Worker が画面の静的アセットと /api を同じオリジンで配信）を
// wrangler dev でローカルに立て、2 つのブラウザコンテキストで対局する。部屋の保存先はテスト用のディレクトリに分ける。
// ふだんの e2e（playwright.config.ts、vite preview だけ）は /api がない公開先としてオンラインの入口が出ないことを確かめる
const PORT = 8790;

export default defineConfig({
  testDir: "e2e/online",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  webServer: {
    command: `npm run build && cd ../server && npx wrangler types && npx wrangler dev --port ${PORT} --persist-to .wrangler/e2e-state --var "ALLOWED_ORIGINS:http://localhost:*,http://127.0.0.1:*"`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
    },
  ],
});
