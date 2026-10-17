// tako:run node scripts/endless-run.mjs 400 normal 0-19
// エンドレスマッチの段階ごとのプレイヤーの勝率と、そこから見込む平均の連勝数を出す（npm run balance -- endless からも呼ぶ）。
// 使い方: node scripts/endless-run.mjs 局数 プレイヤー 段階 [並列数=2]
// プレイヤーは easy / normal / hard / deep:予算（deep-run.mjs と同じ書き方）。段階は 0 始まりの連勝数で「3」「0-19」「0,5,9」。
// 平均の連勝数は、段階 k の勝ち（引き分けを除く）の割合 q_k から Σ_n Π_{k<n} q_k（測った段階まで。表の後ろは数えない）
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseBot } from "./deep-run.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

const run = (bot, stage, from, to) =>
  new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [`${here}endless.mjs`, JSON.stringify(bot), String(stage), String(from), String(to)],
      { maxBuffer: 1 << 26 },
      (err, out) => (err ? reject(err) : resolve(JSON.parse(out.trim().split("\n").at(-1)))),
    ),
  );

export function parseStages(s) {
  return s.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

export async function endlessMatch(games, player, stages, jobs = 2) {
  const bot = parseBot(player);
  const chunk = Math.max(2, Math.ceil(games / 4) & ~1);
  const tasks = [];
  for (const st of stages) for (let i = 0; i < games; i += chunk) tasks.push([st, i, Math.min(games, i + chunk)]);
  const by = new Map(stages.map((st) => [st, { stage: st, games: 0, wins: 0, draws: 0, losses: 0, plies: 0 }]));
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tasks.length) {
        const [st, from, to] = tasks[next++];
        const r = await run(bot, st, from, to);
        const t = by.get(st);
        for (const k of ["games", "wins", "draws", "losses", "plies"]) t[k] += r[k];
      }
    }),
  );
  return stages.map((st) => by.get(st));
}

export function report(player, rows) {
  const lines = ["| 段階（連勝数） | 局数 | 勝ち | 引き分け | 負け | 勝ち÷(勝ち+負け) | ±SE | 平均手数 |", "|---|---|---|---|---|---|---|---|"];
  let surv = 1;
  let expect = 0;
  for (const r of rows) {
    const decided = r.wins + r.losses;
    const q = decided > 0 ? r.wins / decided : 0;
    const se = decided > 0 ? Math.sqrt((q * (1 - q)) / decided) : 0;
    lines.push(`| ${r.stage} | ${r.games} | ${r.wins} | ${r.draws} | ${r.losses} | ${(q * 100).toFixed(1)}% | ±${(se * 100).toFixed(1)} | ${(r.plies / r.games).toFixed(1)} |`);
    surv *= q;
    expect += surv;
  }
  const contiguous = rows.every((r, i) => r.stage === i);
  lines.push("");
  lines.push(contiguous ? `プレイヤー ${player}: 見込みの平均連勝数 ${expect.toFixed(2)}（段階 0〜${rows.length - 1} まで）` : `プレイヤー ${player}`);
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [games, player, stages, jobs] = process.argv.slice(2);
  const rows = await endlessMatch(Number(games ?? 400), player ?? "normal", parseStages(stages ?? "0-19"), Number(jobs ?? 2));
  console.log(report(player ?? "normal", rows));
}
