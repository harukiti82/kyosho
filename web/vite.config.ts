import { defineConfig } from "vitest/config";

export default defineConfig({
  // どの静的ホスティング（サブパス含む）にも置けるよう相対パスで出力する
  base: "./",
  test: {
    include: ["test/**/*.test.ts"],
  },
});
