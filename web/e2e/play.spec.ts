// ヘッドレスブラウザで実際に対局して画面遷移と表示を確かめる。
// スクリーンショットは web/screenshots/ に保存する。

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { availableKinds, createGame, playMove, threatenedPieces, type GameState } from "../src/engine/game";
import { KIND_ORDER, type PieceKind } from "../src/engine/rules";

const SHOT = "screenshots";

async function noHorizontalScroll(page: Page, width: number) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

async function startGame(page: Page, opts: { mode?: "cpu" | "pvp"; side?: 0 | 1 } = {}) {
  await expect(page.locator("#setup")).toBeVisible();
  await page.locator(`input[name=mode][value=${opts.mode ?? "cpu"}]`).check();
  if ((opts.mode ?? "cpu") === "cpu") await page.locator(`input[name=side][value="${opts.side ?? 0}"]`).check();
  await page.locator("#setup-start").click();
  await expect(page.locator("#setup")).toBeHidden();
}

/** 盤の 64 マスがすべて同じ大きさ（中身の印やバッジで行の高さが変わらない） */
async function cellsUniform(page: Page) {
  const sizes = await page.locator(".cell").evaluateAll((cs) =>
    cs.map((c) => {
      const r = c.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }),
  );
  const [w, h] = sizes[0];
  for (const [cw, ch] of sizes) expect([Math.abs(cw - w) <= 1, Math.abs(ch - h) <= 1]).toEqual([true, true]);
}

/** 4 行ルールが画面内に表示されている */
async function rulesVisible(page: Page) {
  const items = page.locator("#rules4 li");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText("空いているマスならどこにでも");
  await expect(items.nth(1)).toContainText("自分の持ち駒にする");
  await expect(items.nth(2)).toContainText("取った駒の数字の合計");
  await expect(items.nth(3)).toContainText("0 で負け");
  await expect(page.locator("#rules4")).toBeInViewport({ ratio: 1 });
}

/** 人間の手番（盤を操作できる）か終局画面のどちらかになるまで待つ。終局なら true */
async function waitHumanTurnOrEnd(page: Page): Promise<boolean> {
  await page.waitForFunction(
    () => !!document.querySelector("#result[open]") || !!document.querySelector(".board.acting"),
    undefined,
    { timeout: 30_000 },
  );
  return page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open);
}

const boardSnapshot = (page: Page) =>
  page.locator(".cell").evaluateAll((cells) => cells.map((c) => c.getAttribute("aria-label")).join("|"));
const stoneCount = (page: Page) => page.locator(".board .stone:not(.ghost)").count();
const cellAt = (page: Page, r: number, c: number) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
const handBtn = (page: Page, k: PieceKind) => page.locator(`#hand-buttons .piece-btn[data-kind=${k}]`);

