// 1 手ごとの制限時間のテスト: 時間切れの自動の手（engine の randomMove / playTimeout）と、画面の時計（ui/clock.ts の TurnClock）

import { describe, expect, it } from "vitest";
import {
  createGame,
  kingInfo,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  playTimeout,
  randomMove,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { PRESETS, type PieceKind } from "../src/engine/rules";
import {
  clockLevel,
  clockText,
  CPU_TURN_SECONDS,
  cpuTurnSeconds,
  isCpuTime,
  isMultiTime,
  TurnClock,
} from "../src/ui/clock";
import { boardOf, rulesOf, stateOf } from "./helpers";

/** 手番の人が置ける手すべて（マスと駒種の組） */
function allMoves(s: GameState): string[] {
  return playableKinds(s).flatMap((k) => legalCells(s, k).map(([r, c]) => `${r},${c},${k}`));
}

/** i 番目の手を選ぶ乱数（n 手のうち i 番目の区間の真ん中） */
const nth = (i: number, n: number) => () => (i + 0.5) / n;

describe("時間切れの自動の手（randomMove / playTimeout）", () => {
  it("置ける手（駒の種類を含む）だけを、どれも同じ確率で選ぶ（全プリセットの初手）", () => {
    for (const p of PRESETS) {
      const s = createGame(p.rules);
      const moves = allMoves(s);
      expect(moves.length).toBeGreaterThan(0);
      const picked = moves.map((_, i) => {
        const m = randomMove(s, nth(i, moves.length))!;
        return `${m.r},${m.c},${m.kind}`;
      });
      // 区間ごとに 1 手ずつ選ばれる = 全部の手が同じ幅を持つ
      expect(new Set(picked)).toEqual(new Set(moves));
      expect(picked).toHaveLength(moves.length);
      // 乱数が 1 に張り付いても範囲外にならない
      expect(moves).toContain(((m) => `${m!.r},${m!.c},${m!.kind}`)(randomMove(s, () => 1)));
    }
  });

  it("駒ごとの方向で置けるマスが違っても、その駒で置けるマスだけを選ぶ（標準）", () => {
    let s = createGame(PRESETS.find((p) => p.id === "std")!.rules);
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 30 && !s.result; i++) {
      const m = randomMove(s, rng)!;
      expect(legalCells(s, m.kind).some(([r, c]) => r === m.r && c === m.c)).toBe(true);
      s = playTimeout(s, () => 0.37);
    }
  });

  it("棋譜の手に timeout の印を付ける。人が打った手には付けない", () => {
    const s = createGame(rulesOf("v10"));
    const auto = playTimeout(s, () => 0);
    expect(lastMoveOf(auto)!.timeout).toBe(true);
    const m = randomMove(s, () => 0)!;
    const manual = playMove(s, m.r, m.c, m.kind);
    expect(lastMoveOf(manual)).not.toHaveProperty("timeout");
    // 印のほかは同じ手を打ったのと同じ局面
    const { timeout: _t, ...rest } = lastMoveOf(auto)!;
    expect(rest).toEqual(lastMoveOf(manual));
    expect(auto.board).toEqual(manual.board);
    expect(auto.hp).toEqual(manual.hp);
  });

  it("PlayerView（相手の王の場所を含まない）でも同じ手を選ぶ", () => {
    const s = createGame(rulesOf("king"));
    for (const x of [0, 0.25, 0.5, 0.99]) {
      expect(randomMove(viewFor(s, s.turn), () => x)).toEqual(randomMove(s, () => x));
    }
  });

  it("隠し王: 期限の手の時間切れは、置いた駒がルールどおり自動で王になる。期限前の手では王を決めない", () => {
    const rules = rulesOf("orig", { heal: "none", king: { on: true, penalty: "hp", amount: 20, deadline: 2 } });
    let s = createGame(rules);
    // 1 手目（期限前）: 王は決まらない
    s = playTimeout(s, () => 0.5);
    expect(kingInfo(s, 0)).toMatchObject({ status: "unset", canDesignate: true });
    s = playTimeout(s, () => 0.5);
    // 先手の 2 手目（期限）: 置いた駒が自動で王
    expect(kingInfo(s, 0).forcedNow).toBe(true);
    s = playTimeout(s, () => 0.5);
    const m = lastMoveOf(s)!;
    expect(m.player).toBe(0);
    expect(kingInfo(s, 0)).toMatchObject({ status: "hidden", cell: [m.r, m.c], auto: true });
  });

  it("自動の手で相手が打てなくなればパスして、同じ人の手番が続く", () => {
    // 後手は持ち駒がない
    const s = stateOf(boardOf({ d4: [1, 1], e5: [1, 1], d5: [0, 1], e4: [0, 1] }), {
      rules: rulesOf("v10"),
      hands: [{ fu: 3 }, {}],
    });
    const next = playTimeout(s, () => 0.5);
    expect(next.history.slice(-2).map((e) => e.type)).toEqual(["move", "pass"]);
    expect(next.history.at(-1)).toMatchObject({ type: "pass", player: 1, reason: "noPieces" });
    expect(next.turn).toBe(0);
    expect(next.result).toBeNull();
  });

  it("自動の手で決着がつく（相手の体力が 0）", () => {
    // 裏返すルールでは必ず 1 枚以上返すので、体力 1 の相手はどの手でも倒れる
    const s = stateOf(createGame(rulesOf("orig")).board, { rules: rulesOf("orig", { heal: "none" }), hp: [50, 1] });
    for (let i = 0; i < 4; i++) {
      const end = playTimeout(s, nth(i, 4));
      expect(end.result).toMatchObject({ winner: 0, reason: "ko" });
      expect(lastMoveOf(end)!.timeout).toBe(true);
    }
  });

  it("終局後は打たない（randomMove は null、playTimeout は例外）", () => {
    const s = stateOf(createGame(rulesOf("orig")).board, { rules: rulesOf("orig", { heal: "none" }), hp: [50, 1] });
    const end = playTimeout(s, () => 0);
    expect(randomMove(end, () => 0)).toBeNull();
    expect(() => playTimeout(end, () => 0)).toThrow();
  });

  it("取るルールで盤が埋まるまで自動の手だけで打ち切れる（毎手 置ける手から選ぶ）", () => {
    let s = createGame(rulesOf("v10"));
    let n = 0;
    while (!s.result && n < 200) {
      const before = allMoves(s);
      s = playTimeout(s, () => (n * 0.618) % 1);
      const m = s.history.filter((e) => e.type === "move").at(-1)!;
      expect(before).toContain(`${m.r},${m.c},${m.kind as PieceKind}`);
      n++;
    }
    expect(s.result).not.toBeNull();
    expect(s.history.filter((e) => e.type === "move").every((e) => e.type === "move" && e.timeout)).toBe(true);
  });
});

