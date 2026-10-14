// 遊び方（チュートリアル）: メニューの「遊び方」から始め、各ステップで違う手（ヒントが出て盤は変わらない）→ 正解（何が起きたかの 1 文）を打ち、
// 最後の実戦（標準・CPU イージー・制限時間なし。カードを選んでから）を終局まで打つ。スキルなしの要素の後に、カードを選ぶ（配り直し）・ゲージ・
// 使う・副将・副将を裏返すを 1 本の流れで通す。途中でメニューに戻って再開・再読み込み・localStorage が使えない場合・2 つの章の頃の保存・
// ステップ中に制限時間や CPU が割り込まないことも確かめる。スクリーンショットは web/screenshots/ に保存する（*-tutorial-<番号>-<id>*）。

import { expect, test, type Page } from "@playwright/test";
import { cellName, parseCell } from "../src/engine/board";
import { lastMoveOf, playMove, useSkill } from "../src/engine/game";
import type { PieceKind } from "../src/engine/rules";
import { SKILLS, type SkillId } from "../src/engine/skills";
import { INTRO_KEY, REQUIRED_STEPS } from "../src/ui/intro";
import { FINISHED_TEXT, LESSONS, PICK_HINT, TUTORIAL_KEY, VICE_HINT, type Lesson, type LessonId } from "../src/ui/lessons";
import { RECORD_KEY } from "../src/ui/record";
import { cellAt, noHorizontalScroll, play, seedPage, startGame, stubDraws, waitHumanTurnOrEnd } from "./helpers";
import { EMPTY_STATE } from "./intro";

const SHOT = "screenshots";
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 600;
const prefix = (page: Page) => (narrow(page) ? "sp" : "pc");
const LAST = LESSONS.length - 1;
const indexOf = (id: LessonId) => LESSONS.findIndex((l) => l.id === id);

/** 各ステップで試す違う手（置けないマス・正解でないマス・違う駒・王や副将にしない・スキルを使わない）と、出るヒントの一部 */
const WRONG: Partial<Record<LessonId, { cell: string; kind: PieceKind; hint: string }>> = {
  flank: { cell: "c5", kind: "fu", hint: "そこでは白い駒を挟めない" },
  damage: { cell: "b5", kind: "fu", hint: "ダメージは 2 しかない" },
  dirs: { cell: "e4", kind: "fu", hint: "歩は縦にしか挟めない" },
  hand: { cell: "c3", kind: "fu", hint: "駒台の金をタップしてから置く" },
  anchor: { cell: "g6", kind: "fu", hint: "反対側の自分の駒は歩1" },
  heal: { cell: "g6", kind: "fu", hint: "回復は 0" },
  king: { cell: "e6", kind: "fu", hint: "王をタップする" },
  kingAuto: { cell: "c6", kind: "fu", hint: "光っているマスに歩を置く" },
  kingHit: { cell: "b6", kind: "fu", hint: "「?」の駒を挟む" },
  read: { cell: "d6", kind: "fu", hint: "置いた歩が次の相手の手で裏返される" },
  skillGauge: { cell: "b6", kind: "fu", hint: "ゲージは 1 しか溜まらない" },
  skillUse: { cell: "d5", kind: "fu", hint: "先に名札の強打を押して使う" },
  vice: { cell: "e6", kind: "fu", hint: VICE_HINT },
  viceHit: { cell: "a7", kind: "fu", hint: "「?」の駒を挟む" },
};

/** 正解の手を打った後の、コーチの 1 文（エンジンで同じ手を打って作る。スキルを使うステップは使ってから） */
function doneText(l: Lesson): string {
  const start = l.start();
  const a = l.answers[0];
  const g = a.skill ? useSkill(start, { id: start.skills!.sides[0].card! }) : start;
  const next = playMove(g, a.at[0], a.at[1], a.kind, { king: a.king, vice: a.vice });
  return l.done(lastMoveOf(next)!, g, next);
}

