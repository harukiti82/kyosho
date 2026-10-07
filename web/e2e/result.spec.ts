// 決着の演出（勝利・敗北・引き分け・2 人対戦の先手／後手の勝ち）をヘッドレスブラウザで確かめる。
// CPU の手は、ページの Math.random を種付き乱数にして Node 側の「鏡の対局」で予測する。人間（2 人対戦は両者）は返す駒が最も多い手。
// 流れ: 最後の一手の演出 → 決着の演出（タップ／クリック／Enter で飛ばせる）→ 終局画面と成績。

import { expect, test, type Page } from "@playwright/test";
import { chooseLookahead } from "../src/engine/cpu";
import { createGame, lastMoveOf, playMove, viewFor, type GameState } from "../src/engine/game";
import { NO_KING, presetById, type RuleSet } from "../src/engine/rules";
import { FINALE_MS } from "../src/ui/fx";
import { tierOf } from "../src/ui/impact";
import { outcomeOf } from "../src/ui/outcome";
import { decodeRules, encodeRules } from "../src/ui/query";
import { cellAt, greedy, noHorizontalScroll, play, rng, seedPage, startGame } from "./helpers";

const SHOT = "screenshots";
const ORIG = presetById("orig").rules;
const DIR = presetById("dir").rules;
const NO_HAND = { fu: 0, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 };

type Mode = "cpu" | "pvp";
interface Scenario {
  name: string;
  rules: RuleSet;
  mode: Mode;
  seed: number;
}

/** 体力 5 の CPU を特大の一手で撃破（最後の一手が特大＋体力 0） */
const WIN: Scenario = { name: "win", rules: { ...ORIG, hp: [200, 5] }, mode: "cpu", seed: 8 };
/** 体力 5 の自分が CPU に撃破される */
const LOSE: Scenario = { name: "lose", rules: { ...ORIG, hp: [5, 200] }, mode: "cpu", seed: 3 };
/** 4 手で打ち切り、体力判定 39 対 42 で負け（接戦の励まし） */
const LOSE_CLOSE: Scenario = { name: "lose-close", rules: { ...ORIG, maxPlies: 4 }, mode: "cpu", seed: 1 };
/** 歩 1 枚ずつ: 1 手ずつ打って両者打てずに終局、体力も石数も同じ */
const DRAW: Scenario = { name: "draw", rules: { ...ORIG, hand: { ...NO_HAND, fu: 1 } }, mode: "cpu", seed: 1 };
/** 方向駒（王なし）で横 3・角 2: 自分のパスが続いて終局（体力判定で負け） */
const PASSES: Scenario = {
  name: "passes",
  rules: { ...DIR, hp: [40, 40], king: { ...NO_KING }, hand: { ...NO_HAND, yoko: 3, kaku: 2 } },
  mode: "cpu",
  seed: 1,
};
/** 2 人対戦（両者とも返す駒が最も多い手）: 体力 5・5 は先手が 11 手で、5・10 は後手が 12 手で勝つ */
const PVP_BLACK: Scenario = { name: "pvp-black", rules: { ...ORIG, hp: [5, 5] }, mode: "pvp", seed: 1 };
const PVP_WHITE: Scenario = { name: "pvp-white", rules: { ...ORIG, hp: [5, 10] }, mode: "pvp", seed: 1 };

const finale = (page: Page) => page.locator(".fx-finale");
const resultOpen = (page: Page) => page.locator("#result").evaluate((d) => (d as HTMLDialogElement).open);
const moveCount = (page: Page) => page.locator("#log .log-item.move").count();

