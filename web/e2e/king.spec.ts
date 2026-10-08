// 隠し王をヘッドレスブラウザで実際に遊んで確かめる。
// CPU 対戦は、ページの Math.random を種付き乱数に置き換え、Node 側で同じ種の CPU を動かす「鏡の対局」と照らし合わせる
// （鏡の対局は CPU の王の場所を知っているので、人間役はそれを狙って返せる。画面には CPU の王が出ないことも確かめる）。

import { expect, test, type Page } from "@playwright/test";
import { cellName } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import {
  createGame,
  kingInfo,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  threatenedPieces,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { presetById, type HiddenKing, type PieceKind, type RuleSet } from "../src/engine/rules";
import { encodeRules } from "../src/ui/query";
import { ruleLines, sentenceText } from "../src/ui/ruletext";
import { noHorizontalScroll, openRuleFields, openSettings, readSetup, rng, saveSettings, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const KING = presetById("king").rules;
const withKing = (patch: Partial<HiddenKing>): RuleSet => ({ ...KING, king: { ...KING.king, ...patch } });

const cellAt = (page: Page, r: number, c: number) => page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
const handBtn = (page: Page, k: PieceKind) => page.locator(`#hand-buttons .piece-btn[data-kind=${k}]`);

async function selectPiece(page: Page, kind: PieceKind) {
  const btn = handBtn(page, kind);
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
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

/** 人間役（先手）の手: CPU の隠れた王を返せる手があればそれ、なければ 2 手読みの最善候補の先頭。1 手目で王を指定する */
function humanChoice(s: GameState) {
  const cpuKing = s.kings[1];
  if (cpuKing.cell && !cpuKing.revealed) {
    for (const kind of playableKinds(s)) {
      for (const [r, c] of legalCells(s, kind)) {
        const n = playMove(s, r, c, kind);
        if (lastMoveOf(n)!.king) return { r, c, kind, king: false };
      }
    }
  }
  const ch = lookaheadCandidates(viewFor(s, 0)).cands[0];
  return { ...ch, king: kingInfo(s, 0).nextMove === 1 };
}

const moveCount = (page: Page) => page.locator("#log .log-item.move").count();
const kingMarks = (page: Page) =>
  page.locator(".cell:has(.king-mark)").evaluateAll((cs) => cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort());

test.describe("PC 幅", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("設定メニュー: 隠し王の項目・連動・範囲外の補正・URL の復元", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await openRuleFields(page);
    // 隠し王なし（v1.0）なら追加設定は隠れている
    await page.locator(".preset[data-preset=v10]").click();
    await expect(page.locator("#king-sub")).toBeHidden();
    await page.locator(".preset[data-preset=king]").click();
    expect(await readSetup(page)).toEqual(KING);
    await expect(page.locator("#king-sub")).toBeVisible();
    await expect(page.locator("#setup-rules4 li")).toHaveText(ruleLines(KING).map(sentenceText));
    await expect(page.locator("#setup-rules4")).toContainText("最初の5手のうち1つを王にする。相手に見えず、返されたら体力−20");
    await page.locator("#opt-king").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT}/pc-king-setup.png` });

    // 即負けにすると減る体力の欄は隠れ、ルール文が変わる
    await page.locator("input[name=kingPenalty][value=lose]").check({ force: true });
    await expect(page.locator("#king-amount-field")).toBeHidden();
    await expect(page.locator("#setup-rules4")).toContainText("相手に見えず、返されたら即負け");
    await expect(page.locator("#custom-tag")).toContainText("カスタム");
    // 期限の範囲外は直す
    await page.locator("input[name=kingDeadline]").fill("25");
    await page.locator("input[name=kingDeadline]").press("Tab");
    await expect(page.locator("input[name=kingDeadline]")).toHaveValue("20");
    await page.locator("input[name=kingDeadline]").fill("0");
    await page.locator("input[name=kingDeadline]").press("Tab");
    await expect(page.locator("input[name=kingDeadline]")).toHaveValue("1");
    await expect(page.locator("#setup-rules4")).toContainText("最初に置く駒が王。相手に見えず、返されたら即負け");
    // 取るルールでは「取られたら」
    await page.locator("input[name=action][value=capture]").check({ force: true });
    await expect(page.locator("#king-lose-label")).toHaveText("取られたら即負け");
    const custom = await readSetup(page);
    expect(custom.king).toEqual({ on: true, penalty: "lose", amount: 20, deadline: 1 });
    // 保存するとアドレスバーに反映され、再読み込みで復元される
    await saveSettings(page);
    expect(new URL(page.url()).search).toContain("king=1&kpen=lose&kdmg=20&kdue=1");
    await page.reload();
    expect(await readSetup(page)).toEqual(custom);
    await openRuleFields(page);
    // なしに戻すと追加設定は隠れ、ルール文から王の行が消える
    await page.locator("input[name=king][value='0']").check({ force: true });
    await expect(page.locator("#king-sub")).toBeHidden();
    await expect(page.locator("#setup-rules4")).not.toContainText("王");

    // 不正な値は URL の基準（v1.0）の値（なし・体力−20・5 手）にして知らせる
    await page.goto("/?king=1&kpen=boom&kdmg=0&kdue=99");
    await expect(page.locator("#menu-note")).toContainText("URL の王の罰・王の罰の体力・王の指定期限が読めないので、v1.0（取る）の値にしました");
    expect((await readSetup(page)).king).toEqual({ on: true, penalty: "hp", amount: 20, deadline: 5 });
    expect(errors).toEqual([]);
  });

  for (const [label, rules, seed] of [
    ["体力−20", KING, 9],
    ["即負け", withKing({ penalty: "lose" }), 5],
  ] as const) {
    test(`CPU 対戦（罰: ${label}）: 王を指定 → 王の印 → CPU の王を返して公開と罰 → 終局`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await seedPage(page, seed);
      await page.goto(`/?${encodeRules(rules)}`);
      await startGame(page);
      await expect(page.locator("#rules4 li")).toHaveText(ruleLines(rules).map(sentenceText));
      await expect(page.locator("#legend")).toContainText("自分の王。自分にだけ見える");

      const rand = rng(seed);
      let s = createGame(rules);
      let hitShot = false;
      let sawKingThreat = false;
      for (;;) {
        if (await waitHumanTurnOrEnd(page)) break;
        expect(await moveCount(page)).toBe(s.history.filter((e) => e.type === "move").length);
        // 画面に出る王の印は自分の王だけ（CPU の王は出ない）
        const mine = kingInfo(s, 0).cell;
        expect(await kingMarks(page)).toEqual(mine ? [cellName(mine[0], mine[1])] : []);
        // 自分の王が次の相手の手で返されうるときだけ、王の「!」を強調する
        const kingThreat = !!mine && threatenedPieces(s, 0).some(([r, c]) => r === mine[0] && c === mine[1]);
        await expect(page.locator(".threat.king")).toHaveCount(kingThreat ? 1 : 0);
        if (kingThreat) {
          await expect(cellAt(page, mine![0], mine![1]).locator(".threat.king")).toBeVisible();
          if (!sawKingThreat) await page.screenshot({ path: `${SHOT}/pc-king-threat.png` });
          sawKingThreat = true;
        }

        const ch = humanChoice(s);
        await selectPiece(page, ch.kind);
        // 王を決められる手番は、駒台の右端に王の駒（あと何手か）を出す。決めた後・決められない手番は出さない
        await expect(page.locator("#status")).toHaveText("あなたの番");
        if (kingInfo(s, 0).canDesignate) {
          await expect(page.locator("#king-toggle")).toBeVisible();
          await expect(page.locator("#king-toggle")).toContainText(`あと${rules.king.deadline - kingInfo(s, 0).nextMove + 1}手`);
        } else {
          await expect(page.locator("#king-toggle")).toHaveCount(0);
        }
        if (ch.king) {
          // 1 手目: 王の駒（この駒を王にする）を押す → 持ち上がり、予測・吹き出し・影の駒に王の印
          await expect(page.locator("#king-toggle")).toHaveAccessibleName("この駒を王にする");
          await expect(page.locator("#king-box")).toContainText("あと 5 手のうち 1 手");
          await page.locator("#king-toggle").click();
          await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "true");
          await expect(page.locator("#king-toggle")).toHaveClass(/\bon\b/);
          await cellAt(page, ch.r, ch.c).hover();
          await expect(page.locator("#preview .label")).toContainText("王にして置くと");
          await expect(cellAt(page, ch.r, ch.c).locator(".pv-bubble")).toContainText("王にして置く");
          await expect(cellAt(page, ch.r, ch.c).locator(".stone.ghost .king-mark")).toBeVisible();
        }
        await cellAt(page, ch.r, ch.c).click();
        s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
        const m = lastMoveOf(s)!;
        if (ch.king) {
          await expect(page.locator("#toast")).toContainText(`${cellName(ch.r, ch.c)} の歩1を王にしました`);
          await expect(cellAt(page, ch.r, ch.c).locator(".king-mark")).toBeVisible();
          // 自分の王の場所は名札（王の駒の形とマス名）。説明は title。駒台の王の駒は消える
          await expect(page.locator("#player-0 .king-tag")).toHaveText(`王 ${cellName(ch.r, ch.c)}`);
          await expect(page.locator("#player-0 .king-tag")).toHaveAttribute("title", `王は ${cellName(ch.r, ch.c)}（相手には見えない）`);
          await expect(page.locator("#king-box")).toBeHidden();
        }
        if (m.king) {
          // CPU の王を返した: トースト・棋譜・王！の演出・体力（ダメージ＋罰）
          const k = m.king;
          await expect(page.locator("#toast")).toContainText(`王を返した。CPUの王は ${cellName(k.r, k.c)} の`);
          await expect(page.locator("#log .log-item").first()).toHaveClass(/king/);
          await expect(page.locator("#log .log-item").first()).toContainText(k.lose ? "王を返した・即負け" : "王を返した・体力−20");
          if (!hitShot) {
            await expect(cellAt(page, k.r, k.c).locator(".king-pop")).toBeVisible();
            await expect(page.locator("#player-1 .delta")).toHaveText(`−${m.damage + k.penalty}`);
            await expect(page.locator("#player-1 .hp-num")).toHaveText(String(s.hp[1]));
            // トースト・王！の出現アニメーションが落ち着いてから撮る（CPU が 0.9 秒後に打つ前に）
            await page.waitForTimeout(350);
            await page.screenshot({ path: `${SHOT}/pc-king-hit${k.lose ? "-lose" : ""}.png` });
            hitShot = true;
          }
          // 返された王は名札のマス名に取り消し線（赤）
          if (!s.result) {
            await expect(page.locator("#player-1 .king-tag")).toHaveText(`王 ${cellName(k.r, k.c)}`);
            await expect(page.locator("#player-1 .king-tag")).toHaveClass(/\blost\b/);
            await expect(page.locator("#player-1 .king-tag")).toHaveAttribute("title", "王は返された（以後ふつうの駒）");
          }
        }
        // CPU の手番を鏡の対局で進める（同じ種なので同じ手になる）
        while (!s.result && s.turn === 1) {
          const c = chooseLookahead(viewFor(s, 1), rand)!;
          s = playMove(s, c.r, c.c, c.kind, { king: c.king });
        }
      }
      expect(hitShot).toBe(true);
      // 終局: 画面と鏡の対局が一致。王の答え合わせが出て、両者の隠れた王の印が出る
      await expect(page.locator("#result-winner")).toHaveText(s.result!.winner === 0 ? "あなたの勝ち" : "CPU の勝ち");
      if (rules.king.penalty === "lose") {
        await expect(page.locator("#result-reason")).toHaveText("CPUの王が返されたので即負け");
      }
      // 成績表の「王」の行で答え合わせ（列は先手・後手）
      const kingRow = page.locator("#result-detail tbody tr").filter({ has: page.locator("th", { hasText: /^王$/ }) });
      await expect(kingRow.locator("td")).toHaveCount(2);
      await expect(kingRow.locator("td").nth(1)).toContainText(" 返された");
      await page.screenshot({ path: `${SHOT}/pc-king-result${rules.king.penalty === "lose" ? "-lose" : ""}.png` });
      await page.locator("#result-view").click();
      const hidden = ([0, 1] as const).map((p) => kingInfo(s, p).cell).filter((c) => c !== null);
      expect(await kingMarks(page)).toEqual(hidden.map(([r, c]) => cellName(r, c)).sort());
      expect(errors).toEqual([]);
    });
  }

  test("2 人対戦: 王の印は既定で非表示、確認ボタンを押している間だけ手番の人の王。期限の手で自動指定", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const rules = withKing({ deadline: 2 });
    await page.goto(`/?${encodeRules(rules)}`);
    await startGame(page, { mode: "pvp" });
    await expect(page.locator("#rules4")).toContainText("最初の2手のうち1つを王に");
    let s = createGame(rules);
    // 王を返さない最初の合法手（この試験では王を公開させない）
    const first = () => legalCells(s, "fu").find(([y, x]) => !lastMoveOf(playMove(s, y, x, "fu"))!.king)!;

    // 先手 1 手目: 指定できる・相手に画面を見せない注意。指定せずに置く
    await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#king-box .king-privacy")).toHaveText("王を決める間は、相手に画面を見せないでください");
    await expect(page.locator("#king-box")).toContainText("あと 2 手のうち 1 手");
    let [r, c] = first();
    await cellAt(page, r, c).click();
    s = playMove(s, r, c, "fu");
    await expect(page.locator("#toast")).toBeHidden();

    // 後手 1 手目: 王にして置く（2 人対戦ではトーストを出さない）
    await page.locator("#king-toggle").click();
    [r, c] = first();
    await cellAt(page, r, c).hover();
    await expect(cellAt(page, r, c).locator(".ghost .king-mark")).toBeVisible();
    // 王にする駒が返されうる警告は 1 行にまとめる（置いた駒の警告と重ねない）
    await expect(page.locator("#preview .warn.king")).toHaveCount(1);
    await expect(page.locator("#preview .warn.king")).toContainText("王にする歩1が次に返されうる。返されたら体力−20");
    await expect(page.locator("#preview")).not.toContainText("ここに置いた");
    await page.screenshot({ path: `${SHOT}/pc-king-pvp-designate.png` });
    await cellAt(page, r, c).click();
    s = playMove(s, r, c, "fu", { king: true });
    const whiteKing = cellName(r, c);
    await expect(page.locator("#toast")).toBeHidden();
    expect(await kingMarks(page)).toEqual([]);

    // 先手 2 手目 = 期限: 自動で王になる表示（ボタンは押せない）
    await expect(page.locator("#king-toggle")).toBeDisabled();
    await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#king-box")).toContainText("期限の 2 手目です。この手で置く駒が自動で王になります。王を返されたら体力−20");
    await expect(page.locator("#king-toggle")).toContainText("この手で王");
    await expect(page.locator("#status")).toHaveText("先手の番");
    [r, c] = first();
    await cellAt(page, r, c).click();
    s = playMove(s, r, c, "fu");
    const blackKing = cellName(r, c);
    expect(kingInfo(s, 0)).toMatchObject({ status: "hidden", auto: true });
    await expect(page.locator("#toast")).toBeHidden();

    // 後手の番: 王の印は出ていない。確認ボタンを押している間だけ後手の王が出る
    expect(await kingMarks(page)).toEqual([]);
    await expect(page.locator("#king-toggle")).toHaveCount(0);
    const peek = page.locator("#king-peek");
    await expect(peek).toHaveAccessibleName("自分の王を確認（押している間だけ表示）");
    await peek.hover();
    await page.mouse.down();
    expect(await kingMarks(page)).toEqual([whiteKing]);
    await expect(peek).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${SHOT}/pc-king-peek.png` });
    await page.mouse.up();
    expect(await kingMarks(page)).toEqual([]);
    await expect(peek).toHaveAttribute("aria-pressed", "false");
    // キーボードでも押している間だけ
    await peek.focus();
    await page.keyboard.down("Space");
    expect(await kingMarks(page)).toEqual([whiteKing]);
    await page.keyboard.up("Space");
    expect(await kingMarks(page)).toEqual([]);

    [r, c] = first();
    await cellAt(page, r, c).click();
    s = playMove(s, r, c, "fu");
    // 先手の番: 確認ボタンで先手の（自動で決まった）王
    expect(await kingMarks(page)).toEqual([]);
    await page.locator("#king-peek").hover();
    await page.mouse.down();
    expect(await kingMarks(page)).toEqual([blackKing]);
    await page.mouse.up();
    expect(await kingMarks(page)).toEqual([]);
    // 押さずに盤を操作しても王の印や王の強調は出ない
    await page.locator(".cell.open").first().hover();
    expect(await kingMarks(page)).toEqual([]);
    await expect(page.locator(".threat.king")).toHaveCount(0);
    await expect(page.locator(".warn.king")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("期限 1 手（CPU 対戦）: 最初に置いた駒が自動で王になり、その旨を表示する", async ({ page }) => {
    await page.goto(`/?${encodeRules(withKing({ deadline: 1 }))}`);
    await startGame(page);
    await expect(page.locator("#rules4")).toContainText("最初に置く駒が王。相手に見えず、返されたら体力−20");
    await expect(page.locator("#king-toggle")).toBeDisabled();
    await expect(page.locator("#king-toggle")).toHaveAccessibleName("この手で置く駒が王になる");
    await expect(page.locator("#king-toggle")).toContainText("この手で王");
    const cell = page.locator(".cell.can-take").first();
    const name = ((await cell.getAttribute("aria-label")) ?? "").split(" ")[0];
    await cell.click();
    await expect(page.locator("#toast")).toContainText(`期限の 1 手目なので、${name} の歩1が自動で王になりました`);
    expect(await kingMarks(page)).toEqual([name]);
  });
});

test.describe("スマホ幅 375px", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "mobile", "スマホ幅のみ"));

  test("隠し王: 設定画面と対局画面で横スクロールなし。タップで王を指定して置ける", async ({ page }) => {
    await page.goto("/");
    await openSettings(page);
    await page.locator(".preset[data-preset=king]").tap();
    await openRuleFields(page);
    await page.locator("#king-sub").scrollIntoViewIfNeeded();
    await expect(page.locator("#king-sub")).toBeVisible();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-king-setup.png` });
    await startGame(page);
    await expect(page.locator("#rules4 li")).toHaveText(ruleLines(KING).map(sentenceText));
    await expect(page.locator("#board")).toBeInViewport({ ratio: 1 });
    await noHorizontalScroll(page, 375);

    // 王にするボタン → 返せるマスを 1 回タップで予測、もう一度タップで確定
    await page.locator("#king-toggle").tap();
    await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "true");
    const take = page.locator(".cell.can-take").first();
    const name = ((await take.getAttribute("aria-label")) ?? "").split(" ")[0];
    await take.tap();
    await expect(page.locator("#preview")).toContainText("もう一度タップで王にして置く");
    await page.screenshot({ path: `${SHOT}/sp-king-preview.png`, fullPage: true });
    await take.tap();
    await expect(page.locator("#toast")).toContainText("を王にしました");
    expect(await kingMarks(page)).toEqual([name]);
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-king-placed.png` });
    // 王を決めたら駒台の王の駒は消え、名札に王の場所
    await expect(page.locator("#king-box")).toBeHidden();
    await expect(page.locator("#player-0 .king-tag")).toHaveText(`王 ${name}`);
    await page.locator("#hand").scrollIntoViewIfNeeded();
    await noHorizontalScroll(page, 375);
    await page.screenshot({ path: `${SHOT}/sp-king-box.png` });
  });
});
