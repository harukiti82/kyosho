// 遊び方（チュートリアル）: メニューから始め、各ステップで違う手（ヒントが出て盤は変わらない）→ 正解（何が起きたかの 1 文）を打ち、
// 最後の実戦（CPU イージー・制限時間なし）を終局まで打つ。途中でメニューに戻って再開・再読み込み・localStorage が使えない場合・
// ステップ中に制限時間や CPU が割り込まないことも確かめる。スクリーンショットは web/screenshots/ に保存する。

import { expect, test, type Page } from "@playwright/test";
import { cellName, parseCell } from "../src/engine/board";
import { lastMoveOf, playMove } from "../src/engine/game";
import type { PieceKind } from "../src/engine/rules";
import { FINISHED_TEXT, LESSONS, TUTORIAL_KEY, type Lesson, type LessonId } from "../src/ui/lessons";
import { RECORD_KEY } from "../src/ui/record";
import { cellAt, noHorizontalScroll, play, seedPage, waitHumanTurnOrEnd } from "./helpers";

const SHOT = "screenshots";
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 600;
const prefix = (page: Page) => (narrow(page) ? "sp" : "pc");

/** 各ステップで試す違う手（置けないマス・正解でないマス・違う駒・王にしない）と、出るヒントの一部 */
const WRONG: Record<Exclude<LessonId, "match">, { cell: string; kind: PieceKind; hint: string }> = {
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
};

/** 正解の手を打った後の、コーチの 1 文（エンジンで同じ手を打って作る） */
function doneText(l: Lesson): string {
  const g = l.start();
  const a = l.answers[0];
  return l.done(lastMoveOf(playMove(g, a.at[0], a.at[1], a.kind, { king: a.king }))!, g);
}

async function openTutorial(page: Page) {
  await expect(page.locator("#menu")).toBeVisible();
  await page.locator("#menu-learn").click();
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator("#coach")).toBeVisible();
}

