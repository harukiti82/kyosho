// プレイヤーの名前（設定メニューの「名前」。ui/setup.ts・net/name.ts）をヘッドレスブラウザで確かめる。
// 確かめること: CPU 対戦の自分の名札・終局画面（見出し・成績表・成績）に名前・再読み込みで残る・空に戻すと今までどおり「あなた」・
// 2 人対戦の先手と後手に別々の名前・長すぎる名前と見えない文字は保存させない・HTML の文字列は文字のまま・
// 長い名前と絵文字でも名札が崩れず、スマホ幅で横にスクロールしない。
// 短い対局（4 手で打ち切り）を置ける手から打って終える（record.spec と同じ）。

import { expect, test, type Page } from "@playwright/test";
import { presetById, type RuleSet } from "../src/engine/rules";
import { SETTINGS_KEY } from "../src/ui/setup";
import { encodeRules } from "../src/ui/query";
import { cellAt, noHorizontalScroll, openSettings, saveSettings, seedPage, startGame, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
/** 4 手で打ち切り（体力判定） */
const SHORT: RuleSet = { ...presetById("orig").rules, maxPlies: 4 };

const prefix = (page: Page) => ((page.viewportSize()?.width ?? 1280) < 600 ? "sp" : "pc");
const isTouch = (page: Page) => prefix(page) === "sp";
const plateName = (page: Page, p: 0 | 1) => page.locator(`#player-${p} .player-name`);

/** 置ける手（選んでいる駒で返せるマスの先頭）を 1 手打つ。マウスは 1 回、タッチは 2 回 */
async function playAny(page: Page) {
  const cell = page.locator(".cell.can-take").first();
  const [r, c] = [Number(await cell.getAttribute("data-r")), Number(await cell.getAttribute("data-c"))];
  if (isTouch(page)) {
    await cellAt(page, r, c).tap();
    await cellAt(page, r, c).tap();
  } else {
    await cellAt(page, r, c).click();
  }
}

/** 置ける手を打ち続けて終局させ、終局画面の見出しを返す */
async function finish(page: Page): Promise<string> {
  for (let n = 0; n < 40; n++) {
    if (await waitHumanTurnOrEnd(page)) break;
    const before = await page.locator("#log .log-item").count();
    await playAny(page);
    await expect(page.locator("#log .log-item")).not.toHaveCount(before);
  }
  await expect(page.locator("#result")).toHaveAttribute("open", "");
  return (await page.locator("#result-winner").textContent()) ?? "";
}

/** 設定メニューの名前の欄（name: 自分 / name0・name1: 2 人対戦の先手・後手）に入れる */
async function fillName(page: Page, field: "name" | "name0" | "name1", value: string) {
  await openSettings(page);
  await page.locator(`#setup-form input[name=${field}]`).fill(value);
}

const savedJson = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), SETTINGS_KEY);

