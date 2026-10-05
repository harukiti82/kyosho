import { defineConfig } from "vitest/config";

export default defineConfig({
  // どの静的ホスティング（サブパス含む）にも置けるよう相対パスで出力する
  base: "./",
  server: {
    // npm run dev のとき、/api（HTTP と WebSocket）を wrangler dev（cd server && npm run dev、:8787）に渡す。
    // 本番は同じ Worker が画面と /api を同じオリジンで配信するので、プロキシは開発のときだけ。
    // 文字列のキーは前方一致（/apix も拾う）なので、本番の run_worker_first と同じ /api と /api/… だけに絞る
    proxy: {
      "^/api(/|\\?|$)": { target: "http://localhost:8787", changeOrigin: true, ws: true },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
