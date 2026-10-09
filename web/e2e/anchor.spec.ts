// 端の駒の力（拠点プリセット）をヘッドレスブラウザで実際に遊んで確かめる。
// CPU 対戦は direction.spec.ts と同じく、ページの Math.random を種付き乱数にして Node 側の「鏡の対局」と照らし合わせる。

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import { createGame, lastMoveOf, playMove, previewMove, viewFor, type MoveEvent, type Preview } from "../src/engine/game";
import { presetById, type PieceKind, type RuleSet } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { pieceLabel, ruleLines, sentenceText } from "../src/ui/ruletext";
import { noHorizontalScroll, openRuleFields, openSettings, openTab, readSetup, rng, saveSettings, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const ANCHOR = presetById("anchor").rules;

const cellAt = (page: Page, r: number, c: number) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
const handBtn = (page: Page, k: PieceKind) => page.locator(`#hand-buttons .piece-btn[data-kind=${k}]`);
const names = (cells: readonly { r: number; c: number }[]) => cells.map(({ r, c }) => cellName(r, c)).sort();
/** 指定のクラスを持つマス（aria-label の先頭が棋譜表記） */
const cellsWith = (page: Page, sel: string) =>
  page.locator(sel).evaluateAll((cs) => cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort());

/** 予測の内訳の文（例: 内訳: 返した駒 2 ＋ 端の金5 ＝ 7） */
const breakdownOf = (r: RuleSet, pv: Preview) =>
  `内訳: 返した駒 ${pv.base}${pv.anchors.map((a) => ` ＋ 端の${pieceLabel(r, a.kind)}`).join("")} ＝ ${pv.damage}`;
/** 棋譜の内訳（例: （返した駒2＋端の金5）） */
const logBreakdownOf = (r: RuleSet, m: MoveEvent) => {
  const anchors = m.anchors ?? [];
  const bonus = anchors.reduce((n, a) => n + r.values[a.kind], 0);
  return `（返した駒${m.damage - bonus}${anchors.map((a) => `＋端の${pieceLabel(r, a.kind)}`).join("")}）`;
};

async function selectPiece(page: Page, kind: PieceKind, touch = false) {
  const btn = handBtn(page, kind);
  if ((await btn.getAttribute("aria-pressed")) !== "true") {
    if (touch) await btn.tap();
    else await btn.click();
  }
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

/** ページの Math.random を種付き乱数（e2e/helpers.ts の rng と同じ mulberry32）にする */
async function seedPage(page: Page, seed: number) {
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

/**
 * 予測中の盤: 赤枠（返す駒）・青枠（端の駒）と「+数字」、狙ったマスの吹き出しの短い内訳（例: 2 ＋ 端5 ＝ 7）、
 * 引き出しの「予測」の内訳の文がエンジンの予測と一致する
 */
async function previewMatches(page: Page, pv: Preview, at: { r: number; c: number }) {
  expect(await cellsWith(page, ".cell.will-take")).toEqual(names(pv.targets.map(([r, c]) => ({ r, c }))));
  expect(await cellsWith(page, ".cell.anchor")).toEqual(names(pv.anchors));
  for (const a of pv.anchors) await expect(cellAt(page, a.r, a.c).locator(".anchor-badge")).toHaveText(`+${ANCHOR.values[a.kind]}`);
  const sum = cellAt(page, at.r, at.c).locator(".pv-bubble .bb-sum");
  if (pv.anchors.length > 0) {
    await expect(sum).toHaveText(`${pv.base}${pv.anchors.map((a) => ` ＋ 端${ANCHOR.values[a.kind]}`).join("")} ＝ ${pv.damage}`);
  } else {
    await expect(sum).toHaveCount(0);
  }
  await expect(page.locator("#preview .breakdown")).toHaveText(breakdownOf(ANCHOR, pv));
}

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("設定メニュー: 端の駒の力の切り替え・ルールカード・URL の復元・不正値・既存プリセットの URL", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await openSettings(page);
    await page.locator(".preset[data-preset=anchor]").click();
    expect(await readSetup(page)).toEqual(ANCHOR);
    await expect(page.locator("#custom-tag")).toHaveText("拠点");
    await openRuleFields(page);
    await expect(page.locator("#setup-rules4 li")).toHaveText(ruleLines(ANCHOR).map(sentenceText));
    await expect(page.locator("#setup-rules4")).toContainText("端の自分の駒もダメージに足す 挟んだ反対端の自分の駒の数字");
    // 保存するとアドレスバーに載る
    await saveSettings(page);
    expect(new URL(page.url()).search.slice(1)).toBe(encodeRules(ANCHOR));
    expect(new URL(page.url()).search).toMatch(/&anc=atk$/);
    await openRuleFields(page);
    await page.locator("#opt-anchor").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/pc-anchor-setup.png` });

    // 「なし」に戻すとカスタム（体力が方向駒と違う）、ルールカードから端の駒の行が消え、URL から anc が消える
    await page.locator("input[name=anchor][value=none]").check({ force: true });
    await expect(page.locator("#custom-tag")).toContainText("カスタム");
    await expect(page.locator("#setup-rules4")).not.toContainText("端の自分の駒");
    await saveSettings(page);
    expect(new URL(page.url()).search).not.toContain("anc");
    // 方向駒に「攻撃に上乗せ」だけ足した設定も再読み込みで復元される
    await openSettings(page);
    await page.locator(".preset[data-preset=dir]").click();
    await saveSettings(page);
    expect(new URL(page.url()).search.slice(1)).toBe(encodeRules(presetById("dir").rules));
    await openRuleFields(page);
    await page.locator("input[name=anchor][value=attack]").check({ force: true });
    await expect(page.locator("#custom-tag")).toContainText("カスタム");
    const custom = await readSetup(page);
    expect(custom).toEqual({ ...presetById("dir").rules, anchor: "attack" });
    await saveSettings(page);
    await page.reload();
    expect(await readSetup(page)).toEqual(custom);

    // 不正な値は URL の基準（v1.0）の値（なし）にして知らせる
    await page.goto("/?anc=bogus&dir=piece");
    await expect(page.locator("#menu-note")).toHaveText("URL の端の駒の力が読めないので、v1.0（取る）の値にしました");
    expect((await readSetup(page)).anchor).toBe("none");
    await expect(page.locator("input[name=anchor][value=none]")).toBeChecked();
    expect(errors).toEqual([]);
  });

  test("拠点: CPU 対戦を終局まで（鏡の対局）。予測の内訳・端の駒の青枠・棋譜の内訳", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const seed = 5;
    await seedPage(page, seed);
    await page.goto("/");
    await startGame(page, { preset: "anchor" });
    await expect(page.locator("#rules4-name")).toHaveText("ルール 拠点");
    await expect(page.locator("#rules4 li")).toHaveText(ruleLines(ANCHOR).map(sentenceText));
    await expect(page.locator("#legend")).toContainText("ダメージに上乗せする端の自分の駒");
    // 端の駒の見本（青枠）は「印」のタブ
    await expect(page.locator("#legend .key-anchor")).toHaveCount(1);

    const rand = rng(seed);
    let s = createGame(ANCHOR);
    let shot = false;
    let multi = 0;
    let humanMoves = 0;
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      await page.mouse.move(0, 0);
      // 予測していないときは青枠を出さない
      await expect(page.locator(".cell.anchor")).toHaveCount(0);
      // 人間役は 2 手読みの最善候補の先頭（王は期限の手で自動）
      const ch = lookaheadCandidates(viewFor(s, 0)).cands[0];
      await selectPiece(page, ch.kind);
      await cellAt(page, ch.r, ch.c).hover();
      const pv = previewMove(s, ch.r, ch.c, ch.kind)!;
      await previewMatches(page, pv, ch);
      await expect(cellAt(page, ch.r, ch.c).locator(".dmg-badge")).toHaveText(String(pv.damage));
      if (pv.anchors.length >= 2) multi++;
      if (!shot && pv.anchors.length >= 2) {
        shot = true;
        await page.screenshot({ path: `${SHOT}/pc-anchor.png` });
      }
      await cellAt(page, ch.r, ch.c).click();
      s = playMove(s, ch.r, ch.c, ch.kind);
      const mine = lastMoveOf(s)!;
      humanMoves++;
      // 着手直後: 端の駒に足した数字が出る。棋譜に内訳
      for (const a of mine.anchors ?? []) await expect(cellAt(page, a.r, a.c).locator(".anchor-pop")).toHaveText(`+${ANCHOR.values[a.kind]}`);
      await expect(page.locator("#log .log-item.move").first()).toContainText(
        `先手 ${pieceLabel(ANCHOR, ch.kind)}→${cellName(ch.r, ch.c)}`,
      );
      await expect(page.locator("#log .log-item.move").first()).toContainText(`${mine.damage}ダメージ${logBreakdownOf(ANCHOR, mine)}`);
      while (!s.result && s.turn === 1) {
        const c = chooseLookahead(viewFor(s, 1), rand)!;
        s = playMove(s, c.r, c.c, c.kind, { king: c.king });
      }
    }
    // 1 手で 2 つ以上の端を足す予測を少なくとも 1 回見た
    expect(multi).toBeGreaterThan(0);
    expect(humanMoves).toBeGreaterThan(5);
    await expect(page.locator("#result-winner")).toHaveText(s.result!.winner === 0 ? "あなたの勝ち" : "CPU の勝ち");
    await expect(page.locator("#result-detail")).toContainText(`${s.ply} 手・ルール 拠点`);
    await page.screenshot({ path: `${SHOT}/pc-anchor-result.png` });
    await page.locator("#result-view").click();
    await openTab(page, "log-panel");
    // 棋譜は CPU の手も含めて全手に内訳が付く
    const moves = s.history.filter((e): e is MoveEvent => e.type === "move").reverse();
    const logs = await page.locator("#log .log-item.move").allTextContents();
    expect(logs).toHaveLength(moves.length);
    logs.forEach((t, i) => expect(t).toContain(`${moves[i].damage}ダメージ${logBreakdownOf(ANCHOR, moves[i])}`));
    await page.screenshot({ path: `${SHOT}/pc-anchor-log.png`, fullPage: true });
    await page.locator("#btn-rules").click();
    await expect(page.locator("#rules")).toContainText("端の駒の力: 反対端の自分の駒もダメージに足す 返した列ごとに、もともと盤上にあって挟むのに使った駒");
    await expect(page.locator("#rules")).toContainText("青枠と「+数字」で示す");
    expect(errors).toEqual([]);
  });
});

test.describe("スマホ幅 375px", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "スマホ幅のみ"));

  test("拠点: 横スクロールなし・盤が最初の画面に入る・タップ 2 回で確定・内訳と青枠・終局まで", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const seed = 11;
    await seedPage(page, seed);
    await page.goto("/");
    await openSettings(page);
    await page.locator(".preset[data-preset=anchor]").tap();
    await openRuleFields(page);
    await page.locator("#opt-anchor").scrollIntoViewIfNeeded();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-anchor-setup.png` });
    await startGame(page);
    await expect(page.locator("#rules4 li")).toHaveText(ruleLines(ANCHOR).map(sentenceText));
    await expect(page.locator("#board")).toBeInViewport({ ratio: 1 });
    await noHorizontalScroll(page, 375);

    const rand = rng(seed);
    let s = createGame(ANCHOR);
    let shot = false;
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      const ch = lookaheadCandidates(viewFor(s, 0)).cands[0];
      await selectPiece(page, ch.kind, true);
      const cell = cellAt(page, ch.r, ch.c);
      const before = await page.locator("#log .log-item.move").count();
      // 1 回目のタップで予測（内訳・青枠）、2 回目で確定
      await cell.tap();
      await expect(page.locator("#preview")).toContainText("もう一度タップ");
      const pv = previewMove(s, ch.r, ch.c, ch.kind)!;
      await previewMatches(page, pv, ch);
      expect(await page.locator("#log .log-item.move").count()).toBe(before);
      await noHorizontalScroll(page, 375);
      if (!shot && pv.anchors.length >= 1 && s.ply >= 4) {
        shot = true;
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${SHOT}/sp-anchor.png` });
        // 文の詳細は引き出しの「予測」タブ（開いてもマスの選択は外れない）
        await openTab(page, "preview");
        await page.locator("#preview").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOT}/sp-anchor-preview.png` });
      }
      await cell.tap();
      s = playMove(s, ch.r, ch.c, ch.kind);
      while (!s.result && s.turn === 1) {
        const c = chooseLookahead(viewFor(s, 1), rand)!;
        s = playMove(s, c.r, c.c, c.kind, { king: c.king });
      }
    }
    expect(shot).toBe(true);
    await expect(page.locator("#result-detail")).toContainText(`${s.ply} 手・ルール 拠点`);
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-anchor-result.png` });
    await page.locator("#result-view").tap();
    await openTab(page, "log-panel");
    await page.locator("#log").scrollIntoViewIfNeeded();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-anchor-log.png` });
    expect(errors).toEqual([]);
  });
});
