// 2 手読み CPU 同士で対局させ、先手勝率・王が返された割合・決着の手数・パス・駒種ごとの使用回数などを集計する
// （隠し王・方向駒プリセットのバランス確認用）。
// 乱数は種付き（mulberry32）。局 i は種 i で、結果は毎回同じになる。

import { chooseLookahead } from "../src/engine/cpu";
import { createGame, kingInfo, playMove, viewFor, type EndReason } from "../src/engine/game";
import { cloneRules, kindsInRules, PIECES, presetById, type PieceKind, type Player, type PresetId } from "../src/engine/rules";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const avg = (xs: number[]) => (xs.length === 0 ? "—" : (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1));

export function main(args: string[]) {
  const games = Number(args[0] ?? 400);
  const preset = (args[1] ?? "king") as PresetId;
  const rules = cloneRules(presetById(preset).rules);
  // 体力の上書き（例: "70,60" = 先手 70・後手 60）
  if (args[2]) rules.hp = args[2].split(",").map(Number) as [number, number];

  const wins: Record<string, number> = { 0: 0, 1: 0, draw: 0 };
  const reasons: Record<EndReason, number> = { ko: 0, limit: 0, stalled: 0, king: 0 };
  const plies: number[] = [];
  const koPlies: number[] = [];
  let designated = 0;
  let revealed = 0;
  const revealPlies: number[] = [];
  const revealedBy: [number, number] = [0, 0];
  const designateTurn: number[] = Array(rules.king.deadline + 1).fill(0);
  let passes = 0;
  const used: Partial<Record<PieceKind, number>> = {};
  const t0 = Date.now();

  for (let i = 0; i < games; i++) {
    const rand = rng(i + 1);
    let s = createGame(rules);
    while (!s.result) {
      const p = s.turn;
      const before = kingInfo(s, p);
      const ch = chooseLookahead(viewFor(s, p), rand)!;
      s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
      if (before.status === "unset" && kingInfo(s, p).status !== "unset") designateTurn[before.nextMove]++;
    }
    const r = s.result;
    wins[r.winner === null ? "draw" : r.winner]++;
    reasons[r.reason]++;
    plies.push(s.ply);
    if (r.reason === "ko" || r.reason === "king") koPlies.push(s.ply);
    for (const p of [0, 1] as Player[]) {
      if (kingInfo(s, p).status === "hidden" || kingInfo(s, p).status === "revealed") designated++;
    }
    for (const e of s.history) {
      if (e.type === "pass") passes++;
      else used[e.kind] = (used[e.kind] ?? 0) + 1;
      if (e.type === "move" && e.king) {
        revealed++;
        revealPlies.push(e.ply);
        revealedBy[e.player]++;
      }
    }
  }

  const k = rules.king;
  console.log(`## バランス確認: ${presetById(preset).name}（2 手読み同士・${games} 局・${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  console.log(
    `設定: 体力 ${rules.hp[0]}・${rules.hp[1]} / 挟める方向 ${rules.dirs === "piece" ? "駒ごと" : "全方向"} / 隠し王 ${k.on ? `あり（罰 ${k.penalty === "lose" ? "即負け" : `−${k.amount}`}・期限 ${k.deadline} 手）` : "なし"}`,
  );
  console.log("");
  console.log("| 項目 | 値 |");
  console.log("|---|---|");
  console.log(`| 先手勝率 | ${pct(wins[0], games)}（先手 ${wins[0]} / 後手 ${wins[1]} / 引き分け ${wins.draw}） |`);
  console.log(
    `| 決着 | 体力 0: ${pct(reasons.ko, games)} / 王で即負け: ${pct(reasons.king, games)} / 手数上限: ${pct(reasons.limit, games)} / 打てる手なし: ${pct(reasons.stalled, games)} |`,
  );
  console.log(`| 平均手数（全局） | ${avg(plies)} |`);
  console.log(`| 体力 0 決着の平均手数 | ${avg(koPlies)} |`);
  console.log(`| パス（1 局あたり） | ${(passes / games).toFixed(2)}（全 ${passes} 回） |`);
  const perKind = kindsInRules(rules).map((k) => `${PIECES[k].name}${rules.values[k]}: ${((used[k] ?? 0) / games).toFixed(1)}`);
  console.log(`| 駒種ごとの使用回数（1 局あたり・両者計） | ${perKind.join(" / ")} |`);
  console.log(`| 王が返された割合 | ${pct(revealed, designated)}（指定 ${designated} のうち ${revealed}。先手が返した ${revealedBy[0]} / 後手が返した ${revealedBy[1]}） |`);
  console.log(`| 王が返された手数（総手数の平均） | ${avg(revealPlies)} |`);
  console.log(`| 王を決めた手（自分の何手目: 回数） | ${designateTurn.slice(1).map((n, j) => `${j + 1}: ${n}`).join(" / ")} |`);
}
