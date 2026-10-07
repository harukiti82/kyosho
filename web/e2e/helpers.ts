// e2e の共通ヘルパー（メニュー・設定メニューの操作・着手・待ち合わせ・横スクロールの確認・種付き乱数・鏡の対局の手）

import { expect, type Page } from "@playwright/test";
import type { CpuLevel } from "../src/engine/cpu";
import { lastMoveOf, legalCells, playableKinds, playMove, type GameState } from "../src/engine/game";
import { KIND_ORDER, type PieceKind, type PresetId, type RuleSet } from "../src/engine/rules";

export async function noHorizontalScroll(page: Page, width: number) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

/** 設定メニューを開く（開いていれば何もしない）。メニューの「設定」から開く */
export async function openSettings(page: Page) {
  if (await page.locator("#setup").isVisible()) return;
  await expect(page.locator("#menu")).toBeVisible();
  await page.locator("#menu-settings").click();
  await expect(page.locator("#setup")).toBeVisible();
}

/** 設定メニューの「保存」 */
export async function saveSettings(page: Page) {
  await page.locator("#setup-save").click();
  await expect(page.locator("#setup")).toBeHidden();
}

/** 設定メニューのフォームから読んだ設定（閉じていれば開く） */
export async function readSetup(page: Page): Promise<RuleSet> {
  await openSettings(page);
  return page.locator("#setup-form").evaluate((form: HTMLFormElement, kinds) => {
    const f = new FormData(form);
    const n = (k: string) => Number((form.elements.namedItem(k) as HTMLInputElement).value);
    return {
      action: f.get("action"),
      gate: f.get("gate") === "1",
      dirs: f.get("dirs"),
      damage: f.get("damage"),
      anchor: f.get("anchor"),
      heal: f.get("heal"),
      hp: [n("hp0"), n("hp1")],
      hand: Object.fromEntries(kinds.map((k) => [k, n(k)])),
      values: Object.fromEntries(kinds.map((k) => [k, n(`v${k}`)])),
      maxPlies: n("maxPlies"),
      king: { on: f.get("king") === "1", penalty: f.get("kingPenalty"), amount: n("kingAmount"), deadline: n("kingDeadline") },
    } as unknown as RuleSet;
  }, [...KIND_ORDER]);
}

/**
 * 対局を始める。preset・side の指定があれば設定メニューで選んで保存し、設定メニューが開いていれば（フォームを変えた後なら）保存してから、
 * メニューの CPU対戦 → 強さ（既定はノーマル）／マルチ → この端末で 2 人 で始める
 */
export async function startGame(
  page: Page,
  opts: { mode?: "cpu" | "pvp"; side?: 0 | 1 | "random"; preset?: PresetId; level?: CpuLevel } = {},
) {
  const mode = opts.mode ?? "cpu";
  if (opts.preset || (mode === "cpu" && opts.side !== undefined)) {
    await openSettings(page);
    if (opts.preset) await page.locator(`.preset[data-preset=${opts.preset}]`).click();
    if (mode === "cpu" && opts.side !== undefined) {
      // ラベルを押す（スマホ幅では隠れた input への直接のクリックが効かない）
      await page.locator(`label:has(> input[name=side][value="${opts.side}"])`).click();
      await expect(page.locator(`input[name=side][value="${opts.side}"]`)).toBeChecked();
    }
  }
  if (await page.locator("#setup").isVisible()) await saveSettings(page);
  await expect(page.locator("#menu")).toBeVisible();
  if (mode === "cpu") {
    await page.locator("#menu-cpu").click();
    await page.locator(`#menu-levels [data-level=${opts.level ?? "normal"}]`).click();
  } else {
    await page.locator("#menu-multi").click();
    await page.locator("#menu-pvp").click();
  }
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator("#game")).toBeVisible();
}

/** 設定メニューの「ルールを細かく変える」を開く（設定メニューが閉じていれば開く。開いていれば何もしない） */
export async function openRuleFields(page: Page) {
  await openSettings(page);
  const details = page.locator("#rule-details");
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
}

/** 引き出しのタブを開く（開いていれば何もしない）。id はタブが開くパネル（rules4 / preview / log-panel / legend-box） */
export async function openTab(page: Page, id: string) {
  const tab = page.locator(`#tab-${id}`);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** 人間の手番（盤を操作できる）か終局画面のどちらかになるまで待つ。終局なら true */
export async function waitHumanTurnOrEnd(page: Page): Promise<boolean> {
  await page.waitForFunction(
    () => !!document.querySelector("#result[open]") || !!document.querySelector(".board.acting"),
    undefined,
    { timeout: 30_000 },
  );
  return page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open);
}

/** 種付き乱数（mulberry32） */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ページの Math.random を種付き乱数（rng と同じ mulberry32）にする。page.goto の前に呼ぶ */
export async function seedPage(page: Page, seed: number) {
  await page.addInitScript((s) => {
    let a = s >>> 0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, seed);
}

export const cellAt = (page: Page, r: number, c: number) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);

/** 人間の手。マウスは 1 回、タッチは 1 回目で予測・2 回目で確定 */
export async function play(page: Page, r: number, c: number, kind: PieceKind, touch: boolean) {
  const btn = page.locator(`#hand-buttons .piece-btn[data-kind=${kind}]`);
  if ((await btn.getAttribute("aria-pressed")) !== "true") {
    if (touch) await btn.tap();
    else await btn.click();
  }
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  const cell = cellAt(page, r, c);
  if (touch) {
    await cell.tap();
    await cell.tap();
  } else {
    await cell.click();
  }
}

/** 返す駒が最も多い手（同じなら先に見つけた手） */
export function greedy(s: GameState) {
  let best: { r: number; c: number; kind: PieceKind; n: number } | null = null;
  for (const kind of playableKinds(s)) {
    for (const [r, c] of legalCells(s, kind)) {
      const n = lastMoveOf(playMove(s, r, c, kind))!.targets.length;
      if (!best || n > best.n) best = { r, c, kind, n };
    }
  }
  return best!;
}