test("CPU 対戦: 決めた名前を自分の名札と終局画面に出し、再読み込みでも残る。空に戻すと「あなた」", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await seedPage(page, 5);
  await page.goto(`/?${encodeRules(SHORT)}`);
  await fillName(page, "name", "  はる  ");
  await saveSettings(page);
  // 前後の空白を除いて保存する
  expect(await savedJson(page)).toMatchObject({ name: "はる", pvpNames: ["", ""] });

  await startGame(page, { level: "normal" });
  await expect(plateName(page, 0)).toHaveText("はる");
  await expect(plateName(page, 0)).toHaveAttribute("title", "先手（はる）");
  await expect(page.locator("#player-0")).toHaveAttribute("aria-label", "先手（はる）");
  // CPU の名前は変えない
  await expect(plateName(page, 1)).toHaveText("CPU");

  const headline = await finish(page);
  expect(["はるの勝ち", "CPU の勝ち", "引き分け"]).toContain(headline);
  const head0 = page.locator("#result-detail .score-head").first();
  await expect(head0.locator(".score-name")).toHaveText("はる");
  await expect(head0.locator(".score-seat")).toHaveText("先手");
  await expect(page.locator("#result-stats .stats-title")).toHaveText("はるの成績");
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-names-cpu-result.png` });

  // 再読み込みしても残る（設定メニューの欄にも入っている）
  await page.reload();
  await openSettings(page);
  await expect(page.locator("#name-self")).toHaveValue("はる");
  await startGame(page, { level: "normal" });
  await expect(plateName(page, 0)).toHaveText("はる");

  // 空にすると今までどおり
  await page.locator("#btn-menu").click();
  await fillName(page, "name", "");
  await startGame(page, { level: "normal" });
  await expect(plateName(page, 0)).toHaveText("あなた");
  await expect(plateName(page, 0)).toHaveAttribute("title", "先手（あなた）");
  expect(await savedJson(page)).toMatchObject({ name: "" });
  const empty = await finish(page);
  expect(["あなたの勝ち", "CPU の勝ち", "引き分け"]).toContain(empty);
  await expect(page.locator("#result-stats .stats-title")).toHaveText("あなたの成績");
  expect(errors).toEqual([]);
});

test("2 人対戦: 先手と後手に別々の名前。片方だけでも、もう片方は「後手」のまま", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`/?${encodeRules(SHORT)}`);
  await fillName(page, "name", "自分の名前");
  await fillName(page, "name0", "くろの人");
  await fillName(page, "name1", "しろの人");
  await startGame(page, { mode: "pvp" });
  // 2 人対戦は自分の名前でなく先手・後手の名前
  await expect(plateName(page, 0)).toHaveText("くろの人");
  await expect(plateName(page, 1)).toHaveText("しろの人");
  await expect(plateName(page, 1)).toHaveAttribute("title", "後手（しろの人）");
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-names-pvp.png` });
  const headline = await finish(page);
  expect(["くろの人の勝ち", "しろの人の勝ち", "引き分け"]).toContain(headline);
  await expect(page.locator("#result-detail .score-name")).toHaveText(["くろの人", "しろの人"]);
  await expect(page.locator("#result-detail .score-seat")).toHaveText(["先手", "後手"]);
  await expect(page.locator("#result-stats .stats-title")).toHaveText(["くろの人の成績", "しろの人の成績"]);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-names-pvp-result.png` });

  // 後手だけ空に戻す
  await page.locator("#result-menu").click();
  await fillName(page, "name1", "");
  await startGame(page, { mode: "pvp" });
  await expect(plateName(page, 0)).toHaveText("くろの人");
  await expect(plateName(page, 1)).toHaveText("後手");
  await expect(plateName(page, 1)).toHaveAttribute("title", "後手");
  expect(errors).toEqual([]);
});

test("長すぎる名前・見えない文字は保存させず理由を出す。HTML の文字列は文字のまま、長い名前と絵文字でも名札が崩れない", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // HTML として読まれたら window に印が立つ
  await page.addInitScript(() => ((window as unknown as { __xss: number }).__xss = 0));
  await page.goto(`/?${encodeRules(SHORT)}`);
  const input = page.locator("#name-self");
  const error = page.locator("#name-error");

  // 11 文字は保存させない（ダイアログは閉じず、欄に理由）
  await fillName(page, "name", "あいうえおかきくけこさ");
  await expect(error).toHaveText("10文字まで");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await page.locator("#setup-save").click();
  await expect(page.locator("#setup")).toBeVisible();
  await expect(input).toBeFocused();
  // 見えない文字（ゼロ幅の空白）・右から左の書式
  for (const bad of ["は​る", "‮はる"]) {
    await input.fill(bad);
    await expect(error).toHaveText("使えない文字があります");
  }
  // HTML の長い文字列は長さで止まる
  await input.fill("<script>alert(1)</script>");
  await expect(error).toHaveText("10文字まで");
  await page.locator("#setup-form input[name=name1]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-names-error.png` });
  // 10 文字ちょうどは通る
  await input.fill("あいうえおかきくけこ");
  await expect(error).toBeHidden();
  await expect(input).toHaveAttribute("aria-invalid", "false");
  // 2 人対戦の欄も同じ
  await fillName(page, "name1", "a‍b");
  await expect(page.locator("#name1-error")).toHaveText("使えない文字があります");
  await page.locator("#setup-save").click();
  await expect(page.locator("#setup")).toBeVisible();
  await expect(page.locator("#setup-form input[name=name1]")).toBeFocused();
  await fillName(page, "name1", "🍣🍣🍣🍣🍣🍣🍣🍣🍣🍣");
  await expect(page.locator("#name1-error")).toBeHidden();

  // HTML の記号を含む名前は文字のまま（要素にならない）
  await fillName(page, "name", '<img src=x onerror="__xss=1">'.slice(0, 10));
  await expect(error).toBeHidden();
  await fillName(page, "name0", "<b>x</b>");
  await saveSettings(page);
  await startGame(page, { mode: "pvp" });
  await expect(plateName(page, 0)).toHaveText("<b>x</b>");
  await expect(plateName(page, 0).locator("b")).toHaveCount(0);
  await expect(plateName(page, 1)).toHaveText("🍣🍣🍣🍣🍣🍣🍣🍣🍣🍣");
  await page.locator("#btn-menu").click();
  await startGame(page, { level: "easy" });
  await expect(plateName(page, 0)).toHaveText('<img src=x');
  await expect(page.locator("#player-0 img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);

  // 長い名前（幅の広い字 10 字）と絵文字: 名札の中に収まり（はみ出す分は省略記号）、横にスクロールしない
  await page.locator("#btn-menu").click();
  await fillName(page, "name0", "ＷＷＷＷＷＷＷＷＷＷ");
  await startGame(page, { mode: "pvp" });
  await expect(plateName(page, 0)).toHaveText("ＷＷＷＷＷＷＷＷＷＷ");
  for (const p of [0, 1] as const) {
    const [card, name] = await Promise.all([page.locator(`#player-${p}`).boundingBox(), plateName(page, p).boundingBox()]);
    expect(name!.x + name!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
  }
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-names-long.png` });
  if (isTouch(page)) await noHorizontalScroll(page, 375);
  await finish(page);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-names-long-result.png` });
  if (isTouch(page)) await noHorizontalScroll(page, 375);
  // 終局画面のダイアログも画面の幅に収まる
  const box = (await page.locator("#result").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(errors).toEqual([]);
});

test("名前の項目のない古い保存・壊れた名前の保存は名前なしで読む", async ({ page }) => {
  await page.addInitScript((k) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(k, JSON.stringify({ v: 2, rules: "", side: "0", name: "a​b", pvpNames: [1, "あいうえおかきくけこさ"] }));
      sessionStorage.setItem("seeded", "1");
    }
  }, SETTINGS_KEY);
  await page.goto("/");
  await openSettings(page);
  await expect(page.locator("#name-self")).toHaveValue("");
  await expect(page.locator("#setup-form input[name=name0]")).toHaveValue("");
  await expect(page.locator("#setup-form input[name=name1]")).toHaveValue("");
  await startGame(page, { preset: "std" });
  await expect(plateName(page, 0)).toHaveText("あなた");
});
