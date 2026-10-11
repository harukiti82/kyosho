// tako:run npm run balance
// バランス確認（scripts/balance.ts）を Node で実行する。TS は Vite 同梱の runnerImport で読み込む（依存の追加なし）。
// 使い方: npm run balance -- [局数=400] [プリセット=king（方向駒は dir、拠点は anchor）] [体力 "先手,後手"（省略時はプリセットの値）]
// CPU の強さの対戦: npm run balance -- vs [局数=200] [プリセット=std] [強さA=easy] [強さB=normal]（easy / normal / hard）
// スキルの勝率: npm run balance -- skill [局数=400] [カード...]（省略時は 8 枚すべて。片側だけスキルを持つ 2 手読み同士）
import { runnerImport } from "vite";

const { module } = await runnerImport(new URL("./balance.ts", import.meta.url).pathname);
module.main(process.argv.slice(2));
