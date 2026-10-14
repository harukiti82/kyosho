import { defineConfig } from "@playwright/test";
import { clearedState } from "./e2e/intro";

// Node の環境変数（@types/node は入れていないので globalThis から読む）
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

const PORT = Number(env.E2E_PORT ?? 4179);

// 投稿用の素材（リポジトリ直下の promo/ のスクリーンショット・動画・OGP とカバーの画像）を本番ビルドから撮る。
// e2e（npm run e2e）とは分け、素材を作り直すときだけ npm run promo で動かす。手順は promo/README.md
export default defineConfig({
  testDir: "capture",
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // 初めての人の遊び方の必須を解いておく（メニューの素材は錠のない形で撮る）
    storageState: clearedState([`http://localhost:${PORT}`]),
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
