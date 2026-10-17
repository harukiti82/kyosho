// tako:run npm run balance
// バランス確認（scripts/balance.ts）を Node で実行する。TS は Vite 同梱の runnerImport で読み込む（依存の追加なし）。
// 使い方: npm run balance -- [局数=400] [プリセット=king（方向駒は dir、拠点は anchor）] [体力 "先手,後手"（省略時はプリセットの値）]
// CPU の強さの対戦: npm run balance -- vs [局数=200] [プリセット=std] [強さA=easy] [強さB=normal]（easy / normal / hard）
// スキルの勝率: npm run balance -- skill [局数=400] [カード...]（省略時は 11 枚すべて。片側だけスキルを持つ 2 手読み同士。wheel:40 で長さを変えて測る。hp=139,140 で体力を変える。skillmix も同じ）
// 深く読む CPU の対戦: npm run balance -- deep [局数=400] [A=deep:10000] [B=hard] [並列数=2] [プリセット=skill]
// （A・B は easy / normal / hard / deep:予算[:幅][:tempo=0.8][:gauge=0.7]。子プロセスに分けて並列に回す。scripts/deep-run.mjs）
// エンドレスマッチの段階: npm run balance -- endless [局数=400] [プレイヤー=normal] [段階=0-19] [並列数=2]（scripts/endless-run.mjs）
import { runnerImport } from "vite";

const args = process.argv.slice(2);
if (args[0] === "deep") {
  const { deepMatch, fmt, header } = await import("./deep-run.mjs");
  const [games, a, b, jobs, preset] = args.slice(1);
  const r = await deepMatch(Number(games ?? 400), a ?? "deep:10000", b ?? "hard", Number(jobs ?? 2), preset ?? "skill");
  console.log(header);
  console.log(fmt(r));
} else if (args[0] === "endless") {
  const { endlessMatch, parseStages, report } = await import("./endless-run.mjs");
  const [games, player, stages, jobs] = args.slice(1);
  const rows = await endlessMatch(Number(games ?? 400), player ?? "normal", parseStages(stages ?? "0-19"), Number(jobs ?? 2));
  console.log(report(player ?? "normal", rows));
} else {
  const { module } = await runnerImport(new URL("./balance.ts", import.meta.url).pathname);
  module.main(args);
}
