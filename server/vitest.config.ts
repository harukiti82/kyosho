// サーバーのテストは Workers のランタイム（workerd）の中で走らせる（Durable Object・WebSocket・storage・alarm を本物で使う）
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