/** メニューの「遊び方」から始める（章を選ぶ段はない。前回の位置から） */
async function openTutorial(page: Page) {
  await expect(page.locator("#menu")).toBeVisible();
  await page.locator("#menu-learn").click();
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator("#coach")).toBeVisible();
}

async function expectStep(page: Page, i: number) {
  const l = LESSONS[i];
  await expect(page.locator("#coach-title")).toHaveText(l.title);
  await expect(page.locator("#coach-num")).toHaveText(`${i + 1}/${LESSONS.length}`);
  await expect(page.locator("#coach-point")).toHaveText(l.point);
  const note = page.locator("#coach-note");
  await (l.note ? expect(note).toHaveText(l.note) : expect(note).toBeHidden());
  await expect(page.locator("#coach-task")).toHaveText(l.task);
}

/** 盤のマスを押す（タッチは同じマスを 2 回タップで確定） */
async function press(page: Page, name: string) {
  const cell = cellAt(page, ...parseCell(name));
  if (narrow(page)) {
    await cell.tap();
    await cell.tap();
  } else {
    await cell.click();
  }
}

/** ステップを解く: 違う手でヒント → 正解で 1 文。次へは押さない */
async function solveStep(page: Page, l: Lesson, i: number) {
  const touch = narrow(page);
  const wrong = WRONG[l.id]!;
  const a = l.answers[0];
  const name = `${prefix(page)}-tutorial-${i + 1}-${l.id}`;
  // 始めの手数（「自動で王に」はお互い 6 手ずつ、「偵察」は 7 手ずつ打った局面から）
  const ply = l.start().ply;
  await expectStep(page, i);
  // 誘導: 光るマス（候補すべて）。駒台で選ぶ駒・押す王・副があれば、そこに矢印。
  // スキルを使ってから置くステップは、使うまで名札のカードだけを光らせる
  await expect(page.locator(".cell.guide")).toHaveCount(a.skill ? 0 : l.guide.length);
  if (a.skill) await expect(page.locator("#skill-use.guide .guide-arrow")).toBeVisible();
  else for (const g of l.guide) await expect(cellAt(page, ...g)).toHaveClass(/\bguide\b/);
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${name}.png` });

  // 違う手: 打たずにヒント（盤・手数は変わらない）
  const pieceBtn = page.locator(`#hand-buttons .piece-btn[data-kind=${wrong.kind}]`);
  if ((await pieceBtn.getAttribute("aria-pressed")) !== "true") await (touch ? pieceBtn.tap() : pieceBtn.click());
  await press(page, wrong.cell);
  await expect(page.locator("#coach-msg.hint")).toContainText(wrong.hint);
  await expect(page.locator("#ply")).toHaveText(`${ply} 手`);
  await expect(page.locator("#coach-actions")).toBeHidden();
  await expect(cellAt(page, ...parseCell(wrong.cell)).locator(".stone:not(.ghost)")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/${name}-hint.png` });

  // 正解: 名札のスキルを使い（光るマスはその後に出る）、駒台で駒を選び（矢印で誘導）、王・副が要るなら押してから置く
  if (a.skill) {
    await (touch ? page.locator("#skill-use").tap() : page.locator("#skill-use").click());
    await expect(page.locator(".cell.guide")).toHaveCount(l.guide.length);
    for (const g of l.guide) await expect(cellAt(page, ...g)).toHaveClass(/\bguide\b/);
    await page.screenshot({ path: `${SHOT}/${name}-used.png` });
  }
  if (a.kind !== wrong.kind) await expect(page.locator(`#hand-buttons .piece-btn.guide[data-kind=${a.kind}] .guide-arrow`)).toBeVisible();
  if (a.king) {
    await expect(page.locator("#king-toggle.guide .guide-arrow")).toBeVisible();
    await (touch ? page.locator("#king-toggle").tap() : page.locator("#king-toggle").click());
    await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "true");
  }
  if (a.vice) {
    await expect(page.locator("#vice-toggle.guide .guide-arrow")).toBeVisible();
    await (touch ? page.locator("#vice-toggle").tap() : page.locator("#vice-toggle").click());
    await expect(page.locator("#vice-toggle")).toHaveAttribute("aria-pressed", "true");
  }
  if (l.id === "kingAuto") {
    // 期限の手: 王の駒は「この手で王」で押せない（押さなくても置いた駒が王になる）
    await expect(page.locator("#king-toggle")).toContainText("この手で王");
    await expect(page.locator("#king-toggle")).toBeDisabled();
  }
  await play(page, a.at[0], a.at[1], a.kind, touch);
  await expect(page.locator("#coach-msg.ok")).toHaveText(doneText(l));
  await expect(page.locator("#ply")).toHaveText(`${ply + 1} 手`);
  await expect(cellAt(page, a.at[0], a.at[1]).locator(".stone.p0")).toBeVisible();
  await expect(page.locator(".board.acting")).toHaveCount(0);
  await expect(page.locator(".cell.guide")).toHaveCount(0);
  await expect(page.locator("#coach-next")).toHaveText(LESSONS[i + 1].match ? "実戦へ" : "次へ");
  // ステップでは終局画面もトーストも出さない
  await expect(page.locator("#result")).not.toHaveAttribute("open", "");
  await expect(page.locator("#toast")).toBeHidden();
}

