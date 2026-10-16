// tako:run node scripts/deep-run.mjs 400 deep:10000 hard
// 深く読む CPU の対戦を子プロセスに分けて並列に回し、勝率と 1 手の時間をまとめる（npm run balance -- deep からも呼ぶ）。
// 使い方: node scripts/deep-run.mjs 局数 A B [並列数=2] [プリセット=skill]
// A・B は easy / normal / hard / deep:予算[:幅][:tempo=0.8][:gauge=0.7][:own=1]（例 deep:10000、deep:10000:12、deep:10000:10:tempo=0.4）。
// 局 i は種 i + 1 で、偶数局は A が先手。結果は A から見た得点（勝ち 1・引き分け 0.5）
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export function parseBot(s) {
  if (!s.startsWith("deep:")) return { level: s };
  const [, nodes, ...rest] = s.split(":");
  const deep = { nodes: Number(nodes) };
  const w = {};
  for (const r of rest) {
    if (r.includes("=")) {
      const [k, v] = r.split("=");
      w[k] = Number(v);
    } else if (r.startsWith("d")) deep.maxDepth = Number(r.slice(1));
    else deep.width = Number(r);
  }
  return Object.keys(w).length > 0 ? { deep, w: { tempo: 0.8, gauge: 0.7, own: 1, ...w } } : { deep };
}

const run = (a, b, from, to, preset) =>
  new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [`${here}deep.mjs`, JSON.stringify(a), JSON.stringify(b), String(from), String(to), preset],
      { maxBuffer: 1 << 28 },
      (err, out) => (err ? reject(err) : resolve(JSON.parse(out.trim().split("\n").at(-1)))),
    ),
  );

const q = (xs, p) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};

export async function deepMatch(games, a, b, jobs = 2, preset = "skill") {
  const A = parseBot(a);
  const B = parseBot(b);
  // 小さな塊に分けて空いた子から次を渡す（局の長さがばらつくため）
  const chunk = Math.max(2, Math.ceil(games / (jobs * 4)) & ~1);
  const parts = [];
  for (let i = 0; i < games; i += chunk) parts.push([i, Math.min(games, i + chunk)]);
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < parts.length) {
        const [from, to] = parts[next++];
        results.push(await run(A, B, from, to, preset));
      }
    }),
  );
  const score = results.reduce((s, r) => s + r.score, 0);
  const plies = results.flatMap((r) => r.plies);
  const msA = results.flatMap((r) => r.msA);
  const p = score / games;
  const se = Math.sqrt((p * (1 - p)) / games);
  return {
    a,
    b,
    games,
    rate: p,
    se,
    plies: plies.reduce((s, x) => s + x, 0) / plies.length,
    ms: { median: q(msA, 0.5), p95: q(msA, 0.95), max: Math.max(...msA) },
  };
}

export const fmt = (r) =>
  `| ${r.a} | ${r.b} | ${r.games} | ${(r.rate * 100).toFixed(1)}% | ±${(r.se * 100).toFixed(1)} | ${r.plies.toFixed(1)} | ${r.ms.median.toFixed(1)} | ${r.ms.p95.toFixed(1)} | ${r.ms.max.toFixed(1)} |`;
export const header = "| A | B | 局数 | A の勝率 | ±SE | 平均手数 | A の 1 手 中央値 ms | 95% | 最大 |\n|---|---|---|---|---|---|---|---|---|";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [games, a, b, jobs, preset] = process.argv.slice(2);
  const r = await deepMatch(Number(games ?? 400), a ?? "deep:10000", b ?? "hard", Number(jobs ?? 2), preset ?? "skill");
  console.log(header);
  console.log(fmt(r));
}
