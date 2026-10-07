// 2 手読み CPU 同士で対局させ、先手勝率・王が返された割合・決着の手数・パス・駒種ごとの使用回数・
// 端の駒の上乗せ（うち隅の駒の割合）・隅を取った側の勝率などを集計する（隠し王・方向駒・拠点プリセットのバランス確認用）。
// 乱数は種付き（mulberry32）。局 i は種 i で、結果は毎回同じになる。
// 第 1 引数が vs なら CPU の強さ同士を対戦させる（vs 局数 プリセット 強さA 強さB。先手・後手は 1 局ごとに入れ替える）。

import { chooseLookahead, chooseMove, CPU_LEVEL_NAME, CPU_LEVELS, type CpuLevel } from "../src/engine/cpu";
import { SIZE } from "../src/engine/board";
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
const isCorner = (r: number, c: number) => (r === 0 || r === SIZE - 1) && (c === 0 || c === SIZE - 1);
const avg = (xs: number[]) => (xs.length === 0 ? "—" : (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1));

/** 強さ a と b を games 局対戦させ、a の勝ち・負け・引き分けと平均の思考時間を出す */
function versus(args: string[]) {
  const games = Number(args[0] ?? 200);
  const preset = (args[1] ?? "std") as PresetId;
  const [a, b] = [args[2] ?? "easy", args[3] ?? "normal"] as CpuLevel[];
  if (!CPU_LEVELS.includes(a) || !CPU_LEVELS.includes(b)) throw new Error(`強さは ${CPU_LEVELS.join(" / ")}`);
  const rules = cloneRules(presetById(preset).rules);
  const res = { win: 0, lose: 0, draw: 0 };
  const ms: Record<string, number[]> = { [a]: [], [b]: [] };
  const plies: number[] = [];
  for (let i = 0; i < games; i++) {
    const rand = rng(i + 1);
    // 偶数局は a が先手、奇数局は b が先手
    const levelOf = (p: Player): CpuLevel => ((p === 0) === (i % 2 === 0) ? a : b);
    let s = createGame(rules);
    while (!s.result) {
      const lv = levelOf(s.turn);
      const t = performance.now();
      const ch = chooseMove(viewFor(s, s.turn), lv, rand)!;
      ms[lv].push(performance.now() - t);
      s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
    }
    const w = s.result.winner;
    if (w === null) res.draw++;
    else if (levelOf(w) === a && a !== b) res.win++;
    else if (a === b) res[w === 0 ? "win" : "lose"]++;
    else res.lose++;
    plies.push(s.ply);
  }
  const t = (lv: CpuLevel) => avg(ms[lv]);
  console.log(`## 強さの対戦: ${presetById(preset).name}・${games} 局（先手・後手を 1 局ごとに入れ替え）`);
  console.log(`| ${CPU_LEVEL_NAME[a]} の勝ち | ${CPU_LEVEL_NAME[b]} の勝ち | 引き分け | ${CPU_LEVEL_NAME[a]} の勝率 | 平均手数 | 1 手の思考（ms） |`);
  console.log("|---|---|---|---|---|---|");
  console.log(`| ${res.win} | ${res.lose} | ${res.draw} | ${pct(res.win, games)} | ${avg(plies)} | ${CPU_LEVEL_NAME[a]} ${t(a)} / ${CPU_LEVEL_NAME[b]} ${t(b)} |`);
}

export function main(args: string[]) {
  if (args[0] === "vs") return versus(args.slice(1));
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
  let totalDamage = 0;
  const used: Partial<Record<PieceKind, number>> = {};
  // 端の駒の上乗せ（点数・回数）と、そのうち端の駒が盤の隅だったもの
  let bonus = 0;
  let bonusCorner = 0;
  let anchorUses = 0;
  let anchorCornerUses = 0;
  // 隅: 最初に隅に置いた側の勝ち数 / 終局時に隅を多く持つ側の勝ち数
  let firstCornerGames = 0;
  let firstCornerWins = 0;
  let moreCornerGames = 0;
  let moreCornerWins = 0;
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
    let first: Player | null = null;
    for (const e of s.history) {
      if (e.type !== "move") continue;
      if (first === null && isCorner(e.r, e.c)) first = e.player;
      for (const a of e.anchors ?? []) {
        const v = rules.values[a.kind];
        bonus += v;
        anchorUses++;
        if (isCorner(a.r, a.c)) {
          bonusCorner += v;
          anchorCornerUses++;
        }
      }
    }
    if (first !== null) {
      firstCornerGames++;
      if (r.winner === first) firstCornerWins++;
    }
    const corners: [number, number] = [0, 0];
    for (const [y, x] of [[0, 0], [0, SIZE - 1], [SIZE - 1, 0], [SIZE - 1, SIZE - 1]]) {
      const st = s.board[y][x];
      if (st) corners[st.owner]++;
    }
    if (corners[0] !== corners[1]) {
      moreCornerGames++;
      if (r.winner === (corners[0] > corners[1] ? 0 : 1)) moreCornerWins++;
    }
    reasons[r.reason]++;
    plies.push(s.ply);
    if (r.reason === "ko" || r.reason === "king") koPlies.push(s.ply);
    for (const p of [0, 1] as Player[]) {
      if (kingInfo(s, p).status === "hidden" || kingInfo(s, p).status === "revealed") designated++;
    }
    for (const e of s.history) {
      if (e.type === "pass") passes++;
      else {
        used[e.kind] = (used[e.kind] ?? 0) + 1;
        totalDamage += e.damage;
      }
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
    `設定: 体力 ${rules.hp[0]}・${rules.hp[1]} / 挟める方向 ${rules.dirs === "piece" ? "駒ごと" : "全方向"} / 端の駒の力 ${rules.anchor === "attack" ? "攻撃に上乗せ" : "なし"} / 隠し王 ${k.on ? `あり（罰 ${k.penalty === "lose" ? "即負け" : `−${k.amount}`}・期限 ${k.deadline} 手）` : "なし"}`,
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
  console.log(
    `| 端の駒の上乗せ（1 局あたり・両者計） | ${(bonus / games).toFixed(1)} 点・${(anchorUses / games).toFixed(1)} 回（ダメージ全体の ${pct(bonus, totalDamage)}） |`,
  );
  console.log(`| 上乗せのうち端の駒が隅だった割合 | 点数 ${pct(bonusCorner, bonus)} / 回数 ${pct(anchorCornerUses, anchorUses)} |`);
  console.log(`| 最初に隅を取った側の勝率 | ${pct(firstCornerWins, firstCornerGames)}（隅が取られた ${firstCornerGames} 局） |`);
  console.log(`| 終局時に隅を多く持つ側の勝率 | ${pct(moreCornerWins, moreCornerGames)}（隅の数が違った ${moreCornerGames} 局） |`);
  console.log(`| 王が返された割合 | ${pct(revealed, designated)}（指定 ${designated} のうち ${revealed}。先手が返した ${revealedBy[0]} / 後手が返した ${revealedBy[1]}） |`);
  console.log(`| 王が返された手数（総手数の平均） | ${avg(revealPlies)} |`);
  console.log(`| 王を決めた手（自分の何手目: 回数） | ${designateTurn.slice(1).map((n, j) => `${j + 1}: ${n}`).join(" / ")} |`);
}
