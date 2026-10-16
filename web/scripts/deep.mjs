// 深く読む CPU の対戦（scripts/deep.ts）を 1 プロセスで実行する（balance.ts の deep が並列に起こす）
import { runnerImport } from "vite";

const { module } = await runnerImport(new URL("./deep.ts", import.meta.url).pathname);
module.main(process.argv.slice(2));