/** 鏡の対局を進めながら、人間の手を画面で打って終局させる。最後の一手を打った直後に返す */
async function playToEnd(page: Page, sc: Scenario, touch: boolean): Promise<GameState> {
  // URL の検証で既定値に戻される値（体力 5 未満など）を使っていない
  expect(decodeRules(`?${encodeRules(sc.rules)}`).invalid).toEqual([]);
  await seedPage(page, sc.seed);
  await page.goto(`/?${encodeRules(sc.rules)}`);
  await startGame(page, { mode: sc.mode });
  const rand = rng(sc.seed);
  let s = createGame(sc.rules);
  while (!s.result) {
    if (sc.mode === "cpu" && s.turn === 1) {
      const c = chooseLookahead(viewFor(s, 1), rand)!;
      s = playMove(s, c.r, c.c, c.kind, { king: c.king });
      continue;
    }
    await page.waitForSelector(".board.acting", { timeout: 30_000 });
    const ch = greedy(s);
    await play(page, ch.r, ch.c, ch.kind, touch);
    s = playMove(s, ch.r, ch.c, ch.kind);
  }
  return s;
}

/** 決着の演出が出るまで待ち、出ている間は終局画面が開いていないことを確かめる */
async function waitFinale(page: Page, kind: "win" | "lose" | "draw") {
  await expect(finale(page)).toHaveClass(new RegExp(`\\b${kind}\\b`), { timeout: 8000 });
  expect(await resultOpen(page)).toBe(false);
}

