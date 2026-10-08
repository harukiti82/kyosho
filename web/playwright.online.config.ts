import { defineConfig, devices } from "@playwright/test";

// Node の環境変数（@types/node は入れていないので globalThis から読む）
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

// オンライン対戦の e2e（npm run e2e:online）。本番と同じ構成（1 つの Worker が画面の静的アセットと /api を同じオリジンで配信）を
// wrangler dev でローカルに立て、2 つのブラウザコンテキストで対局する。部屋の保存先はテスト用のディレクトリに分ける。
// ふだんの e2e（playwright.config.ts、vite preview だけ）は /api がない公開先としてオンラインの入口が出ないことを確かめる。
// ポートは E2E_ONLINE_PORT で変えられる（同じマシンで別の作業ツリーの e2e と並べて走らせるとき）。
// TEST_TURN_SECONDS は時間切れの e2e 用に追加で受ける 1 手の制限時間（秒。本番の設定にはない）
const PORT = Number(env.E2E_ONLINE_PORT ?? 8790);
export const TEST_TURN_SECONDS = 3;

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
    command: `npm run build && cd ../server && npx wrangler types && npx wrangler dev --port ${PORT} --persist-to .wrangler/e2e-state --var "ALLOWED_ORIGINS:http://localhost:*,http://127.0.0.1:*" --var "TEST_TURN_SECONDS:${TEST_TURN_SECONDS}"`,
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
