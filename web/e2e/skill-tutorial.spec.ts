// スキル練習（メニューの「スキル練習」→ 11 枚の一覧 → カードごとの練習）: 11 枚すべてを入口から開いて、使う前に置こうとしたヒント・
// 違う指定のヒント → 名札のカードを使う → 指定（補充の駒・王を移す先・運命の輪で出た補充）→ 光っているマスに置く（連続行動は 2 手目、
// 鉄壁は相手の応手まで）→ 何が起きたかの 1 文、までを打つ。終えたカードの印・再読み込み・壊れた保存・localStorage なし・
// メインの遊び方の保存を変えないこと・途中でメニューから別のカードを開くこと・制限時間と CPU とトーストが割り込まないことも確かめる。
// スクリーンショットは web/screenshots/ に保存する（*-skilltut-<番号>-<id>-before / -after、一覧は *-skilltut-list*）。

import { expect, test, type Page } from "@playwright/test";
import { parseCell } from "../src/engine/board";
import { lastMoveOf, playMove, useSkill, wheelPool, type GameState } from "../src/engine/game";
import { SKILL_ORDER, SKILLS, type SkillId, type SkillUse } from "../src/engine/skills";
import { LESSONS, TUTORIAL_KEY, type Lesson } from "../src/ui/lessons";
import { SKILL_LESSONS, SKILL_TUTORIAL_KEY, wheelRng } from "../src/ui/skilllessons";
import { cellAt, noHorizontalScroll, play } from "./helpers";

const SHOT = "screenshots";
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 600;
const prefix = (page: Page) => (narrow(page) ? "sp" : "pc");
const N = SKILL_LESSONS.length;

/** 画面と同じ手順をエンジンで打ったときの、コーチのできたの 1 文 */
function doneText(l: Lesson): string {
  const start = l.start();
  const card = start.skills!.sides[0].card!;
  const rng = l.wheel ? wheelRng(wheelPool(start.rules), l.wheel) : undefined;
  const aim: Partial<SkillUse> = card === "refill" || card === "kingmove" ? { ...l.aim } : {};
  let g = useSkill(start, { id: card, ...aim }, rng);
  if (g.skills!.armed?.aim) g = useSkill(g, { id: card, ...l.aim });
  const a = l.answers[0];
  let before: GameState = g;
  let after = playMove(g, a.at[0], a.at[1], a.kind);
  for (const b of [l.then?.answers[0], l.reply].filter((x) => !!x)) {
    before = after;
    after = playMove(after, b.at[0], b.at[1], b.kind);
  }
  return l.done(lastMoveOf(after)!, before, after);
}

async function tap(page: Page, selector: string) {
  const el = page.locator(selector);
  await (narrow(page) ? el.tap() : el.click());
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

/** コーチ（#coach）と盤（#board）が重ならない */
async function expectCoachClear(page: Page) {
  const coach = await page.locator("#coach").boundingBox();
  const board = await page.locator("#board").boundingBox();
  expect(coach && board).toBeTruthy();
  const overlap = !(coach!.x + coach!.width <= board!.x || board!.x + board!.width <= coach!.x || coach!.y + coach!.height <= board!.y || board!.y + board!.height <= coach!.y);
  expect(overlap, `coach ${JSON.stringify(coach)} board ${JSON.stringify(board)}`).toBe(false);
}

/** 盤と名札の有限の動き（着手・被弾の演出）が終わるのを待つ（光の輪など繰り返す動きは待たない） */
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
  );
}

/** メニューの「スキル練習」で一覧を開く */
async function openList(page: Page) {
  await expect(page.locator("#menu")).toBeVisible();
  await tap(page, "#menu-skills");
  await expect(page.locator("#menu-skilllist")).toBeVisible();
  await expect(page.locator("#skill-lessons .tarot")).toHaveCount(N);
  // 札が下から出てくる動き（menu-in）が終わるまで待つ（スクリーンショットが途中の薄い札にならないように）
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || !(a as CSSAnimation).animationName?.startsWith("menu-in")));
}

/** 一覧からカードを開く */
async function openCard(page: Page, id: SkillId) {
  await tap(page, `#skill-lessons .tarot[data-skill=${id}]`);
  await expect(page.locator("#menu")).toBeHidden();
  await expect(page.locator("#coach-title")).toHaveText(SKILLS[id].name);
}