for (const project of ["desktop", "mobile"] as const) {
  const pre = project === "desktop" ? "pc" : "sp";
  const touch = project === "mobile";
  /** 演出を飛ばす（スマホはタップ） */
  const skip = (page: Page) => (touch ? finale(page).tap() : finale(page).click());

  test.describe(project === "desktop" ? "PC 幅" : "スマホ幅 375px", () => {
    test.beforeEach(({}, info) => test.skip(info.project.name !== project, `${project} のみ`));

    test("勝利: 最後の特大の一手を出し切ってから紙吹雪・発光・「勝利！」、時間で終局画面と成績へ", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const s = await playToEnd(page, WIN, touch);
      // 決着の一手は特大＋体力 0
      expect(tierOf(s.rules, lastMoveOf(s)!)).toBe("huge");
      expect(s.result).toMatchObject({ winner: 0, reason: "ko" });
      // 最後の一手の演出の間は、決着の演出も終局画面も出さない
      await expect(page.locator(".fx-banner")).toHaveText("痛恨！");
      await expect(finale(page)).toHaveCount(0);
      await waitFinale(page, "win");
      const shownAt = Date.now();
      await expect(finale(page).locator(".fin-title")).toHaveText("勝利！");
      await expect(finale(page).locator(".fin-sub")).toHaveText("体力 0 で撃破");
      await expect(finale(page).locator(".fin-cheer")).toHaveCount(0);
      await expect(page.locator(".fx-confetto")).toHaveCount(28);
      await expect(page.locator(".fx-glow")).toHaveCount(1);
      await expect(page.locator(".fx-sink")).toHaveCount(0);
      await page.waitForTimeout(700);
      if (touch) await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/${pre}-result-win.png` });
      // 時間で終局画面へ（演出は最大 2.5 秒）
      await expect(page.locator("#result")).toBeVisible({ timeout: FINALE_MS + 1500 });
      expect(Date.now() - shownAt).toBeLessThan(2500 + 800);
      await expect(finale(page)).toHaveCount(0);
      await expect(page.locator("#result-winner")).toHaveText("あなたの勝ち");
      await expect(page.locator("#result-stats .stats")).toHaveCount(1);
      await expect(page.locator("#result-cheer")).toBeHidden();
      await expect(page.locator("#result-rematch")).not.toHaveClass(/urge/);
      if (touch) await noHorizontalScroll(page, 375);
      expect(errors).toEqual([]);
    });

    test("敗北: 彩度を落として沈む・「敗北…」・タップ／クリックで飛ばすと終局画面で「再戦」を強調", async ({ page }) => {
      const s = await playToEnd(page, LOSE, touch);
      expect(s.result).toMatchObject({ winner: 1, reason: "ko" });
      await waitFinale(page, "lose");
      await expect(finale(page).locator(".fin-title")).toHaveText("敗北…");
      await expect(finale(page).locator(".fin-sub")).toHaveText("体力 0 で撃破された");
      await expect(page.locator(".fx-sink")).toHaveCount(1);
      await expect(page.locator(".fx-confetto, .fx-glow")).toHaveCount(0);
      // 相手の残り体力が多いので励ましはない
      await expect(finale(page).locator(".fin-cheer")).toHaveCount(0);
      await page.waitForTimeout(900);
      if (touch) await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/${pre}-result-lose.png` });
      await skip(page);
      await expect(page.locator("#result")).toBeVisible({ timeout: 500 });
      await expect(finale(page)).toHaveCount(0);
      await expect(page.locator("#result-winner")).toHaveText("CPU の勝ち");
      await expect(page.locator("#result-rematch")).toHaveClass(/urge/);
      await expect(page.locator("#result-stats .stats")).toHaveCount(1);
      await page.screenshot({ path: `${SHOT}/${pre}-result-lose-screen.png` });
    });

    test("接戦の敗北: 体力判定で 3 点差なら「あと 3 点だった」を演出と終局画面に添える", async ({ page }) => {
      const s = await playToEnd(page, LOSE_CLOSE, touch);
      expect(s.hp).toEqual([39, 42]);
      await waitFinale(page, "lose");
      await expect(finale(page).locator(".fin-sub")).toHaveText("体力判定で敗北（体力 39 対 42）");
      await expect(finale(page).locator(".fin-cheer")).toHaveText("惜しい！ あと 3 点だった");
      await page.waitForTimeout(1300);
      if (touch) await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/${pre}-result-lose-close.png` });
      // PC は Enter で飛ばす（終局画面のボタンが一緒に押されない）
      if (touch) await skip(page);
      else await page.keyboard.press("Enter");
      await expect(page.locator("#result")).toBeVisible({ timeout: 500 });
      await expect(page.locator("#result-cheer")).toHaveText("惜しい！ あと 3 点だった");
      await expect(page.locator("#result-rematch")).toHaveClass(/urge/);
      expect(await moveCount(page)).toBe(4);
    });

    test("引き分け: 穏やかな幕と「引き分け」", async ({ page }) => {
      const s = await playToEnd(page, DRAW, touch);
      expect(s.result).toMatchObject({ winner: null, reason: "stalled" });
      await waitFinale(page, "draw");
      await expect(finale(page).locator(".fin-title")).toHaveText("引き分け");
      await expect(finale(page).locator(".fin-sub")).toHaveText(outcomeOf(s, { mode: "cpu", human: 0 })!.subtitle);
      await expect(page.locator(".fx-calm")).toHaveCount(1);
      await expect(page.locator(".fx-confetto, .fx-glow, .fx-sink")).toHaveCount(0);
      await page.waitForTimeout(700);
      if (touch) await noHorizontalScroll(page, 375);
      await page.screenshot({ path: `${SHOT}/${pre}-result-draw.png` });
      await expect(page.locator("#result")).toBeVisible({ timeout: FINALE_MS + 1500 });
      await expect(page.locator("#result-winner")).toHaveText("引き分け");
    });

    for (const [sc, winner, title] of [
      [PVP_BLACK, 0, "先手の勝ち！"],
      [PVP_WHITE, 1, "後手の勝ち！"],
    ] as const) {
      test(`2 人対戦: ${title}（勝った側の駒色・敗北の演出は出さない）`, async ({ page }) => {
        const s = await playToEnd(page, sc, touch);
        expect(s.result?.winner).toBe(winner);
        await waitFinale(page, "win");
        await expect(finale(page)).toHaveClass(new RegExp(`tone-${winner === 0 ? "black" : "white"}`));
        await expect(finale(page).locator(".fin-title")).toHaveText(title);
        await expect(finale(page).locator(`.fin-stone.p${winner}`)).toHaveCount(1);
        await expect(page.locator(".fx-confetto")).toHaveCount(28);
        await expect(page.locator(".fx-sink")).toHaveCount(0);
        await page.waitForTimeout(700);
        if (touch) await noHorizontalScroll(page, 375);
        await page.screenshot({ path: `${SHOT}/${pre}-result-${sc.name}.png` });
        await expect(page.locator("#result")).toBeVisible({ timeout: FINALE_MS + 1500 });
        await expect(page.locator("#result-stats .stats")).toHaveCount(2);
        await expect(page.locator("#result-rematch")).not.toHaveClass(/urge/);
      });
    }
  });
}

test.describe("PC 幅（動きを減らす設定・音・飛ばす操作・エッジケース）", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "PC 幅のみ"));

  test("動きを減らす設定: 紙吹雪・発光・沈みを出さず、文字と副題だけ", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await playToEnd(page, WIN, false);
    await waitFinale(page, "win");
    await expect(finale(page)).toHaveClass(/reduce/);
    await expect(finale(page).locator(".fin-title")).toHaveText("勝利！");
    await expect(finale(page).locator(".fin-sub")).toHaveText("体力 0 で撃破");
    await expect(page.locator(".fx-confetto, .fx-glow, .fx-sink, .fx-calm")).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/pc-result-reduced-win.png` });
    await expect(page.locator("#result")).toBeVisible({ timeout: 3000 });

    await playToEnd(page, LOSE_CLOSE, false);
    await waitFinale(page, "lose");
    await expect(finale(page).locator(".fin-cheer")).toHaveText("惜しい！ あと 3 点だった");
    await expect(page.locator(".fx-confetto, .fx-glow, .fx-sink, .fx-calm")).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/pc-result-reduced-lose.png` });
  });

  test("音: 勝ちはファンファーレ・負けは低い音・引き分けは 2 音。消音中は鳴らさず、再読み込み後の消音では AudioContext も作らない", async ({ page }) => {
    // AudioContext の生成数と、発音（オシレーターの周波数）を時刻・決着の演出が出ていたかと一緒に記録する
    await page.addInitScript(() => {
      const w = window as unknown as { __ac: number; __osc: { t: number; f: number; fin: boolean }[]; AudioContext: typeof AudioContext };
      w.__ac = 0;
      w.__osc = [];
      const Orig = w.AudioContext;
      w.AudioContext = class extends Orig {
        constructor(o?: AudioContextOptions) {
          super(o);
          w.__ac++;
        }
        createOscillator() {
          const osc = super.createOscillator();
          const set = osc.frequency.setValueAtTime.bind(osc.frequency);
          osc.frequency.setValueAtTime = (v: number, t: number) => {
            w.__osc.push({ t: performance.now(), f: v, fin: !!document.querySelector(".fx-finale") });
            return set(v, t);
          };
          return osc;
        }
      };
    });
    const finaleFreqs = () =>
      page.evaluate(() => {
        const w = window as unknown as { __osc: { f: number; fin: boolean }[] };
        return w.__osc.filter((o) => o.fin).map((o) => o.f);
      });
    const created = () => page.evaluate(() => (window as unknown as { __ac: number }).__ac);

    await playToEnd(page, PVP_BLACK, false);
    await waitFinale(page, "win");
    expect(await finaleFreqs()).toEqual(expect.arrayContaining([523, 659, 784, 1047]));

    await playToEnd(page, LOSE_CLOSE, false);
    await waitFinale(page, "lose");
    const lose = await finaleFreqs();
    expect(lose).toEqual(expect.arrayContaining([196, 156, 131]));
    expect(lose).not.toContain(1047);

    await playToEnd(page, DRAW, false);
    await waitFinale(page, "draw");
    expect(await finaleFreqs()).toEqual([440, 587]);

    // 対局中に消音すると、それ以降（決着の音を含む）は鳴らさない
    await seedPage(page, PVP_BLACK.seed);
    await page.goto(`/?${encodeRules(PVP_BLACK.rules)}`);
    await startGame(page, { mode: "pvp" });
    await page.locator("#btn-mute").click();
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "true");
    const mutedAt = await page.evaluate(() => performance.now());
    let s = createGame(PVP_BLACK.rules);
    while (!s.result) {
      await page.waitForSelector(".board.acting");
      const ch = greedy(s);
      await play(page, ch.r, ch.c, ch.kind, false);
      s = playMove(s, ch.r, ch.c, ch.kind);
    }
    await waitFinale(page, "win");
    await page.waitForTimeout(300);
    expect(await page.evaluate((t) => (window as unknown as { __osc: { t: number }[] }).__osc.filter((o) => o.t >= t).length, mutedAt)).toBe(0);

    // 消音のまま再読み込み: 終局まで AudioContext を作らない
    await playToEnd(page, DRAW, false);
    await expect(page.locator("#btn-mute")).toHaveAttribute("aria-pressed", "true");
    await waitFinale(page, "draw");
    await page.waitForTimeout(300);
    expect(await created()).toBe(0);
    expect(await finaleFreqs()).toEqual([]);
  });

  test("パスの連続で終局しても決着の演出が出る", async ({ page }) => {
    const s = await playToEnd(page, PASSES, false);
    expect(s.history.filter((e) => e.type === "pass").length).toBeGreaterThanOrEqual(2);
    expect(s.result?.reason).toBe("stalled");
    const o = outcomeOf(s, { mode: "cpu", human: 0 })!;
    await waitFinale(page, o.kind);
    await expect(finale(page).locator(".fin-sub")).toHaveText(o.subtitle);
    await page.screenshot({ path: `${SHOT}/pc-result-passes.png` });
    await expect(page.locator("#result")).toBeVisible({ timeout: FINALE_MS + 1500 });
  });

  test("演出中の連打は 1 回の「飛ばす」だけ（再戦にならない）・終局後に盤を押しても何も起きない", async ({ page }) => {
    await playToEnd(page, DRAW, false);
    await waitFinale(page, "draw");
    const moves = await moveCount(page);
    for (let i = 0; i < 4; i++) await page.mouse.click(640, 450);
    await expect(page.locator("#result")).toBeVisible();
    await expect(finale(page)).toHaveCount(0);
    expect(await moveCount(page)).toBe(moves);
    // 「盤面を見る」で閉じたあと、盤を押しても置けず、演出も終局画面も出ない
    await page.locator("#result-view").click();
    await expect(page.locator("#result")).toBeHidden();
    await cellAt(page, 0, 0).click({ force: true });
    await cellAt(page, 2, 2).click({ force: true });
    await page.waitForTimeout(500);
    expect(await moveCount(page)).toBe(moves);
    await expect(finale(page)).toHaveCount(0);
    expect(await resultOpen(page)).toBe(false);
    // 「結果を見る」で終局画面に戻れる
    await page.locator("#hand-buttons button", { hasText: "結果を見る" }).click();
    await expect(page.locator("#result")).toBeVisible();
  });

  test("演出中に「メニュー」を押す: 演出を飛ばして終局画面へ（メニューは重ならない）。そこから新しい対局を始めると演出は残らない", async ({ page }) => {
    await playToEnd(page, LOSE_CLOSE, false);
    await waitFinale(page, "lose");
    const box = (await page.locator("#btn-menu").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#result")).toBeVisible();
    await expect(page.locator("#menu")).toBeHidden();
    await page.locator("#result-menu").click();
    await expect(page.locator("#menu")).toBeVisible();
    await expect(page.locator("#result")).toBeHidden();
    await startGame(page);
    await expect(finale(page)).toHaveCount(0);
    expect(await moveCount(page)).toBe(0);
    // 元の演出の時間が過ぎても終局画面は出ない
    await page.waitForTimeout(FINALE_MS + 300);
    expect(await resultOpen(page)).toBe(false);
  });

  test("最後の一手の演出の前に「メニュー」から始め直すと、前の対局の決着の演出は出ない", async ({ page }) => {
    await playToEnd(page, WIN, false);
    // 特大の演出中（決着の演出の前）にメニューを開いて始め直す
    await page.locator("#btn-menu").click();
    await startGame(page);
    await page.waitForTimeout(1800 + FINALE_MS);
    await expect(finale(page)).toHaveCount(0);
    expect(await resultOpen(page)).toBe(false);
  });
});