/** カードを選ぶステップ: 配り直す前に選ぶとヒント → 配り直して 1 枚選ぶ。選んだカードの id を返す */
async function solvePick(page: Page): Promise<SkillId> {
  const touch = narrow(page);
  const i = indexOf("skillPick");
  const l = LESSONS[i];
  const name = `${prefix(page)}-tutorial-${i + 1}-skillPick`;
  const tap = (sel: string) => (touch ? page.locator(sel).first().tap() : page.locator(sel).first().click());
  const dialog = page.locator("#skill-pick");
  await expectStep(page, i);
  await expect(dialog).toBeVisible();
  // 選ぶ画面はコーチを覆うので、要点・補足・課題は選ぶ画面に出す。配り直しが光る
  await expect(dialog.locator(".pick-coach .coach-point")).toHaveText(l.point);
  await expect(dialog.locator(".pick-coach .coach-note")).toHaveText(l.note!);
  await expect(dialog.locator(".pick-coach .coach-task")).toHaveText(l.task);
  await expect(page.locator("#skill-pick-reroll")).toHaveClass(/\bguide\b/);
  await expect(dialog.locator(".tarot")).toHaveCount(3);
  const first = await dialog.locator(".tarot").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.skill));
  expect(first).toEqual(["firstaid", "strong", "wall"]);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOT}/${name}.png` });
  // 違う操作: 配り直す前に選ぶ → ヒント（カードは変わらない）
  await tap("#skill-pick .tarot[data-skill=strong]");
  await tap("#skill-pick-ok");
  await expect(dialog.locator(".pick-coach .coach-msg.hint")).toHaveText(PICK_HINT);
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${SHOT}/${name}-hint.png` });
  // 配り直す: 新しい 3 枚は前の 3 枚と重ならない。配り直しは押せなくなり、光らない
  await tap("#skill-pick-reroll");
  await expect(page.locator("#skill-pick-reroll")).toBeDisabled();
  await expect(page.locator("#skill-pick-reroll")).not.toHaveClass(/\bguide\b/);
  const offer = await dialog.locator(".tarot").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.skill as SkillId));
  expect(offer).toHaveLength(3);
  for (const id of offer) expect(first).not.toContain(id);
  await tap(`#skill-pick .tarot[data-skill=${offer[0]}]`);
  await tap("#skill-pick-ok");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#coach-msg.ok")).toHaveText(l.pick!.done(offer[0], l.start()));
  await expect(page.locator("#coach-next")).toHaveText("次へ");
  await expect(page.locator(".board.acting")).toHaveCount(0);
  await expect(page.locator("#toast")).toBeHidden();
  // 名札に選んだカード
  await expect(page.locator("#player-0 .plate-skill")).toContainText(SKILLS[offer[0]].name);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOT}/${name}-done.png` });
  return offer[0];
}

/** 実戦: カードを選ぶ画面（遊び方の文は出さない）で先頭のカードを選ぶ */
async function pickInMatch(page: Page) {
  const dialog = page.locator("#skill-pick");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".pick-coach")).toHaveCount(0);
  const card = page.locator("#skill-pick .tarot").first();
  await (narrow(page) ? card.tap() : card.click());
  await (narrow(page) ? page.locator("#skill-pick-ok").tap() : page.locator("#skill-pick-ok").click());
  await expect(dialog).toBeHidden();
}

/** 初めての人の遊び方の必須（ui/intro.ts）: CPU対戦・マルチに錠が付いているか */
async function expectGate(page: Page, on: boolean) {
  await expect(page.locator("#menu")).toBeVisible();
  for (const id of ["menu-cpu", "menu-multi"]) {
    const b = page.locator(`#${id}`);
    await (on ? expect(b).toHaveClass(/\blocked\b/) : expect(b).not.toHaveClass(/\blocked\b/));
  }
}