/** 持ち駒を選ぶ（選択中なら何もしない） */
async function selectPiece(page: Page, kind: PieceKind, touch = false) {
  const btn = handBtn(page, kind);
  if ((await btn.getAttribute("aria-pressed")) === "true") return;
  if (touch) await btn.tap();
  else await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

/**
 * 取れるマスがあればそこへ、なければ先頭の空きマスへ置く。
 * touch なら 1 回目のタップで予測を確かめてから 2 回目で確定する
 */
async function humanMove(page: Page, touch: boolean) {
  const take = page.locator(".cell.can-take");
  const cell = (await take.count()) > 0 ? take.first() : page.locator(".cell.open").first();
  const before = await stoneCount(page);
  if (touch) {
    await cell.tap();
    // 1 回目のタップでは置かれず、予測が出る
    await expect(page.locator("#preview")).toContainText(/ダメージ|取れる駒なし/);
    await expect(page.locator("#preview")).toContainText("もう一度タップ");
    expect(await stoneCount(page)).toBe(before);
    await cell.tap();
  } else {
    await cell.hover();
    await expect(page.locator("#preview")).toContainText(/ダメージ|取れる駒なし/);
    await cell.click();
  }
}

/** 終局後: 盤面を見る → マスをクリックしても何も変わらない */
async function checkBoardFrozen(page: Page, touch = false) {
  if (touch) await page.locator("#result-view").tap();
  else await page.locator("#result-view").click();
  await expect(page.locator("#result")).toBeHidden();
  const snap = await boardSnapshot(page);
  const status = await page.locator("#status").textContent();
  for (const i of [0, 19, 63]) await page.locator(".cell").nth(i).click({ force: true });
  expect(await boardSnapshot(page)).toBe(snap);
  await expect(page.locator("#status")).toHaveText(status!);
  await expect(page.locator("#result")).toBeHidden();
}

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("CPU 対戦（先手）: 予測・取り・持ち駒の増加・警告を見て終局まで進む", async ({ page }) => {
    await page.goto("/");
    await page.screenshot({ path: `${SHOT}/pc-setup.png` });
    await startGame(page);
    await rulesVisible(page);
    await expect(page.locator("#player-0 .hp-num")).toHaveText("20");
    await expect(page.locator("#player-1 .hp-max")).toHaveText("/ 20");
    await expect(page.locator("#ply")).toHaveText("手数 0 / 80");
    await expect(handBtn(page, "fu")).toContainText("×8");
    await expect(handBtn(page, "kin")).toContainText("×4");
    await expect(handBtn(page, "hi")).toContainText("×2");
    // 最初は歩が選ばれている
    await expect(handBtn(page, "fu")).toHaveAttribute("aria-pressed", "true");
    // 空きマスはどこでも置ける（60 マス）。取れるマスには印（初手は 4 つ）
    await expect(page.locator(".cell.open")).toHaveCount(60);
    await expect(page.locator(".cell.can-take")).toHaveCount(4);

    // 取れないマス: 「取れる駒なし」とだけ出る
    await cellAt(page, 0, 0).hover();
    await expect(page.locator("#preview .preview-main")).toHaveText("取れる駒なし");
    await expect(page.locator(".cell.will-take")).toHaveCount(0);
    await expect(page.locator(".dmg-badge")).toHaveCount(0);

    // 飛を選んで取れるマスにホバー: 取れる駒のハイライトとダメージ数
    await selectPiece(page, "hi");
    const take = page.locator(".cell.can-take").first();
    await take.hover();
    await expect(page.locator(".cell.will-take")).toHaveCount(1);
    await expect(page.locator(".dmg-badge")).toHaveText("1");
    await expect(page.locator("#preview .preview-main")).toHaveText("歩1 を取る → 1 ダメージ");
    await expect(page.locator("#preview")).toContainText("飛5 を置くと");
    await page.screenshot({ path: `${SHOT}/pc-preview.png` });

    // 置く: 取った歩が飛んでいき、持ち駒の歩が 8 → 9 に増え、相手の体力が 19 に
    await take.click();
    await expect(page.locator(".flyer").first()).toBeAttached();
    await expect(page.locator(".dmg-pop")).toHaveText("1 ダメージ");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOT}/pc-capture.png` });
    await expect(handBtn(page, "fu")).toContainText("×9");
    await expect(handBtn(page, "hi")).toContainText("×1");
    await expect(page.locator("#player-0 .mini[data-kind=fu]")).toContainText("×9");
    await expect(page.locator("#player-1 .hp-num")).toHaveText("19");
    await expect(page.locator("#player-1 .delta")).toHaveText("−1");
    await expect(page.locator("#log .log-item").first()).toHaveText(/^1先手 飛5→[a-h][1-8] 歩1を取った 1ダメージ$/);
    await expect(page.locator("#ply")).toHaveText("手数 1 / 80");
    await expect(page.locator(".flyer")).toHaveCount(0);

    let sawThreat = false;
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      if (!sawThreat && (await page.locator(".cell .threat").count()) > 0) {
        sawThreat = true;
        // 警告マークは自分（先手＝黒）の駒にだけ付く
        const labels = await page.locator(".cell:has(.threat)").evaluateAll((cs) => cs.map((c) => c.getAttribute("aria-label")));
        for (const l of labels) expect(l).toMatch(/先手の.*取られうる/);
        await page.screenshot({ path: `${SHOT}/pc-threat.png` });
        await cellsUniform(page);
      }
      await humanMove(page, false);
    }
    expect(sawThreat).toBe(true);
    await expect(page.locator("#result-winner")).toHaveText(/あなたの勝ち|CPU の勝ち|引き分け/);
    await expect(page.locator("#result-reason")).toHaveText(/体力 0|手に達して打ち切り|持ち駒が尽きて終局/);
    await page.screenshot({ path: `${SHOT}/pc-result.png` });
    await checkBoardFrozen(page);

    // 再戦で初期状態に戻る
    await page.locator("#btn-rematch").click();
    await expect(page.locator("#player-0 .hp-num")).toHaveText("20");
    await expect(page.locator("#log .log-item")).toHaveCount(0);
    await expect(page.locator("#ply")).toHaveText("手数 0 / 80");
  });

  test("2 人対戦: 警告マーク・持ち駒の数・パス通知を確かめて終局まで進む", async ({ page }) => {
    const seq = findGameWithPass();
    await page.goto("/");
    await startGame(page, { mode: "pvp" });
    await expect(page.locator("#status")).toContainText("先手の番");
    let sawPass = false;
    let s = createGame();
    for (const [i, m] of seq.moves.entries()) {
      await selectPiece(page, m.kind);
      await cellAt(page, m.r, m.c).click();
      s = playMove(s, m.r, m.c, m.kind);
      // 持ち駒の数（両者）がエンジンと一致
      for (const p of [0, 1] as const) {
        const shown = await page.locator(`#player-${p} .mini`).allTextContents();
        expect(shown).toEqual(KIND_ORDER.map((k) => `${{ fu: "歩", kin: "金", hi: "飛" }[k]}×${s.hands[p][k]}`));
      }
      if (!s.result) {
        // 警告マーク = 手番のプレイヤーの駒のうち、相手が次の 1 手で取れるもの
        const want = threatenedPieces(s, s.turn).map(([r, c]) => cellName(r, c)).sort();
        const got = await page.locator(".cell:has(.threat)").evaluateAll((cs) =>
          cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort(),
        );
        expect(got).toEqual(want);
      }
      if (seq.passAfter.includes(i)) {
        await expect(page.locator("#toast")).toBeVisible();
        await expect(page.locator("#toast")).toContainText("パス（持ち駒が尽きました）");
        await expect(page.locator("#log .log-item.pass").first()).toContainText("パス（持ち駒切れ）");
        await cellsUniform(page);
        if (!sawPass) {
          // トーストの出現アニメーション（0.25 秒）が終わってから撮る
          await page.waitForTimeout(400);
          await expect(page.locator("#toast")).toBeInViewport({ ratio: 1 });
          await page.screenshot({ path: `${SHOT}/pc-pass.png` });
        }
        sawPass = true;
      }
    }
    expect(sawPass).toBe(true);
    await expect(page.locator("#result")).toBeVisible();
    await expect(page.locator("#result-winner")).toHaveText(seq.winnerText);
    await checkBoardFrozen(page);
  });
});

