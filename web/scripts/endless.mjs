// エンドレスマッチの段階の測定（scripts/endless.ts）を 1 プロセスで実行する（endless-run.mjs が並列に起こす）
import { runnerImport } from "vite";

const { module } = await runnerImport(new URL("./endless.ts", import.meta.url).pathname);
module.main(process.argv.slice(2));
