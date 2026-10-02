// tako:run npm run balance
// バランス確認（scripts/balance.ts）を Node で実行する。TS は Vite 同梱の runnerImport で読み込む（依存の追加なし）。
// 使い方: npm run balance -- [局数=400] [プリセット=king（方向駒は dir）] [体力 "先手,後手"（省略時はプリセットの値）]
import { runnerImport } from "vite";

const { module } = await runnerImport(new URL("./balance.ts", import.meta.url).pathname);
module.main(process.argv.slice(2));
