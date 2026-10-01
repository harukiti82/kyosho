// ヘッドレスブラウザで設定画面を操作し、各プリセットで実際に対局して画面遷移と表示を確かめる。
// スクリーンショットは web/screenshots/ に保存する。

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { createGame, legalCells, playableKinds, playMove, threatenedPieces, type GameState } from "../src/engine/game";
import { defaultRules, KIND_ORDER, PIECES, PRESETS, presetById, type PieceKind, type PresetId, type RuleSet } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { ruleLines, sentenceText } from "../src/ui/ruletext";

const SHOT = "screenshots";

async function noHorizontalScroll(page: Page, width: number) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw).toBeLessThanOrEqual(width);
}

/** 設定画面のフォームから読んだ設定 */
function readSetup(page: Page): Promise<RuleSet> {
  return page.locator("#setup-form").evaluate((form: HTMLFormElement) => {
    const f = new FormData(form);
    const n = (k: string) => Number((form.elements.namedItem(k) as HTMLInputElement).value);
    return {
      action: f.get("action"),
      gate: f.get("gate") === "1",
      damage: f.get("damage"),
      heal: f.get("heal"),
      hp: [n("hp0"), n("hp1")],
      hand: { fu: n("fu"), gin: n("gin"), kin: n("kin"), hi: n("hi") },
      maxPlies: n("maxPlies"),
    } as unknown as RuleSet;
  });
}