const introOf = async (page: Page) => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), INTRO_KEY)) ?? "null");

test.describe("初めての人（何も保存していない）", () => {
  test.use({ storageState: EMPTY_STATE });

  test("遊び方: メニューから始め、全ステップを違う手と正解で進み、標準の実戦を終局まで打って完了する", async ({ page }) => {
    test.setTimeout(480_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // 配るカード（配り直し・実戦）と CPU の手を決める
    await stubDraws(page, [0.3, 0.7, 0.1]);
    await seedPage(page, 7);
    await page.goto("/");
    // はじめて: メニューの「遊び方」におすすめ。CPU対戦・マルチは遊び方の実戦の前まで終えるまで閉じている。メニューのルールは標準
    await expectGate(page, true);
    await expect(page.locator("#menu-learn")).toHaveText("遊び方 おすすめ");
    await expect(page.locator("#menu-learn")).toHaveClass(/\bfresh\b/);
    await expect(page.locator("#menu-rule-name")).toHaveText("標準");
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-menu.png` });
    await openTutorial(page);

    for (const [i, l] of LESSONS.entries()) {
      if (l.match) break;
      if (l.pick) await solvePick(page);
      else {
        await solveStep(page, l, i);
        // できたの 1 文が浮かび終わってから撮る
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${i + 1}-${l.id}-done.png` });
      }
      // コーチの文が盤と重ならない（スマホ幅でも、コーチは盤の外に置く）
      await expectCoachClear(page);
      // 体力 0 で勝つ手は決着の演出が覆うので、それが消えてから押す（Playwright が待つ）
      await page.locator("#coach-next").click();
    }

    // 実戦: 標準・CPU イージー・制限時間なし。カードを選んでから打つ
    await expectStep(page, LAST);
    await expect(page.locator("#rules4-name")).toHaveText("ルール 標準");
    await expect(page.locator("#player-1")).toContainText("CPU");
    await expect(page.locator("#coach-actions")).toBeHidden();
    await pickInMatch(page);
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${LAST + 1}-match.png` });
    let ended = false;
    for (let n = 0; n < 100 && !ended; n++) {
      ended = await waitHumanTurnOrEnd(page);
      if (ended) break;
      await expect(page.locator("#turn-clock")).toHaveCount(0);
      const cell = page.locator(".cell.can-take").first();
      const [r, c] = [Number(await cell.getAttribute("data-r")), Number(await cell.getAttribute("data-c"))];
      await press(page, cellName(r, c));
      await expect(page.locator(".board.acting")).toHaveCount(0);
    }
    expect(ended).toBe(true);
    await expect(page.locator("#result")).toHaveAttribute("open", "");
    await expect(page.locator("#coach-msg.ok")).toHaveText(FINISHED_TEXT);
    // 最後なので「次へ」はない
    await expect(page.locator("#coach-actions")).toBeHidden();
    // 遊び方の実戦は通算に数えない（終局画面にも名札にも出さない）
    expect(await page.evaluate((k) => localStorage.getItem(k), RECORD_KEY)).toBeNull();
    await expect(page.locator("#result-detail .score th", { hasText: "通算" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${LAST + 1}-match-result.png` });
    await page.locator("#result-view").click();
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${LAST + 1}-match-board.png` });
    await page.locator("#btn-menu").click();
    await expect(page.locator("#menu-learn")).toHaveText("遊び方 クリア済み");
    await expect(page.locator("#menu-learn")).not.toHaveClass(/\bfresh\b/);
    expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), TUTORIAL_KEY))!)).toEqual({ v: 2, step: LAST, reached: LAST, done: true });
    // 終えた後は最初から。どのステップへも石で移れる
    await openTutorial(page);
    await expectStep(page, 0);
    await expect(page.locator(".coach-dot:not(:disabled)")).toHaveCount(LESSONS.length - 1);
    await noHorizontalScroll(page, page.viewportSize()!.width);
    // CPU対戦・マルチが開いている（再読み込みしても）
    await page.locator("#btn-menu").click();
    await expectGate(page, false);
    expect(await introOf(page)).toEqual({ v: 1, state: "cleared" });
    await page.reload();
    await expectGate(page, false);
    expect(errors).toEqual([]);
  });

  test("遊び方: 15 ステップ目の手前でやめて再読み込みしても閉じたまま。15 ステップ目を解けば実戦をしなくても開き、再読み込みしても開いたまま", async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    expect(REQUIRED_STEPS).toBe(LAST);
    // 初めての人が 14 ステップ目まで進めてある（最初に開いたときだけ入れる）
    await page.addInitScript(
      ([ik, tk, step]) => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem(ik, JSON.stringify({ v: 1, state: "new" }));
        localStorage.setItem(tk, JSON.stringify({ v: 2, step, reached: step, done: false }));
      },
      [INTRO_KEY, TUTORIAL_KEY, REQUIRED_STEPS - 2] as const,
    );
    await page.goto("/");
    await expectGate(page, true);
    await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき ${REQUIRED_STEPS - 1}/${LESSONS.length}`);
    // 14 ステップ目を解いて 15 ステップ目を開き、解かずに再読み込み: 閉じたまま、15 ステップ目から
    await openTutorial(page);
    await solveStep(page, LESSONS[REQUIRED_STEPS - 2], REQUIRED_STEPS - 2);
    await page.locator("#coach-next").click();
    await expectStep(page, REQUIRED_STEPS - 1);
    await page.reload();
    await expectGate(page, true);
    await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき ${REQUIRED_STEPS}/${LESSONS.length}`);
    expect(await introOf(page)).toEqual({ v: 1, state: "new" });
    // 15 ステップ目を解く: 「実戦へ」を押さずにメニューへ戻ると開いている
    await openTutorial(page);
    await solveStep(page, LESSONS[REQUIRED_STEPS - 1], REQUIRED_STEPS - 1);
    await expect(page.locator("#coach-next")).toHaveText("実戦へ");
    await page.locator("#btn-menu").click();
    await expectGate(page, false);
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-intro-cleared.png` });
    expect(await introOf(page)).toEqual({ v: 1, state: "cleared" });
    await page.reload();
    await expectGate(page, false);
    // 実戦は任意: 遊び方は 15 ステップ目のまま（クリア済みではない）
    await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき ${REQUIRED_STEPS}/${LESSONS.length}`);
    await startGame(page, { preset: "std" });
    await expect(page.locator(".board.acting")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

/** コーチ（#coach）と盤（#board）が重ならない */
async function expectCoachClear(page: Page) {
  const coach = await page.locator("#coach").boundingBox();
  const board = await page.locator("#board").boundingBox();
  expect(coach && board).toBeTruthy();
  const overlap = !(coach!.x + coach!.width <= board!.x || board!.x + board!.width <= coach!.x || coach!.y + coach!.height <= board!.y || board!.y + board!.height <= coach!.y);
  expect(overlap, `coach ${JSON.stringify(coach)} board ${JSON.stringify(board)}`).toBe(false);
}

test("遊び方: 途中でメニューに戻って続き・再読み込みで前回の位置・石で前のステップへ。ほかの対局ではコーチを出さない", async ({ page }) => {
  await page.goto("/");
  await openTutorial(page);
  await solveStep(page, LESSONS[0], 0);
  await page.locator("#coach-next").click();
  await expectStep(page, 1);

  // メニューへ → 対局に戻る（同じステップの続き）
  await page.locator("#btn-menu").click();
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき 2/${LESSONS.length}`);
  await expect(page.locator("#menu-resume")).toBeVisible();
  await page.locator("#menu-resume").click();
  await expectStep(page, 1);
  await expect(page.locator(".board.acting")).toBeVisible();

  // 「?」は習っている標準ルールの詳細（ステップの途中のルールではなく）
  await page.locator("#btn-rules").click();
  await expect(page.locator("#rules-title")).toHaveText("標準のルール");
  await page.locator("#rules-close").click();

  // 再読み込みしても前回の位置から
  await page.reload();
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき 2/${LESSONS.length}`);
  await openTutorial(page);
  await expectStep(page, 1);
  // 開いたことのないステップへは移れない。前のステップへは石で戻れる
  await expect(page.locator(".coach-dot")).toHaveCount(LESSONS.length);
  await expect(page.locator(".coach-dot").nth(2)).toBeDisabled();
  await page.locator(".coach-dot").nth(0).click();
  await expectStep(page, 0);
  // 解いた後の「もう一度」で同じステップを初めから
  await solveStep(page, LESSONS[0], 0);
  await page.locator("#coach-again").click();
  await expectStep(page, 0);
  await expect(page.locator("#ply")).toHaveText("0 手");

  // ふつうの CPU 対戦ではコーチを出さず、ルールは既定の標準（カードを選ぶ画面から）
  await page.locator("#btn-menu").click();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=easy]").click();
  await expect(page.locator("#coach")).toBeHidden();
  await expect(page.locator("#rules4-name")).toHaveText("ルール 標準");
  await expect(page.locator("#skill-pick")).toBeVisible();
  await expect(page.locator("#skill-pick .pick-coach")).toHaveCount(0);
  await expect(page.locator(".cell.guide")).toHaveCount(0);
});

test("遊び方: 副将のステップから途中でやめても、再開すると同じステップ（カードを選ぶステップは配られた 3 枚から選び直す）", async ({ page }) => {
  await page.addInitScript(
    ([key, step]) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, JSON.stringify({ v: 2, step, reached: step, done: false }));
        sessionStorage.setItem("seeded", "1");
      }
    },
    [TUTORIAL_KEY, indexOf("vice")] as const,
  );
  await page.goto("/");
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき ${indexOf("vice") + 1}/${LESSONS.length}`);
  await openTutorial(page);
  await expectStep(page, indexOf("vice"));
  await expect(page.locator("#vice-toggle.guide .guide-arrow")).toBeVisible();
  // メニューへ戻って再読み込みしても同じステップ
  await page.locator("#btn-menu").click();
  await page.reload();
  await openTutorial(page);
  await expectStep(page, indexOf("vice"));
  // 石でカードを選ぶステップへ戻ると、選ぶ画面からやり直せる
  await page.locator(".coach-dot").nth(indexOf("skillPick")).click();
  await expectStep(page, indexOf("skillPick"));
  await expect(page.locator("#skill-pick")).toBeVisible();
  await expect(page.locator("#skill-pick-reroll")).toBeEnabled();
});