test.describe("スマホ幅 375px", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "スマホ幅のみ"));

  test("CPU 対戦をタップ操作で終局まで進め、横スクロールが出ない", async ({ page }) => {
    await page.goto("/");
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-setup.png` });
    await startGame(page);
    await rulesVisible(page);
    await noHorizontalScroll(page, 375);
    // 盤の全体が最初の画面に入っている
    await expect(page.locator("#board")).toBeInViewport({ ratio: 1 });

    // 金を選び、取れるマスを 1 回タップ → 予測、もう一度タップ → 確定
    await selectPiece(page, "kin", true);
    const take = page.locator(".cell.can-take").first();
    await take.tap();
    await expect(page.locator(".dmg-badge")).toHaveText("1");
    await expect(page.locator("#preview")).toContainText("もう一度タップ");
    await page.screenshot({ path: `${SHOT}/sp-preview.png`, fullPage: true });
    await noHorizontalScroll(page, 375);
    await take.tap();
    await expect(page.locator("#log .log-item")).toHaveCount(1);
    await expect(page.locator("#player-0 .mini[data-kind=fu]")).toContainText("×9");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOT}/sp-capture.png` });

    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      await humanMove(page, true);
      await noHorizontalScroll(page, 375);
    }
    await expect(page.locator("#toast")).toBeHidden();
    await page.screenshot({ path: `${SHOT}/sp-result.png` });
    await noHorizontalScroll(page, 375);
    await checkBoardFrozen(page, true);
    await cellsUniform(page);
    await page.screenshot({ path: `${SHOT}/sp-final-board.png`, fullPage: true });

    await page.locator("#btn-rules").tap();
    await expect(page.locator("#rules")).toContainText("自分の持ち駒にする");
    await expect(page.locator("#rules")).toContainText("挟まれる位置へ自分から置いても取られない");
    // 冒頭から読める（末尾のボタンにフォーカスしてスクロールしない）
    expect(await page.locator("#rules").evaluate((d) => d.scrollTop)).toBe(0);
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-rules.png` });
  });
});

// ---- 2 人対戦の手順探索 ----

/** 種付き乱数（mulberry32） */
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

/** 途中でパスが起きて終局する手順をエンジンで探す（UI で同じ手順をクリックして再生する） */
function findGameWithPass() {
  for (let seed = 1; seed < 20000; seed++) {
    const rand = rng(seed);
    let s: GameState = createGame();
    const moves: { r: number; c: number; kind: PieceKind }[] = [];
    const passAfter: number[] = [];
    while (!s.result) {
      const empties: [number, number][] = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (!s.board[r][c]) empties.push([r, c]);
      const [r, c] = empties[Math.floor(rand() * empties.length)];
      const kinds = availableKinds(s.hands[s.turn]);
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const before = s.history.length;
      s = playMove(s, r, c, kind);
      moves.push({ r, c, kind });
      if (s.history.slice(before).some((e) => e.type === "pass")) passAfter.push(moves.length - 1);
    }
    if (passAfter.length > 0) {
      const w = s.result.winner;
      return { moves, passAfter, winnerText: w === null ? "引き分け" : `${w === 0 ? "先手" : "後手"}の勝ち` };
    }
  }
  throw new Error("パスの起きる手順が見つからない");
}
