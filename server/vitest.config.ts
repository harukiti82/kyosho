// サーバーのテストは Workers のランタイム（workerd）の中で走らせる（Durable Object・WebSocket・storage・alarm を本物で使う）
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // エンドレスマッチの機能フラグを on にし、e2e 用の上書き（TEST_ENDLESS）と管理用のトークンを足す。
      // フラグが off の振る舞いは test/endless-flag.test.ts が env を差し替えて確かめる
      miniflare: { bindings: { ENDLESS_ENABLED: "1", TEST_ENDLESS: "1", ENDLESS_ADMIN_TOKEN: "test-admin-token" } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