test("遊び方: 2 つの章に分かれていた頃の保存は、今の 1 本の流れの位置で開く。壊れた保存は はじめて", async ({ page }) => {
  const cases: { saved: string; label: string; step: number }[] = [
    // 基本のルールの 4 ステップ目（予測を読むまでは同じ位置）
    { saved: JSON.stringify({ step: 3, reached: 5, done: false }), label: `つづき 4/${LESSONS.length}`, step: 3 },
    // 基本のルールを終えて、スキルありの章の 2 ステップ目（ゲージ）
    {
      saved: JSON.stringify({ step: 10, reached: 10, done: true, skill: { step: 1, reached: 1, done: false } }),
      label: `つづき ${indexOf("skillGauge") + 1}/${LESSONS.length}`,
      step: indexOf("skillGauge"),
    },
    // 両方の章を終えた
    { saved: JSON.stringify({ step: 10, reached: 10, done: true, skill: { step: 6, reached: 6, done: true } }), label: "クリア済み", step: 0 },
    // 壊れた保存
    { saved: "{oops", label: "おすすめ", step: 0 },
  ];
  for (const c of cases) {
    await page.goto("/");
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [TUTORIAL_KEY, c.saved] as const);
    await page.reload();
    await expect(page.locator("#menu-learn")).toHaveText(`遊び方 ${c.label}`);
    await openTutorial(page);
    await expectStep(page, c.step);
    // 開くと今の形で保存し直す
    const saved = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), TUTORIAL_KEY))!);
    expect(saved).toMatchObject({ v: 2, step: c.step });
    expect(saved.skill).toBeUndefined();
  }
});