async function expectStep(page: Page, i: number) {
  await expect(page.locator("#coach-title")).toHaveText(LESSONS[i].title);
  await expect(page.locator("#coach-num")).toHaveText(`${i + 1}/${LESSONS.length}`);
  await expect(page.locator("#coach-point")).toHaveText(LESSONS[i].point);
  const note = page.locator("#coach-note");
  await (LESSONS[i].note ? expect(note).toHaveText(LESSONS[i].note!) : expect(note).toBeHidden());
  await expect(page.locator("#coach-task")).toHaveText(LESSONS[i].task);
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
  const wrong = WRONG[l.id as Exclude<LessonId, "match">];
  const a = l.answers[0];
  // 始めの手数（「自動で王に」はお互い 6 手ずつ打った局面から）
  const ply = l.start().ply;
  await expectStep(page, i);
  // 誘導: 光るマス（候補すべて）。駒台で選ぶ駒・押す王があれば、そこに矢印
  await expect(page.locator(".cell.guide")).toHaveCount(l.guide.length);
  for (const g of l.guide) await expect(cellAt(page, ...g)).toHaveClass(/\bguide\b/);
  await expect(page.locator(".board.acting")).toBeVisible();
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${i + 1}-${l.id}.png` });

  // 違う手: 打たずにヒント（盤・手数は変わらない）
  const pieceBtn = page.locator(`#hand-buttons .piece-btn[data-kind=${wrong.kind}]`);
  if ((await pieceBtn.getAttribute("aria-pressed")) !== "true") await (touch ? pieceBtn.tap() : pieceBtn.click());
  await press(page, wrong.cell);
  await expect(page.locator("#coach-msg.hint")).toContainText(wrong.hint);
  await expect(page.locator("#ply")).toHaveText(`${ply} 手`);
  await expect(page.locator("#coach-actions")).toBeHidden();
  await expect(cellAt(page, ...parseCell(wrong.cell)).locator(".stone:not(.ghost)")).toHaveCount(0);
  if (i === 2 || i === 6 || l.id === "kingAuto") await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${i + 1}-${l.id}-hint.png` });

  // 正解: 駒台で駒を選び（矢印で誘導）、王が要るなら王を押してから置く
  if (a.kind !== wrong.kind) await expect(page.locator(`#hand-buttons .piece-btn.guide[data-kind=${a.kind}] .guide-arrow`)).toBeVisible();
  if (a.king) {
    await expect(page.locator("#king-toggle.guide .guide-arrow")).toBeVisible();
    await (touch ? page.locator("#king-toggle").tap() : page.locator("#king-toggle").click());
    await expect(page.locator("#king-toggle")).toHaveAttribute("aria-pressed", "true");
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

test("遊び方: メニューから始め、全ステップを違う手と正解で進み、実戦を終局まで打って完了する", async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await seedPage(page, 11);
  await page.goto("/");
  // はじめて: メニューの「遊び方」に控えめなおすすめ（押し付けない。ほかの入口はそのまま）
  await expect(page.locator("#menu-learn")).toHaveText("遊び方 おすすめ");
  await expect(page.locator("#menu-learn")).toHaveClass(/\bfresh\b/);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-menu.png` });
  await openTutorial(page);

  for (const [i, l] of LESSONS.entries()) {
    if (l.match) break;
    await solveStep(page, l, i);
    // できたの 1 文が浮かび終わってから撮る
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${i + 1}-${l.id}-done.png` });
    // 体力 0 で勝つ手は決着の演出が覆うので、それが消えてから押す（Playwright が待つ）
    await page.locator("#coach-next").click();
  }

  // 実戦: 標準・CPU イージー・制限時間なし
  const last = LESSONS.length - 1;
  await expectStep(page, last);
  await expect(page.locator("#rules4-name")).toHaveText("ルール 標準");
  await expect(page.locator("#player-1")).toContainText("CPU");
  await expect(page.locator("#coach-actions")).toBeHidden();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${last + 1}-match.png` });
  let ended = false;
  for (let n = 0; n < 80 && !ended; n++) {
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
  // 遊び方の実戦は通算に数えない（終局画面にも名札にも出さない）
  expect(await page.evaluate((k) => localStorage.getItem(k), RECORD_KEY)).toBeNull();
  await expect(page.locator("#result-detail .score th", { hasText: "通算" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${last + 1}-match-result.png` });
  await page.locator("#result-view").click();
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-tutorial-${last + 1}-match-board.png` });
  await page.locator("#btn-menu").click();
  await expect(page.locator("#menu-learn")).toHaveText("遊び方 クリア済み");
  await expect(page.locator("#menu-learn")).not.toHaveClass(/\bfresh\b/);
  // 終えた後は最初から。どのステップへも石で移れる
  await openTutorial(page);
  await expectStep(page, 0);
  await expect(page.locator(".coach-dot:not(:disabled)")).toHaveCount(LESSONS.length - 1);
  expect(errors).toEqual([]);
});

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

  // ふつうの CPU 対戦ではコーチを出さず、ルールは標準
  await page.locator("#btn-menu").click();
  await page.locator("#menu-cpu").click();
  await page.locator("#menu-levels [data-level=easy]").click();
  await expect(page.locator("#coach")).toBeHidden();
  await expect(page.locator("#rules4-name")).toHaveText("ルール 標準");
  await expect(page.locator(".cell.guide")).toHaveCount(0);
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

test("遊び方の実戦は制限時間なしで、CPU（イージー）が打ち返す", async ({ page }) => {
  await seedPage(page, 5);
  await page.addInitScript(
    ([key, step]) => {
      localStorage.setItem("kyosho:settings", JSON.stringify({ timeCpu: "20" }));
      // 実戦の手前まで進めた状態
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, JSON.stringify({ step, reached: step, done: false }));
        sessionStorage.setItem("seeded", "1");
      }
    },
    [TUTORIAL_KEY, LESSONS.length - 1] as const,
  );
  await page.goto("/");
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき ${LESSONS.length}/${LESSONS.length}`);
  await openTutorial(page);
  await expectStep(page, LESSONS.length - 1);
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