/** 1 枚のステップを解く（違う操作のヒント → 使う → 指定 → 置く → できたの 1 文）。「次へ」は押さない */
async function solveCard(page: Page, l: Lesson, i: number) {
  const touch = narrow(page);
  const id = l.id as SkillId;
  const name = `${prefix(page)}-skilltut-${String(i + 1).padStart(2, "0")}-${id}`;
  const ply = l.start().ply;
  await expect(page.locator("#coach-num")).toHaveText(`${i + 1}/${N}`);
  await expect(page.locator("#coach-point")).toHaveText(l.point);
  await expect(page.locator("#coach-task")).toHaveText(l.task);
  // 使うまでは名札のカードだけを光らせ、制限時間は出さない
  await expect(page.locator("#skill-use.guide .guide-arrow")).toBeVisible();
  await expect(page.locator(".cell.guide")).toHaveCount(0);
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  await noHorizontalScroll(page, page.viewportSize()!.width);
  if (touch) await expectCoachClear(page);
  await settle(page);
  await page.screenshot({ path: `${SHOT}/${name}-before.png` });

  // 使う前に置こうとした: 打たずにヒント
  const a = l.answers[0];
  await press(page, `${"abcdefgh"[a.at[1]]}${a.at[0] + 1}`);
  await expect(page.locator("#coach-msg.hint")).toHaveText(`先に名札の${SKILLS[id].name}を押して使う`);
  await expect(page.locator("#ply")).toHaveText(`${ply} 手`);

  // 使う
  await tap(page, "#skill-use");
  if (l.aim?.kind) {
    // 戻す駒を選ぶ（運命の輪は出た補充の指定。演出の後に出る）。違う駒はヒントで、使われない
    await expect(page.locator(`[data-refill=${l.aim.kind}].guide .guide-arrow`)).toBeVisible();
    await tap(page, "[data-refill=fu]");
    await expect(page.locator("#coach-msg.hint")).toHaveText(`この練習では金を戻す`);
    await expect(page.locator("[data-refill=fu]")).toBeVisible();
    if (id === "wheel") await expect(page.locator("#skill-cancel")).toHaveCount(0);
    await tap(page, `[data-refill=${l.aim.kind}]`);
    await expect(page.locator(`#hand-buttons .piece-btn[data-kind=${l.aim.kind}] .piece-count`)).toHaveText("1");
  }
  if (l.aim?.to) {
    // 王を移す先: 移せる駒だけが光る。押すと王の印が移る
    const to = cellAt(page, ...l.aim.to);
    await expect(to).toHaveClass(/\bskill-target\b/);
    await expect(to.locator(".guide-arrow")).toBeVisible();
    await expect(page.locator(".cell.skill-target")).toHaveCount(1);
    await (touch ? to.tap() : to.click());
    await expect(to.locator(".stone.p0.king")).toBeVisible();
    await expect(cellAt(page, 6, 1).locator(".threat.king")).toHaveCount(0);
  }
  // 使った後は置くマスが光る（演出の後）
  await expect(page.locator(".cell.guide")).toHaveCount(l.guide.length);
  if (id === "judge") {
    // 巻き戻し: 2 手戻る。さっき挟み返された手を打ち直そうとしたらヒント
    await expect(page.locator("#ply")).toHaveText("0 手");
    await press(page, "c5");
    await expect(page.locator("#coach-msg.hint")).toHaveText("そこはさっき挟み返された手。光っているマスに置く");
  }
  const before = Number((await page.locator("#ply").textContent())!.replace(/\D/g, ""));
  await play(page, a.at[0], a.at[1], a.kind, touch);
  if (l.then) {
    // 連続行動: 1 手目の後も自分の手番。課題が 2 手目に変わる
    await expect(page.locator("#coach-task")).toHaveText(l.then.task);
    await expect(page.locator(".cell.guide")).toHaveCount(l.then.guide.length);
    const b = l.then.answers[0];
    await play(page, b.at[0], b.at[1], b.kind, touch);
  }
  await expect(page.locator("#coach-msg.ok")).toHaveText(doneText(l), { timeout: 10_000 });
  const moves = 1 + (l.then ? 1 : 0) + (l.reply ? 1 : 0);
  await expect(page.locator("#ply")).toHaveText(`${before + moves} 手`);
  await expect(page.locator(".board.acting")).toHaveCount(0);
  await expect(page.locator("#coach-next")).toHaveText(i + 1 < N ? "次のカード" : "一覧へ");
  // 終えたカードの石に印
  await expect(page.locator("#coach-steps .coach-dot").nth(i)).toHaveClass(/\bdone\b/);
  // ステップでは終局画面もトーストも出さない
  await expect(page.locator("#result")).not.toHaveAttribute("open", "");
  await expect(page.locator("#toast")).toBeHidden();
  await noHorizontalScroll(page, page.viewportSize()!.width);
  if (touch) await expectCoachClear(page);
  await settle(page);
  await page.screenshot({ path: `${SHOT}/${name}-after.png` });
}