test("遊び方: localStorage が使えなくても最初から動く（進み具合は覚えない）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#menu-learn")).toHaveText("遊び方 おすすめ");
  await openTutorial(page);
  await solveStep(page, LESSONS[0], 0);
  await page.locator("#coach-next").click();
  await expectStep(page, 1);
  await page.locator("#btn-menu").click();
  // この画面の中では続きを覚えている（保存できないだけ）
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき 2/${LESSONS.length}`);
  expect(errors).toEqual([]);
});

test("遊び方のステップでは制限時間も CPU も割り込まない（CPU 対戦の制限時間を 20 秒にしていても）", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kyosho:settings", JSON.stringify({ timeCpu: "20" })));
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator("#menu-cpu")).toBeVisible();
  await openTutorial(page);
  await expectStep(page, 0);
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  // 1 分待っても時間切れの自動の手は打たれない
  await page.clock.fastForward(60_000);
  await expect(page.locator("#ply")).toHaveText("0 手");
  await expect(page.locator(".board.acting")).toBeVisible();
  const a = LESSONS[0].answers[0];
  await play(page, a.at[0], a.at[1], a.kind, narrow(page));
  await expect(page.locator("#coach-msg.ok")).toBeVisible();
  // 正解の後も CPU は打たない（「次へ」を待つ）
  await page.clock.fastForward(60_000);
  await expect(page.locator("#ply")).toHaveText("1 手");
  await expect(page.locator("#status")).toHaveText("クリア");
});

test("遊び方の実戦は標準・制限時間なしで、カードを選んだ後に CPU（イージー）が打ち返す", async ({ page }) => {
  await seedPage(page, 5);
  await page.addInitScript(
    ([key, step]) => {
      localStorage.setItem("kyosho:settings", JSON.stringify({ timeCpu: "20" }));
      // 実戦の手前まで進めた状態
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, JSON.stringify({ v: 2, step, reached: step, done: false }));
        sessionStorage.setItem("seeded", "1");
      }
    },
    [TUTORIAL_KEY, LAST] as const,
  );
  await page.goto("/");
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき ${LESSONS.length}/${LESSONS.length}`);
  await openTutorial(page);
  await expectStep(page, LAST);
  await pickInMatch(page);
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  const cell = page.locator(".cell.can-take").first();
  const [r, c] = [Number(await cell.getAttribute("data-r")), Number(await cell.getAttribute("data-c"))];
  await press(page, cellName(r, c));
  await expect(page.locator("#ply")).toHaveText("2 手", { timeout: 10_000 });
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  // 実戦は CPU イージーでも待ったを出さない
  await expect(page.locator("#btn-undo")).toHaveCount(0);
});
