// 普通のオセロなら置けるマス（参考の点線の枠）をヘッドレスブラウザで確かめる。
// 駒ごとの「置くと返せるマス」（中央の丸）と別に出ること・重なるマスで両方見えること・操作できる人の手番だけに出ること

import { expect, test, type Page } from "@playwright/test";
import { cellName, emptyCells, othelloCells, SIZE, type Board } from "../src/engine/board";
import { createGame, legalCells, playMove } from "../src/engine/game";
import { presetById, type PieceKind, type Player, type RuleSet } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { greedy, noHorizontalScroll, play, seedPage, startGame } from "./helpers";

const SHOT = "screenshots";
const STD = presetById("std").rules;

const handBtn = (page: Page, k: PieceKind) => page.locator(`#hand-buttons .piece-btn[data-kind=${k}]`);
const names = (cells: readonly (readonly [number, number])[]) => cells.map(([r, c]) => cellName(r, c)).sort();
/** 指定のクラスを持つマス（aria-label の先頭が棋譜表記） */
const marked = (page: Page, sel: string) =>
  page.locator(sel).evaluateAll((cs) => cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort());

/** 画面の盤（石の持ち主と種類。予測の半透明の駒は除く） */
async function boardOfPage(page: Page): Promise<Board> {
  const stones = await page.locator(".cell").evaluateAll((cs) =>
    cs.map((c) => {
      const s = c.querySelector(".stone:not(.ghost)");
      if (!s) return null;
      const kind = [...s.classList].find((k) => k.startsWith("k-"))!.slice(2);
      return { owner: s.classList.contains("p0") ? 0 : 1, kind, r: Number(c.getAttribute("data-r")), col: Number(c.getAttribute("data-c")) };
    }),
  );
  const b: Board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const s of stones) if (s) b[s.r][s.col] = { owner: s.owner as Player, kind: s.kind as PieceKind };
  return b;
}

/**
 * 盤の描き直しのたびに「操作できない（.acting なし）のに枠が出ている」を記録する。
 * render は同期で盤とマスのクラスをまとめて変えるので、MutationObserver の時点で一貫している
 */
async function watchIdleMarks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __idleMarks: number; __idleClean: number };
    w.__idleMarks = 0;
    w.__idleClean = 0;
    const board = document.querySelector(".board")!;
    new MutationObserver(() => {
      if (board.classList.contains("acting")) return;
      if (board.querySelector(".cell.othello")) w.__idleMarks++;
      else w.__idleClean++;
    }).observe(board, { attributes: true, subtree: true, attributeFilter: ["class"] });
  });
}
const idleMarks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __idleMarks: number; __idleClean: number };
    return { marks: w.__idleMarks, clean: w.__idleClean };
  });

/** 操作できる手番の枠が、画面の盤から計算した普通のオセロの合法手と一致することを確かめる。合法手の数を返す */
async function expectOthelloMarks(page: Page, p: Player): Promise<number> {
  await expect(page.locator(".board.acting")).toBeVisible();
  const want = names(othelloCells(await boardOfPage(page), p));
  expect(await marked(page, ".cell.othello")).toEqual(want);
  // 枠は空きマスだけ
  await expect(page.locator(".cell.othello .stone:not(.ghost)")).toHaveCount(0);
  return want.length;
}

const boardSnapshot = (page: Page) =>
  page.locator(".cell").evaluateAll((cs) => cs.map((c) => c.querySelector(".stone:not(.ghost)")?.className ?? "").join("|"));

/** 人間の手番で、置けるマス（.open）の最初に置く。置いた後は操作できない状態を待たない */
async function playFirstOpen(page: Page, touch: boolean) {
  const cell = page.locator(".cell.open").first();
  if (touch) {
    await cell.tap();
    await cell.tap();
  } else {
    await cell.click();
  }
}

