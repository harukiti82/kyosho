import { defineConfig, devices } from "@playwright/test";
import { clearedState } from "./e2e/intro";

// Node の環境変数（@types/node は入れていないので globalThis から読む）
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

// ポートは E2E_PORT で変えられる（同じマシンで別の作業ツリーの e2e と並べて走らせるとき）
const PORT = Number(env.E2E_PORT ?? 4179);

// ヘッドレスの chromium で本番ビルド（vite preview）を操作する。/api はない（GitHub Pages と同じ）
export default defineConfig({
  testDir: "e2e",
  // オンライン対戦はサーバーが要るので playwright.online.config.ts（npm run e2e:online）で動かす
  testIgnore: "online/**",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // PWA の Service Worker は止める（キャッシュの入口・assets で前のテストの状態を持ち越さない）。SW を確かめる pwa.spec.ts だけ許す
    serviceWorkers: "block",
    // 初めての人の遊び方の必須を解いておく（必須を確かめる intro.spec.ts は空にする）
    storageState: clearedState([`http://localhost:${PORT}`, `http://localhost:${PORT + 1}`]),
  },
  webServer: [
    {
      command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    // GitHub Pages と同じサブパス（/kyosho/）で同じビルドを配る（pwa.spec.ts が SW の scope を確かめる）。上のビルドの後に起こす
    {
      command: `npx vite preview --base /kyosho/ --port ${PORT + 1} --strictPort`,
      url: `http://localhost:${PORT + 1}/kyosho/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
    },
  ],
});