describe("時計（TurnClock）", () => {
  const fake = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it("数え始めは止まっていて、動かした間だけ減る。止めている間は減らない", () => {
    const f = fake();
    const c = new TurnClock(f.now);
    c.reset("a", 45_000);
    f.advance(10_000);
    expect(c.remaining()).toBe(45_000);
    c.setRunning(true);
    f.advance(5_000);
    expect(c.remaining()).toBe(40_000);
    c.setRunning(false);
    f.advance(60_000);
    expect(c.remaining()).toBe(40_000);
    expect(c.expired).toBe(false);
    c.setRunning(true);
    f.advance(39_999);
    expect(c.expired).toBe(false);
    f.advance(1);
    expect(c.expired).toBe(true);
    expect(c.remaining()).toBe(0);
  });

  it("同じ手番なら reset しても残りを保ち、手番が変わったら制限時間に戻す", () => {
    const f = fake();
    const c = new TurnClock(f.now);
    c.reset("1:4", 20_000);
    c.setRunning(true);
    f.advance(7_000);
    c.reset("1:4", 20_000);
    expect(c.remaining()).toBe(13_000);
    expect(c.running).toBe(true);
    c.reset("1:5", 20_000);
    expect(c.remaining()).toBe(20_000);
    expect(c.running).toBe(false);
  });

  it("タブを裏に回していた・スリープしていた分（時刻の差）も減る。何度見ても同じ", () => {
    const f = fake();
    const c = new TurnClock(f.now);
    c.reset("a", 45_000);
    c.setRunning(true);
    // タイマーが一度も動かなくても、時刻が進めば切れている
    f.advance(10 * 60_000);
    expect(c.expired).toBe(true);
    expect(c.remaining()).toBe(0);
  });

  it("外した時計は切れない・残り 0", () => {
    const c = new TurnClock(fake().now);
    expect(c.expired).toBe(false);
    c.reset("a", 1000);
    c.clear();
    expect(c.current).toBeNull();
    c.setRunning(true);
    expect(c.running).toBe(false);
    expect(c.expired).toBe(false);
  });

  it("サーバーの締め切りに合わせる（follow）。猶予の分は制限時間で頭打ち", () => {
    const f = fake();
    const c = new TurnClock(f.now);
    c.follow("net:3", 20_000, f.now() + 21_500);
    expect(c.remaining()).toBe(20_000);
    f.advance(1_500);
    expect(c.remaining()).toBe(20_000);
    f.advance(5_000);
    expect(c.remaining()).toBe(15_000);
    f.advance(60_000);
    expect(c.remaining()).toBe(0);
  });
});

describe("制限時間の設定と表示", () => {
  it("CPU 対戦の「強さに合わせる」はイージー なし・ノーマル 45 秒・ハード 20 秒。選んだ秒数はそのまま", () => {
    expect(CPU_TURN_SECONDS).toEqual({ easy: 0, normal: 45, hard: 20 });
    expect(cpuTurnSeconds("auto", "easy")).toBe(0);
    expect(cpuTurnSeconds("auto", "normal")).toBe(45);
    expect(cpuTurnSeconds("auto", "hard")).toBe(20);
    expect(cpuTurnSeconds("90", "hard")).toBe(90);
    expect(cpuTurnSeconds("0", "normal")).toBe(0);
  });

  it("設定の値は選択肢の文字列だけ", () => {
    expect(["auto", "0", "20", "45", "90"].every(isCpuTime)).toBe(true);
    expect(["0", "20", "45", "90"].every(isMultiTime)).toBe(true);
    for (const bad of ["auto", "30", "45.0", " 45", "", 45, null, undefined]) expect(isMultiTime(bad)).toBe(false);
    for (const bad of ["AUTO", "1", 0]) expect(isCpuTime(bad)).toBe(false);
  });

  it("残りの表示は秒の切り上げ（1 分以上は 分:秒）、色は 10 秒以下で琥珀・5 秒以下で赤", () => {
    expect(clockText(45_000)).toBe("45");
    expect(clockText(44_001)).toBe("45");
    expect(clockText(90_000)).toBe("1:30");
    expect(clockText(60_000)).toBe("1:00");
    expect(clockText(59_001)).toBe("1:00");
    expect(clockText(58_001)).toBe("59");
    expect(clockText(0)).toBe("0");
    expect(clockText(-5)).toBe("0");
    expect(clockLevel(11_000)).toBe("ok");
    expect(clockLevel(10_500)).toBe("ok");
    expect(clockLevel(10_000)).toBe("warn");
    expect(clockLevel(5_001)).toBe("warn");
    expect(clockLevel(5_000)).toBe("danger");
    expect(clockLevel(0)).toBe("danger");
  });
});