/** CPU 対戦を終局まで打ち、人間の手番ごとに枠を確かめる。各手番の合法手の数と空きマスの数を返す */
async function playCpuGame(page: Page, touch: boolean, shotAt?: (n: number, empties: number) => string | null) {
  const turns: { othello: number; empties: number }[] = [];
  for (let i = 0; i < 80; i++) {
    await page.waitForFunction(() => !!document.querySelector("#result[open]") || !!document.querySelector(".board.acting"), undefined, {
      timeout: 30_000,
    });
    if (await page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open)) return turns;
    const othello = await expectOthelloMarks(page, 0);
    const empties = await page.locator(".cell:not(:has(.stone))").count();
    turns.push({ othello, empties });
    const shot = shotAt?.(othello, empties);
    if (shot) await page.locator(".board").screenshot({ path: shot });
    const before = await boardSnapshot(page);
    await playFirstOpen(page, touch);
    // 相手がパスして続けて自分の手番になることもあるので、盤が変わるのを待つ
    await expect.poll(() => boardSnapshot(page)).not.toBe(before);
  }
  throw new Error("終局しなかった");
}

test.describe("普通のオセロなら置けるマス", () => {
  test("標準・CPU 対戦: 駒ごとの丸とオセロの枠が別々に出る・重なるマスは両方・CPU の手番は出ない・終局まで一致", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const pre = info.project.name === "desktop" ? "pc" : "sp";
    const touch = !!info.project.use.hasTouch;
    const width = info.project.use.viewport!.width;
    // 既定（標準）のまま始める。CPU の手は種付き乱数で毎回同じにする
    await seedPage(page, 1);
    await page.goto("/");
    await startGame(page);
    await expect(page.locator("#rules4-name")).toHaveText(`ルール — ${presetById("std").name}`);
    await watchIdleMarks(page);

    // 初期配置: 歩（縦だけ）で置けるのは d3・e6、オセロなら c4・d3・e6・f5
    const g = createGame(STD);
    await expect(handBtn(page, "fu")).toHaveAttribute("aria-pressed", "true");
    expect(names(legalCells(g, "fu"))).toEqual(["d3", "e6"]);
    expect(await marked(page, ".cell.can-take")).toEqual(["d3", "e6"]);
    expect(await marked(page, ".cell.othello")).toEqual(["c4", "d3", "e6", "f5"]);
    // 重なるマス（d3・e6）は丸と枠の両方、オセロだけのマス（c4・f5）は枠だけで置けない
    expect(await marked(page, ".cell.othello.can-take")).toEqual(["d3", "e6"]);
    expect(await marked(page, ".cell.othello:not(.open)")).toEqual(["c4", "f5"]);
    await expect(page.locator(".cell.othello").first()).toHaveCSS("outline-style", "dashed");
    await expect(page.locator('.cell[aria-label="c4 オセロなら置ける"]')).toHaveCount(1);
    await expect(page.locator('.cell[aria-label="d3 置くと返せる オセロなら置ける"]')).toHaveCount(1);
    await expect(page.locator("#legend")).toContainText("普通のオセロなら置けるマス");
    await page.screenshot({ path: `${SHOT}/${pre}-othello-std.png` });
    await page.locator(".board").screenshot({ path: `${SHOT}/${pre}-othello-board.png` });
    await noHorizontalScroll(page, width);

    // 隠し王: 王にして置く予測の駒（王の印）が枠のマスに出ても、枠と王の印の両方が見える
    const king = page.locator("#king-toggle");
    if (touch) await king.tap();
    else await king.click();
    await expect(king).toHaveAttribute("aria-pressed", "true");
    const d3 = page.locator('.cell[data-r="2"][data-c="3"]');
    if (touch) await d3.tap();
    else await d3.hover();
    await expect(page.locator(".cell.othello.focus .ghost .king-mark")).toBeVisible();
    await expect(d3).toHaveCSS("outline-style", "dashed");
    await page.locator(".board").screenshot({ path: `${SHOT}/${pre}-othello-king.png` });
    if (touch) await king.tap();
    else await king.click();
    await expect(king).toHaveAttribute("aria-pressed", "false");

    // 横（横だけ）に選び替えると丸は c4・f5 に移り、枠は変わらない
    if (touch) await handBtn(page, "yoko").tap();
    else await handBtn(page, "yoko").click();
    expect(await marked(page, ".cell.can-take")).toEqual(["c4", "f5"]);
    expect(await marked(page, ".cell.othello")).toEqual(["c4", "d3", "e6", "f5"]);
    await page.locator(".board").screenshot({ path: `${SHOT}/${pre}-othello-board-yoko.png` });

    // 置いた後の CPU の手番は枠を出さない
    const c4 = page.locator('.cell[data-r="3"][data-c="2"]');
    if (touch) {
      await c4.tap();
      await c4.tap();
    } else {
      await c4.click();
    }
    await expect(page.locator("#status")).toContainText("が考えています");
    await expect(page.locator(".cell.othello")).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/${pre}-othello-cpu-turn.png` });

    // 終局まで、人間の手番ごとに枠 = 画面の盤のオセロの合法手
    const turns = await playCpuGame(page, touch);
    expect(turns.length).toBeGreaterThan(3);
    await expect(page.locator("#result")).toBeVisible();
    await expect(page.locator(".cell.othello")).toHaveCount(0);
    const idle = await idleMarks(page);
    expect(idle.marks).toBe(0);
    expect(idle.clean).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("2 人対戦: 手番の人の色で枠が変わる", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const pre = info.project.name === "desktop" ? "pc" : "sp";
    const touch = !!info.project.use.hasTouch;
    await page.goto("/");
    await startGame(page, { mode: "pvp" });
    await watchIdleMarks(page);
    for (let ply = 0; ply < 4; ply++) {
      const p: Player = ply % 2 === 0 ? 0 : 1;
      await expect(page.locator(`#player-${p}`)).toHaveClass(/active/);
      const n = await expectOthelloMarks(page, p);
      expect(n).toBeGreaterThan(0);
      if (ply === 1) {
        // 後手の初手: 後手の色で見た合法手（先手の c4 の後なら c3・c5・e3 など）
        expect(await marked(page, ".cell.othello")).toEqual(names(othelloCells(await boardOfPage(page), 1)));
        await page.screenshot({ path: `${SHOT}/${pre}-othello-pvp-white.png` });
      }
      await playFirstOpen(page, touch);
      await expect(page.locator(`#player-${p === 0 ? 1 : 0}`)).toHaveClass(/active/);
    }
    expect((await idleMarks(page)).marks).toBe(0);
    expect(errors).toEqual([]);
  });

  test("取る（v1.0）: 空きマスならどこにでも置けるが、オセロの合法手がない手番は枠を出さない", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const pre = info.project.name === "desktop" ? "pc" : "sp";
    const touch = !!info.project.use.hasTouch;
    const v10: RuleSet = presetById("v10").rules;
    await seedPage(page, 1);
    await page.goto(`/?${encodeRules(v10)}`);
    await startGame(page);
    await watchIdleMarks(page);
    let shot = false;
    // 置けるマスの最初（左上から）に置き続けると、盤の上側に孤立した駒が並び、オセロの合法手がない手番が出る
    const turns = await playCpuGame(page, touch, (n) => {
      if (n > 0 || shot) return null;
      shot = true;
      return `${SHOT}/${pre}-othello-none.png`;
    });
    expect(turns.some((t) => t.othello === 0)).toBe(true);
    expect((await idleMarks(page)).marks).toBe(0);
    expect(errors).toEqual([]);
  });

  test("盤が埋まるまで（2 人対戦・鏡の対局）: 残り数マスでも枠が合法手と一致し、埋まったら出ない", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const pre = info.project.name === "desktop" ? "pc" : "sp";
    const touch = !!info.project.use.hasTouch;
    // ダメージの小さい v0.4 を体力 200・手数の上限なしにすると、両者が返す駒の最も多い手を打てば盤が埋まる
    const rules: RuleSet = { ...presetById("v04").rules, hp: [200, 200], maxPlies: 0 };
    await page.goto(`/?${encodeRules(rules)}`);
    await startGame(page, { mode: "pvp" });
    let s = createGame(rules);
    let shot = false;
    while (!s.result) {
      await expect(page.locator(`#player-${s.turn}`)).toHaveClass(/active/);
      expect(await expectOthelloMarks(page, s.turn)).toBe(othelloCells(s.board, s.turn).length);
      const empties = emptyCells(s.board).length;
      if (empties <= 4 && !shot) {
        shot = true;
        await page.locator(".board").screenshot({ path: `${SHOT}/${pre}-othello-full.png` });
      }
      const m = greedy(s);
      await play(page, m.r, m.c, m.kind, touch);
      s = playMove(s, m.r, m.c, m.kind);
    }
    expect(emptyCells(s.board)).toEqual([]);
    expect(shot).toBe(true);
    await expect(page.locator(".cell.othello")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