async function startGame(page: Page, opts: { mode?: "cpu" | "pvp"; side?: 0 | 1; preset?: PresetId } = {}) {
  await expect(page.locator("#setup")).toBeVisible();
  if (opts.preset) await page.locator(`.preset[data-preset=${opts.preset}]`).click();
  await page.locator(`input[name=mode][value=${opts.mode ?? "cpu"}]`).check({ force: true });
  if ((opts.mode ?? "cpu") === "cpu") await page.locator(`input[name=side][value="${opts.side ?? 0}"]`).check({ force: true });
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

/** ルールカードの文言が設定から作った文と同じで、画面内に見えている */
async function ruleCardIs(page: Page, rules: RuleSet) {
  const want = ruleLines(rules).map(sentenceText);
  await expect(page.locator("#rules4 li")).toHaveText(want);
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
const cellAt = (page: Page, r: number, c: number) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
const handBtn = (page: Page, k: PieceKind) => page.locator(`#hand-buttons .piece-btn[data-kind=${k}]`);
const PREVIEW_MAIN = /を(返す|取る) → \d+ ダメージ|取れる駒なし/;

/** 持ち駒を選ぶ（選択中なら何もしない） */
async function selectPiece(page: Page, kind: PieceKind, touch = false) {
  const btn = handBtn(page, kind);
  if ((await btn.getAttribute("aria-pressed")) === "true") return;
  if (touch) await btn.tap();
  else await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

/**
 * 返せる（取れる）マスがあればそこへ、なければ先頭の置けるマスへ置く。
 * touch なら 1 回目のタップで予測を確かめてから 2 回目で確定する
 */
async function humanMove(page: Page, touch: boolean) {
  const take = page.locator(".cell.can-take");
  const cell = (await take.count()) > 0 ? take.first() : page.locator(".cell.open").first();
  const before = await page.locator("#log .log-item.move").count();
  if (touch) {
    await cell.tap();
    // 1 回目のタップでは置かれず、予測が出る
    await expect(page.locator("#preview .preview-main")).toHaveText(PREVIEW_MAIN);
    await expect(page.locator("#preview")).toContainText("もう一度タップ");
    expect(await page.locator("#log .log-item.move").count()).toBe(before);
    await cell.tap();
  } else {
    await cell.hover();
    await expect(page.locator("#preview .preview-main")).toHaveText(PREVIEW_MAIN);
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

/** 持ち駒の表示（両者）がエンジンの状態と一致 */
async function handsMatch(page: Page, s: GameState) {
  for (const p of [0, 1] as const) {
    const shown = await page.locator(`#player-${p} .mini`).allTextContents();
    const kinds = KIND_ORDER.filter(
      (k) => s.rules.hand[k] > 0 || (s.rules.action === "capture" && k === "fu") || s.hands[0][k] + s.hands[1][k] > 0,
    );
    expect(shown).toEqual(kinds.map((k) => `${PIECES[k].name}×${s.hands[p][k]}`));
  }
}

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("設定画面: プリセット・個別変更・ルール文の連動・範囲外の値の補正", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await expect(page.locator("#setup")).toBeVisible();
    // 既定は v1.0
    await expect(page.locator(".preset[aria-pressed=true]")).toHaveAttribute("data-preset", "v10");
    expect(await readSetup(page)).toEqual(defaultRules());
    await expect(page.locator("#setup-rules4 li")).toHaveText(ruleLines(defaultRules()).map(sentenceText));
    await page.screenshot({ path: `${SHOT}/pc-setup.png` });

    // プリセットを選ぶとフォームとルール文が変わる
    for (const p of PRESETS) {
      await page.locator(`.preset[data-preset=${p.id}]`).click();
      expect(await readSetup(page)).toEqual(p.rules);
      await expect(page.locator("#setup-rules4 li")).toHaveText(ruleLines(p.rules).map(sentenceText));
      await expect(page.locator("#custom-tag")).toHaveText(`— ${p.name}`);
    }
    // 個別に変えるとカスタムになる（取るルール＋強さ制限は「取れない」）
    await page.locator(".preset[data-preset=v2]").click();
    await page.locator("input[name=action][value=capture]").check({ force: true });
    await expect(page.locator("#custom-tag")).toContainText("カスタム");
    await expect(page.locator(".preset[aria-pressed=true]")).toHaveCount(0);
    await expect(page.locator("#gate-on-label")).toHaveText("置いた駒より強い駒は取れない");
    await expect(page.locator("#setup-rules4")).toContainText("置いた駒より数字が大きい駒を含む列は取れない");
    await page.locator("input[name=heal][value=avg]").check({ force: true });
    await expect(page.locator("#setup-rules4")).toContainText("挟んだ両端の駒の平均だけ回復");

    // 範囲外・空の数値は直す
    await page.locator("input[name=hp0]").fill("999");
    await page.locator("input[name=hp0]").press("Tab");
    await expect(page.locator("input[name=hp0]")).toHaveValue("200");
    await page.locator("input[name=fu]").fill("");
    await page.locator("input[name=fu]").press("Tab");
    await expect(page.locator("input[name=fu]")).toHaveValue("20");
    await page.locator("input[name=hp1]").fill("3");
    await page.locator("input[name=hp1]").press("Tab");
    await expect(page.locator("input[name=hp1]")).toHaveValue("5");
    await expect(page.locator("#setup-rules4")).toContainText("体力 先手 200・後手 5 が 0 で負け");
    // 設定はアドレスバーにも反映される（再読み込みしても同じ設定）
    const custom = await readSetup(page);
    expect(new URL(page.url()).search.slice(1)).toBe(encodeRules(custom));
    await page.reload();
    expect(await readSetup(page)).toEqual(custom);
    await expect(page.locator("#setup-note")).toHaveText("URL の設定を読み込みました。");
    expect(errors).toEqual([]);
  });

  test("URL 共有: コピーした URL を新しいページで開くと同じ設定。不正なクエリは既定値で始まる", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.locator(".preset[data-preset=v04]").click();
    await page.locator("input[name=gate][value='1']").check({ force: true });
    await page.locator("input[name=maxPlies]").fill("50");
    await page.locator("input[name=maxPlies]").press("Tab");
    const want = await readSetup(page);
    expect(want).toEqual({ ...presetById("v04").rules, gate: true, maxPlies: 50 });
    await page.locator("#setup-copy").click();
    await expect(page.locator("#share-status")).toHaveText("コピーしました");
    const url = await page.evaluate(() => navigator.clipboard.readText());
    await expect(page.locator("#share-url")).toHaveValue(url);
    expect(url).toContain("take=flip&gate=1&dmg=max&heal=low&hp1=65&hp2=66&fu=14&gin=10&kin=6&hi=2&limit=50");

    const other = await context.newPage();
    const errors: string[] = [];
    other.on("pageerror", (e) => errors.push(String(e)));
    await other.goto(url);
    expect(await readSetup(other)).toEqual(want);
    await expect(other.locator("#custom-tag")).toContainText("カスタム");
    await startGame(other);
    await ruleCardIs(other, want);
    await expect(other.locator("#ply")).toHaveText("手数 0 / 50");

    // 不正なクエリ: エラーにならず、不正な項目は既定値（v1.0）
    await other.goto("/?take=zzz&gate=7&dmg=<script>&hp1=-3&hp2=1e9&fu=abc&hi=99&limit=99999&heal=__proto__");
    await expect(other.locator("#setup-note")).toContainText("既定値にしました");
    expect(await readSetup(other)).toEqual(defaultRules());
    await expect(other.locator(".preset[aria-pressed=true]")).toHaveAttribute("data-preset", "v10");
    await startGame(other);
    await ruleCardIs(other, defaultRules());
    await expect(other.locator(".cell.open")).toHaveCount(60);
    expect(errors).toEqual([]);
  });

  for (const preset of PRESETS) {
    test(`${preset.name}: CPU 対戦を終局まで打ち、ルールカード・予測・警告が設定どおり`, async ({ page }) => {
      const r = preset.rules;
      await page.goto("/");
      await startGame(page, { preset: preset.id });
      await ruleCardIs(page, r);
      await expect(page.locator("#rules4-name")).toHaveText(`ルール — ${preset.name}`);
      await expect(page.locator("#player-0 .hp-num")).toHaveText(String(r.hp[0]));
      await expect(page.locator("#player-1 .hp-max")).toHaveText(`/ ${r.hp[1]}`);
      await expect(page.locator("#ply")).toHaveText(r.maxPlies > 0 ? `手数 0 / ${r.maxPlies}` : "手数 0");
      await handsMatch(page, createGame(r));
      // 置けるマス: 裏返すルールは初手 4 マス、取るルールは空き 60 マス
      await expect(page.locator(".cell.open")).toHaveCount(r.action === "flip" ? 4 : 60);
      await expect(page.locator(".cell.can-take")).toHaveCount(4);
      const verbRe = r.action === "flip" ? /を返す → 1 ダメージ/ : /を取る → 1 ダメージ/;
      await page.locator(".cell.can-take").first().hover();
      await expect(page.locator("#preview .preview-main")).toHaveText(verbRe);
      await expect(page.locator(".cell.will-take")).toHaveCount(1);
      await expect(page.locator(".dmg-badge")).toHaveText("1");
      if (r.heal === "avg") {
        // 歩1 と端の歩1 の平均 = 1 回復
        await expect(page.locator(".heal-badge")).toHaveText("+1");
        await expect(page.locator("#preview .preview-main")).toContainText("自分が 1 回復");
      } else {
        await expect(page.locator(".heal-badge")).toHaveCount(0);
      }

      let moves = 0;
      let shot = false;
      let sawThreat = false;
      for (;;) {
        if (await waitHumanTurnOrEnd(page)) break;
        if (!sawThreat && (await page.locator(".cell .threat").count()) > 0) {
          sawThreat = true;
          // 警告マークは自分（先手＝黒）の駒にだけ付く。予測中は、この手で返す相手の駒（返した後は自分の駒）にも付く
          const labels = await page.locator(".cell:has(.threat)").evaluateAll((cs) => cs.map((c) => c.getAttribute("aria-label")));
          const mine = r.action === "flip" ? /先手の.*返されうる|後手の.*返されうる 返せる/ : /先手の.*取られうる/;
          for (const l of labels) expect(l).toMatch(mine);
          await cellsUniform(page);
        }
        if (!shot && moves >= 3 && (await page.locator(".cell.can-take").count()) > 0) {
          // 対局中の画面（予測を出した状態）
          shot = true;
          await page.locator(".cell.can-take").first().hover();
          await expect(page.locator("#preview .preview-main")).toHaveText(PREVIEW_MAIN);
          await page.screenshot({ path: `${SHOT}/pc-${preset.id}.png` });
        }
        await humanMove(page, false);
        moves++;
      }
      expect(shot).toBe(true);
      expect(sawThreat).toBe(true);
      await expect(page.locator("#result-winner")).toHaveText(/あなたの勝ち|CPU の勝ち|引き分け/);
      await expect(page.locator("#result-reason")).toHaveText(/体力 0|手に達して打ち切り|打てる手がなくなって終局/);
      await expect(page.locator("#result-detail")).toContainText(`ルール ${preset.name}`);
      if (preset.id === "v2") await page.screenshot({ path: `${SHOT}/pc-result.png` });
      await checkBoardFrozen(page);
      // 棋譜の文言も設定に合わせる
      await expect(page.locator("#log .log-item.hit").first()).toContainText(r.action === "flip" ? "を返した" : "を取った");

      // 再戦で同じ設定の初期状態に戻る
      await page.locator("#btn-rematch").click();
      await expect(page.locator("#player-0 .hp-num")).toHaveText(String(r.hp[0]));
      await expect(page.locator("#log .log-item")).toHaveCount(0);
      await ruleCardIs(page, r);
    });
  }

  test("2 人対戦（v2 案）: 強さ制限で置ける所が尽きたパス・返されうる駒の警告・持ち駒の表示", async ({ page }) => {
    const rules = presetById("v2").rules;
    const seq = findGameWithPass(rules);
    await page.goto("/");
    await startGame(page, { mode: "pvp", preset: "v2" });
    await expect(page.locator("#status")).toContainText("先手の番");
    let sawPass = false;
    let s = createGame(rules);
    for (const [i, m] of seq.moves.entries()) {
      // 強さ制限で置けない駒のボタンは押せない
      for (const k of KIND_ORDER.filter((k) => s.hands[s.turn][k] > 0 && !playableKinds(s).includes(k))) {
        await expect(handBtn(page, k)).toBeDisabled();
        await expect(handBtn(page, k)).toContainText("置けない");
      }
      await selectPiece(page, m.kind);
      await expect(page.locator(".cell.open")).toHaveCount(legalCells(s, m.kind).length);
      await cellAt(page, m.r, m.c).click();
      s = playMove(s, m.r, m.c, m.kind);
      await handsMatch(page, s);
      if (!s.result) {
        // 警告マーク = 手番のプレイヤーの駒のうち、相手が次の 1 手で返せるもの
        const want = threatenedPieces(s, s.turn).map(([r, c]) => cellName(r, c)).sort();
        const got = await page.locator(".cell:has(.threat)").evaluateAll((cs) =>
          cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort(),
        );
        expect(got).toEqual(want);
      }
      if (seq.passAfter.includes(i)) {
        await expect(page.locator("#toast")).toBeVisible();
        await expect(page.locator("#toast")).toContainText("パス（置けるマスがありません）");
        await expect(page.locator("#log .log-item.pass").first()).toContainText("パス（置ける所なし）");
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

  test("エッジケース: 駒の数がすべて 0 なら即終局、体力 5 なら早く決着する", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const zero = { ...presetById("v2").rules, hand: { fu: 0, gin: 0, kin: 0, hi: 0 } };
    await page.goto(`/?${encodeRules(zero)}`);
    await startGame(page);
    await expect(page.locator("#result")).toBeVisible();
    await expect(page.locator("#result-winner")).toHaveText("引き分け");
    await expect(page.locator("#result-reason")).toContainText("最初から両者とも打てない設定のため終局");
    await checkBoardFrozen(page);
    await expect(page.locator(".hand-mini").first()).toHaveText("持ち駒なし");

    const hp5 = { ...presetById("v10").rules, hp: [5, 5] as [number, number] };
    await page.goto(`/?${encodeRules(hp5)}`);
    await startGame(page);
    await expect(page.locator("#rules4")).toContainText("体力 5 が 0 で負け");
    for (;;) {
      if (await waitHumanTurnOrEnd(page)) break;
      await humanMove(page, false);
    }
    await expect(page.locator("#result-reason")).toContainText("体力 0");
    expect(errors).toEqual([]);
  });
});

test.describe("スマホ幅 375px", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "スマホ幅のみ"));

  test("設定画面と各プリセットの対局画面で横スクロールが出ず、盤が最初の画面に入る", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#setup")).toBeVisible();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-setup.png` });
    // 設定画面の下の方（ルール文・対戦・URL コピー）
    await page.locator("#setup-copy").scrollIntoViewIfNeeded();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-setup-bottom.png` });
    await expect(page.locator("#setup-start")).toBeInViewport();

    for (const p of PRESETS) {
      await page.goto(`/?${encodeRules(p.rules)}`);
      await startGame(page);
      await ruleCardIs(page, p.rules);
      await expect(page.locator("#board")).toBeInViewport({ ratio: 1 });
      await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/sp-${p.id}.png` });
    }
  });

  test("v2 案の CPU 対戦をタップ操作で終局まで進める", async ({ page }) => {
    await page.goto("/");
    await page.locator(".preset[data-preset=v2]").tap();
    await page.locator("#setup-start").tap();
    await expect(page.locator("#setup")).toBeHidden();
    await ruleCardIs(page, presetById("v2").rules);

    // 金を選び、返せるマスを 1 回タップ → 予測、もう一度タップ → 確定
    await selectPiece(page, "kin", true);
    const take = page.locator(".cell.can-take").first();
    await take.tap();
    await expect(page.locator(".dmg-badge")).toHaveText("1");
    await expect(page.locator("#preview")).toContainText("もう一度タップ");
    await page.screenshot({ path: `${SHOT}/sp-preview.png`, fullPage: true });
    await noHorizontalScroll(page, 375);
    await take.tap();
    await expect(page.locator("#log .log-item")).toHaveCount(1);
    await expect(page.locator("#player-1 .hp-num")).toHaveText("39");

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

    await page.locator("#btn-rules").tap();
    await expect(page.locator("#rules-title")).toHaveText("ルール — v2案（強い駒は返せない）");
    await expect(page.locator("#rules")).toContainText("置いた駒より数字が大きい駒が 1 つでも入っている列は返せない");
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

/** 途中で「置ける所なし」のパスが起きて終局する手順をエンジンで探す（UI で同じ手順をクリックして再生する） */
function findGameWithPass(rules: RuleSet) {
  for (let seed = 1; seed < 20000; seed++) {
    const rand = rng(seed);
    let s: GameState = createGame(rules);
    const moves: { r: number; c: number; kind: PieceKind }[] = [];
    const passAfter: number[] = [];
    while (!s.result) {
      const kinds = playableKinds(s);
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const cells = legalCells(s, kind);
      const [r, c] = cells[Math.floor(rand() * cells.length)];
      const before = s.history.length;
      s = playMove(s, r, c, kind);
      moves.push({ r, c, kind });
      if (s.history.slice(before).some((e) => e.type === "pass" && e.reason === "noMoves")) passAfter.push(moves.length - 1);
    }
    if (passAfter.length > 0) {
      const w = s.result.winner;
      return { moves, passAfter, winnerText: w === null ? "引き分け" : `${w === 0 ? "先手" : "後手"}の勝ち` };
    }
  }
  throw new Error("パスの起きる手順が見つからない");
}
