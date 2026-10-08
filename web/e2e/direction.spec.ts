// 方向駒（駒ごとに挟める方向が違う）をヘッドレスブラウザで実際に遊んで確かめる。
// CPU 対戦は king.spec.ts と同じく、ページの Math.random を種付き乱数にして Node 側の「鏡の対局」と照らし合わせる。

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import {
  createGame,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
  threatenedPieces,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { kindsByValue, KIND_ORDER, presetById, type PieceKind } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { dirMark, pieceLabel, ruleLines, sentenceText } from "../src/ui/ruletext";
import { noHorizontalScroll, openRuleFields, openSettings, readSetup, rng, saveSettings, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const DIR = presetById("dir").rules;

const cellAt = (page: Page, r: number, c: number) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
const handBtn = (page: Page, k: PieceKind) => page.locator(`#hand-buttons .piece-btn[data-kind=${k}]`);
const names = (cells: readonly (readonly [number, number])[]) => cells.map(([r, c]) => cellName(r, c)).sort();
/** 印（●）の付いたマス・「!」の付いたマス・赤枠の駒（aria-label の先頭が棋譜表記） */
const cellsWith = (page: Page, sel: string) =>
  page.locator(sel).evaluateAll((cs) => cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort());

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

/** 盤上の方向アイコンの種類（マス → 方向）がエンジンの盤面の駒種と一致する */
async function dirIconsMatch(page: Page, s: GameState) {
  const shown = await page.locator(".cell:has(.stone:not(.ghost) .stone-dir)").evaluateAll((cs) =>
    cs.map((c) => `${(c.getAttribute("aria-label") ?? "").split(" ")[0]}:${c.querySelector(".stone-dir")!.getAttribute("data-mark")}`).sort(),
  );
  const want: string[] = [];
  s.board.forEach((row, r) => row.forEach((st, c) => st && want.push(`${cellName(r, c)}:${dirMark(s.rules, st.kind)}`)));
  expect(shown).toEqual(want.sort());
}

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("設定メニュー: 挟める方向・駒種ごとの数と数字・全方向への切り替え・URL の復元・不正値", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await openSettings(page);
    await page.locator(".preset[data-preset=dir]").click();
    expect(await readSetup(page)).toEqual(DIR);
    await expect(page.locator("#custom-tag")).toHaveText("— 方向駒");
    await openRuleFields(page);
    await expect(page.locator("#setup-rules4 li")).toHaveText(ruleLines(DIR).map(sentenceText));
    await expect(page.locator("#setup-rules4")).toContainText("挟めるのは駒の矢印の方向だけ（歩↕ 横↔ 角✕ 飛✚ 金✱）");
    // 駒の表: 6 種。方向は種類で固定（表示のみ）
    await expect(page.locator(".piece-row")).toHaveCount(KIND_ORDER.length);
    await expect(page.locator(".piece-row[data-kind=yoko] .piece-row-dir")).toHaveText("横");
    await expect(page.locator(".piece-row[data-kind=yoko] .piece-row-dir svg")).toHaveAttribute("data-mark", "↔");
    await expect(page.locator(".piece-row[data-kind=kaku] .piece-row-dir")).toHaveAttribute("title", "斜め 4 方向");
    await expect(page.locator("#piece-table")).not.toHaveClass(/dirs-all/);
    await page.locator("#opt-dirs").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/pc-dir-setup.png` });

    // 数字の範囲外は直す。プリセットから外れるとカスタム
    await page.locator("input[name=vkin]").fill("25");
    await page.locator("input[name=vkin]").press("Tab");
    await expect(page.locator("input[name=vkin]")).toHaveValue("20");
    await page.locator("input[name=vfu]").fill("0");
    await page.locator("input[name=vfu]").press("Tab");
    await expect(page.locator("input[name=vfu]")).toHaveValue("1");
    await page.locator("input[name=kaku]").fill("12");
    await page.locator("input[name=kaku]").press("Tab");
    await expect(page.locator("#custom-tag")).toContainText("カスタム");
    await expect(page.locator("#setup-rules4")).toContainText("体力 先手 60・後手 65 が 0 で負け");
    // 保存すると URL に反映され、再読み込みで復元される
    const custom = await readSetup(page);
    expect(custom).toEqual({ ...DIR, values: { ...DIR.values, kin: 20 }, hand: { ...DIR.hand, kaku: 12 } });
    await saveSettings(page);
    expect(new URL(page.url()).search.slice(1)).toBe(encodeRules(custom));
    expect(new URL(page.url()).search).toContain("&dir=piece&yoko=8&kaku=12&vkin=20&vhi=3");
    await page.reload();
    expect(await readSetup(page)).toEqual(custom);
    await openRuleFields(page);

    // 全方向に切り替えると、方向の行が消え、方向の表示が薄くなり、対局では矢印が出ず歩でも 4 マス置ける
    // ラベルを押す（見えない 1px のラジオへの force のクリックは、レイアウトによって別の要素に当たる）
    await page.locator("label:has(> input[name=dirs][value=all])").click();
    await expect(page.locator("input[name=dirs][value=all]")).toBeChecked();
    await expect(page.locator("#piece-table")).toHaveClass(/dirs-all/);
    await expect(page.locator("#setup-rules4")).not.toContainText("矢印");
    await startGame(page);
    await expect(page.locator(".stone-dir")).toHaveCount(0);
    await expect(page.locator("#legend")).not.toContainText("駒が挟める方向");
    await expect(page.locator(".cell.open")).toHaveCount(4);
    await expect(handBtn(page, "kaku")).toBeEnabled();

    // 不正な値は項目ごとに URL の基準（v1.0）の値にして知らせる
    await page.goto("/?dir=diagonal&kaku=99&vfu=0&vkin=5");
    await expect(page.locator("#menu-note")).toHaveText("URL の設定に読めない値があったため、挟める方向・角の数・歩の数字はv1.0（取る）の値にしました。");
    const bad = await readSetup(page);
    expect([bad.dirs, bad.hand.kaku, bad.values.fu, bad.values.kin]).toEqual(["all", 0, 1, 5]);
    expect(errors).toEqual([]);
  });

  test("方向駒: CPU 対戦を終局まで（鏡の対局）。駒の切り替えで印が変わる・矢印・予測・「!」が方向どおり", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const seed = 3;
    await seedPage(page, seed);
    await page.goto(`/?${encodeRules(DIR)}`);
    await startGame(page);
    await expect(page.locator("#rules4 li")).toHaveText(ruleLines(DIR).map(sentenceText));
    await expect(page.locator("#rules4-name")).toHaveText("ルール — 方向駒");
    await expect(page.locator("#legend")).toContainText("↕↔✕✚✱ 駒が挟める方向");
    // 持ち駒のボタンにも方向のアイコン（数字の小さい順: 歩 横 角 飛 金）
    const order = await page.locator("#hand-buttons .piece-btn").evaluateAll((bs) =>
      bs.map((b) => `${b.getAttribute("data-kind")}:${b.querySelector(".stone-dir")?.getAttribute("data-mark")}`),
    );
    expect(order).toEqual(kindsByValue(DIR, ["fu", "yoko", "kaku", "hi", "kin"]).map((k) => `${k}:${dirMark(DIR, k)}`));
    await expect(handBtn(page, "kin")).toHaveAttribute("aria-label", "金（数字 5・全 8 方向に挟める）残り 4 個");
    // 初手: 角は斜めに挟める所がないので押せない
    await expect(handBtn(page, "kaku")).toBeDisabled();
    // 置けない駒は斜線（理由は読み上げと title）
    await expect(handBtn(page, "kaku")).toHaveClass(/\bblocked\b/);
    await expect(handBtn(page, "kaku")).toHaveAttribute("aria-label", /（置けるマスなし）$/);

    const rand = rng(seed);
    let s = createGame(DIR);
    let turns = 0;
    let sawSwitch = false;
    let sawThreat = false;
    let shot = false;
    let marksShot = false;
    const usedKinds = new Set<PieceKind>();
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      // マウスを盤の外に出して予測を消してから比べる
      await page.mouse.move(0, 0);
      await dirIconsMatch(page, s);
      // 「!」= 相手（CPU）の持ち駒の方向で次の 1 手で返されうる自分の駒
      const threat = names(threatenedPieces(s, 0));
      expect(await cellsWith(page, ".cell:has(.threat)")).toEqual(threat);
      if (threat.length > 0) sawThreat = true;

      // 置ける駒を切り替えると、印（●）のマスがその駒の方向で返せるマスに変わる
      const kinds = kindsByValue(DIR, playableKinds(s));
      const sets = new Map<PieceKind, string>();
      for (const k of turns < 4 ? kinds : []) {
        await selectPiece(page, k);
        const want = names(legalCells(s, k));
        expect(await cellsWith(page, ".cell.open")).toEqual(want);
        sets.set(k, want.join(","));
      }
      if (new Set(sets.values()).size > 1) sawSwitch = true;
      if (!marksShot && sets.has("yoko") && new Set(sets.values()).size >= 3) {
        // 横を選んだときの印（他の駒とは違うマス）
        marksShot = true;
        await selectPiece(page, "yoko");
        await page.screenshot({ path: `${SHOT}/pc-dir-marks.png` });
      }

      // 人間役は 2 手読みの最善候補の先頭（王は期限の手で自動）
      const ch = lookaheadCandidates(viewFor(s, 0)).cands[0];
      await selectPiece(page, ch.kind);
      await cellAt(page, ch.r, ch.c).hover();
      const pv = previewMove(s, ch.r, ch.c, ch.kind)!;
      await expect(page.locator("#preview .label")).toContainText(`${pieceLabel(DIR, ch.kind)}${dirMark(DIR, ch.kind)} を`);
      expect(await cellsWith(page, ".cell.will-take")).toEqual(names(pv.targets));
      if (pv.damage > 0) await expect(cellAt(page, ch.r, ch.c).locator(".dmg-badge")).toHaveText(String(pv.damage));
      // 予測中の「!」は、置いた後に相手の持ち駒の方向で返されうる自分の駒
      expect(await cellsWith(page, ".cell:has(.threat)")).toEqual(names(pv.exposed));
      if (!shot && turns >= 2 && pv.targets.length > 0) {
        shot = true;
        await page.screenshot({ path: `${SHOT}/pc-dir.png` });
      }
      await cellAt(page, ch.r, ch.c).click();
      s = playMove(s, ch.r, ch.c, ch.kind);
      usedKinds.add(ch.kind);
      turns++;
      await expect(page.locator("#log .log-item.move").first()).toContainText(`先手 ${pieceLabel(DIR, ch.kind)}→${cellName(ch.r, ch.c)}`);
      // CPU の手番を鏡の対局で進める（同じ種なので同じ手になる）
      while (!s.result && s.turn === 1) {
        const c = chooseLookahead(viewFor(s, 1), rand)!;
        s = playMove(s, c.r, c.c, c.kind, { king: c.king });
        usedKinds.add(c.kind);
      }
    }
    expect(sawSwitch).toBe(true);
    expect(sawThreat).toBe(true);
    expect(shot).toBe(true);
    expect(marksShot).toBe(true);
    expect(usedKinds.size).toBeGreaterThanOrEqual(4);
    await expect(page.locator("#result-winner")).toHaveText(s.result!.winner === 0 ? "あなたの勝ち" : "CPU の勝ち");
    await expect(page.locator("#result-detail")).toContainText("ルール 方向駒");
    await expect(page.locator("#result-detail .score-foot")).toHaveText(`${s.ply} 手・ルール 方向駒・CPU ノーマル・1 手 45 秒`);
    await page.screenshot({ path: `${SHOT}/pc-dir-result.png` });
    await page.locator("#result-view").click();
    await dirIconsMatch(page, s);
    // 棋譜の件数（パスを含む）も鏡の対局と同じ
    await expect(page.locator("#log .log-item")).toHaveCount(s.history.length);
    expect(errors).toEqual([]);
  });

  test("方向で返せないマスを押すと、選んだ駒の方向を添えて知らせる", async ({ page }) => {
    await page.goto(`/?${encodeRules(DIR)}`);
    await startGame(page);
    // 初手: c4 は横なら返せるが、歩（縦）では返せない
    await selectPiece(page, "fu");
    await cellAt(page, 3, 2).click();
    await expect(page.locator("#toast")).toHaveText("c4 に 歩1 を置いても返せる駒がありません（歩は↕ 縦（上下）だけ挟める。● のマスに置けます）");
    await expect(page.locator("#log .log-item")).toHaveCount(0);
    await selectPiece(page, "yoko");
    await expect(cellAt(page, 3, 2)).toHaveClass(/open/);
  });
});

test.describe("スマホ幅 375px", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "スマホ幅のみ"));

  test("方向駒: 設定画面と対局画面に横スクロールなし・盤が最初の画面に入る・タップ 2 回で確定・終局まで", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // CPU の手を毎回同じにする
    await seedPage(page, 1);
    await page.goto("/");
    await openSettings(page);
    await page.locator(".preset[data-preset=dir]").tap();
    await openRuleFields(page);
    await page.locator("#piece-table").scrollIntoViewIfNeeded();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-dir-setup.png` });
    await startGame(page);
    await expect(page.locator("#rules4 li")).toHaveText(ruleLines(DIR).map(sentenceText));
    await expect(page.locator("#board")).toBeInViewport({ ratio: 1 });
    await noHorizontalScroll(page, 375);
    // 持ち駒 5 種が 1 行に並ぶ
    // 行はレイアウトの位置で比べる（選んだ駒は transform で持ち上がるので見た目の上端はずれる）
    const tops = await page.locator("#hand-buttons .piece-btn").evaluateAll((bs) => bs.map((b) => (b as HTMLElement).offsetTop));
    expect(new Set(tops).size).toBe(1);

    // 横を選ぶと印は横に挟める 2 マス。1 回目のタップで予測、2 回目で確定
    await selectPiece(page, "yoko", true);
    expect(await cellsWith(page, ".cell.open")).toEqual(["c4", "f5"]);
    await cellAt(page, 3, 2).tap();
    await expect(page.locator("#preview .label")).toContainText("c4 に 横1↔ を置くと");
    await expect(page.locator("#preview")).toContainText("もう一度タップ");
    await expect(page.locator(".cell.will-take")).toHaveCount(1);
    await page.screenshot({ path: `${SHOT}/sp-dir.png` });
    await expect(page.locator("#log .log-item")).toHaveCount(0);
    await cellAt(page, 3, 2).tap();
    await expect(page.locator("#log .log-item.move")).toHaveCount(1);
    await expect(page.locator("#log .log-item.move").first()).toContainText("先手 横1→c4");

    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      const take = page.locator(".cell.can-take");
      const cell = (await take.count()) > 0 ? take.first() : page.locator(".cell.open").first();
      const before = await page.locator("#log .log-item.move").count();
      await cell.tap();
      await expect(page.locator("#preview")).toContainText("もう一度タップ");
      expect(await page.locator("#log .log-item.move").count()).toBe(before);
      await cell.tap();
      await noHorizontalScroll(page, 375);
    }
    await expect(page.locator("#result-reason")).toHaveText(/体力が 0 になった|打てる手がなくなった/);
    await page.screenshot({ path: `${SHOT}/sp-dir-result.png` });
    await noHorizontalScroll(page, 375);
    await page.locator("#result-view").tap();
    await page.locator("#btn-rules").tap();
    await expect(page.locator("#rules")).toContainText("挟める方向は駒ごとに違う");
    await expect(page.locator("#rules")).toContainText(`歩1↕ ×8・横1↔ ×8・角3✕ ×6・飛3✚ ×6・金5✱ ×4`);
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-dir-rules.png` });
    expect(errors).toEqual([]);
  });
});