test("スキル練習: 11 枚を一覧から順に打ち、終えた印が再読み込みしても残る。メインの遊び方の保存は変えない", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript((k) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem(k, JSON.stringify({ v: 2, step: 3, reached: 5, done: false }));
      sessionStorage.setItem("seeded", "1");
    }
  }, TUTORIAL_KEY);
  await page.goto("/");
  await expect(page.locator("#menu-skills")).toHaveText(`スキル練習 ${N} 枚`);
  await openList(page);
  await expect(page.locator("#skill-lessons .tarot-clear")).toHaveCount(0);
  await expect(page.locator(`#skill-lessons .tarot.next[data-skill=${SKILL_ORDER[0]}]`)).toBeVisible();
  await noHorizontalScroll(page, page.viewportSize()!.width);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-skilltut-list.png`, fullPage: true });

  await openCard(page, SKILL_ORDER[0]);
  for (const [i, l] of SKILL_LESSONS.entries()) {
    await solveCard(page, l, i);
    await tap(page, "#coach-next");
    if (i + 1 < N) await expect(page.locator("#coach-title")).toHaveText(SKILL_LESSONS[i + 1].title);
  }
  // 最後のカードの「一覧へ」は一覧の段に戻る
  await expect(page.locator("#menu-skilllist")).toBeVisible();
  await expect(page.locator("#skill-lessons .tarot-clear")).toHaveCount(N);
  await expect(page.locator("#menu-skilllist-count")).toHaveText(` ${N}/${N}`);
  expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), SKILL_TUTORIAL_KEY))!)).toEqual({ v: 1, done: SKILL_ORDER });
  expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), TUTORIAL_KEY))!)).toEqual({ v: 2, step: 3, reached: 5, done: false });

  await page.reload();
  await expect(page.locator("#menu-skills")).toHaveText("スキル練習 クリア済み");
  await expect(page.locator("#menu-learn")).toHaveText(`遊び方 つづき 4/${LESSONS.length}`);
  await openList(page);
  await expect(page.locator("#skill-lessons .tarot-clear")).toHaveCount(N);
  await expect(page.locator("#skill-lessons .tarot.next")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT}/${prefix(page)}-skilltut-list-done.png`, fullPage: true });
});

test("スキル練習: 途中でメニューに戻って別のカードを開ける。鉄壁の応手はメニューを開いている間は待ち、戻ると打たれる", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kyosho:settings", JSON.stringify({ timeCpu: "20" })));
  await page.goto("/");
  await openList(page);
  await openCard(page, "strong");
  await page.locator("#btn-menu").click();
  await expect(page.locator("#menu-resume")).toBeVisible();
  await openList(page);
  await openCard(page, "wall");
  await expect(page.locator("#coach-num")).toHaveText(`${SKILL_ORDER.indexOf("wall") + 1}/${N}`);
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  // 正解を打ってすぐメニューへ: 応手は打たれない
  const l = SKILL_LESSONS[SKILL_ORDER.indexOf("wall")];
  await tap(page, "#skill-use");
  await expect(page.locator(".cell.guide")).toHaveCount(1);
  const a = l.answers[0];
  await play(page, a.at[0], a.at[1], a.kind, narrow(page));
  await expect(page.locator("#ply")).toHaveText("1 手");
  await page.locator("#btn-menu").click();
  await page.waitForTimeout(2500);
  await tap(page, "#menu-resume");
  await expect(page.locator("#ply")).toHaveText("2 手", { timeout: 10_000 });
  await expect(page.locator("#coach-msg.ok")).toHaveText(doneText(l));
  // 制限時間は出ず、CPU はそれ以上打たない
  await page.waitForTimeout(2500);
  await expect(page.locator("#ply")).toHaveText("2 手");
  await expect(page.locator("#turn-clock")).toHaveCount(0);
  await expect(page.locator("#toast")).toBeHidden();
});

test("スキル練習: 壊れた保存でも始められ、localStorage が使えなくても動く", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((k) => localStorage.setItem(k, "{"), SKILL_TUTORIAL_KEY);
  await page.goto("/");
  await expect(page.locator("#menu-skills")).toHaveText(`スキル練習 ${N} 枚`);
  await openList(page);
  await openCard(page, "firstaid");
  await solveCard(page, SKILL_LESSONS[0], 0);
  expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), SKILL_TUTORIAL_KEY))!)).toEqual({ v: 1, done: ["firstaid"] });

  const p2 = await page.context().newPage();
  p2.on("pageerror", (e) => errors.push(String(e)));
  await p2.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await p2.goto("/");
  await expect(p2.locator("#menu-skills")).toHaveText(`スキル練習 ${N} 枚`);
  await openList(p2);
  await openCard(p2, "strong");
  await solveCard(p2, SKILL_LESSONS[SKILL_ORDER.indexOf("strong")], SKILL_ORDER.indexOf("strong"));
  await p2.locator("#btn-menu").click();
  // この画面の中では覚えている（保存できないだけ）
  await expect(p2.locator("#menu-skills")).toHaveText(`スキル練習 1/${N}`);
  expect(errors).toEqual([]);
});
