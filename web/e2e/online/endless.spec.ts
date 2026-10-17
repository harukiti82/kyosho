// エンドレスマッチ: メニューから始めて勝つと次の段階（Lv）へ・負けると挑戦の終わりでランキングに載る・途中で閉じて開き直すと続きから・
// 端末のトークンが壊れていたら始め直し・連勝数を localStorage に書いてもランキングは変わらない。
// サーバーは e2e 用の var TEST_ENDLESS で、start の test（window.kyoshoEndlessTest）から体力と CPU を決める。
// 体力 [1, 1] なら先に返した方が勝つ: 1 局目はプレイヤーが先手なので勝ち、2 局目は CPU が先手なので負ける

import { expect, test, type Page } from "@playwright/test";
import type { EndlessStateMessage, RankingResponse, StateMessage } from "../../src/net/protocol";
import { play } from "../helpers";
import { bestMove, prefix, SHOT } from "./net";

interface EPlayer {
  page: Page;
  touch: boolean;
  /** 届いたエンドレスの状態（順に） */
  states: EndlessStateMessage[];
}

/** エンドレスの状態を記録するページ（体力と CPU の上書きを入れてからトップを開く） */
async function open(page: Page, touch: boolean, test?: object): Promise<EPlayer> {
  const p: EPlayer = { page, touch, states: [] };
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      const text = typeof f.payload === "string" ? f.payload : f.payload.toString("utf8");
      try {
        const m = JSON.parse(text);
        if (m.type === "endless") p.states.push(m);
      } catch {
        // pong
      }
    }),
  );
  if (test) await page.addInitScript((t) => ((window as unknown as { kyoshoEndlessTest: object }).kyoshoEndlessTest = t), test);
  await page.goto("/");
  await expect(page.locator("#menu")).toBeVisible();
  return p;
}

const last = (p: EPlayer) => p.states.at(-1)!;
const tap = (p: EPlayer, sel: string) => (p.touch ? p.page.locator(sel).first().tap() : p.page.locator(sel).first().click());

/** メニューの CPU対戦 → エンドレス */
async function enter(p: EPlayer) {
  await tap(p, "#menu-cpu");
  await expect(p.page.locator("#menu-endless")).toBeVisible();
  await tap(p, "#menu-endless");
}

/** カードを選ぶ（配られた最初のカード） */
async function pick(p: EPlayer) {
  const dialog = p.page.locator("#skill-pick");
  await expect(dialog.locator(".tarot")).toHaveCount(3, { timeout: 15_000 });
  await tap(p, "#skill-pick .tarot[data-skill]");
  await tap(p, "#skill-pick-ok");
  await expect.poll(() => last(p).run?.view.skills?.ready).toBe(true);
}

/** プレイヤーの手番で 1 手（返す駒が最も多い手） */
async function move(p: EPlayer) {
  await expect(p.page.locator(".board.acting")).toBeVisible({ timeout: 30_000 });
  const run = last(p).run!;
  const before = run.view.history.length;
  const mv = bestMove({ view: run.view } as StateMessage);
  await play(p.page, mv.r, mv.c, mv.kind, p.touch);
  await expect.poll(() => last(p).run!.view.history.length, { timeout: 15_000 }).toBeGreaterThan(before);
}

const result = (p: EPlayer) => p.page.locator("#result");

test("勝つと次の Lv（先手と後手が入れ替わり CPU が先に打つ）、負けると挑戦の終わり。ランキングに名前と連勝数が載り、新しく挑戦すると Lv 1 から", async ({ page }, info) => {
  const touch = !!info.project.use.hasTouch;
  const name = `勝ち${info.project.name === "desktop" ? "P" : "S"}${Date.now() % 1000}`;
  const p = await open(page, touch, { hp: [1, 1], cpu: "easy" });
  // 名前を決めておく（ランキングに出る）
  await tap(p, "#menu-name");
  await page.locator("#name-dialog-field input").fill(name);
  await tap(p, "#name-dialog-ok");
  await expect(page.locator("#menu-name-text")).toHaveText(name);

  // このゲームについて: エンドレスの記録（端末の番号・連勝数・名前を送り、ランキングで全員に見える）
  await tap(p, "#menu-about");
  await expect(page.locator("#about-endless")).toBeVisible();
  await expect(page.locator("#about-endless")).toContainText("ランキングで全員に見えます");
  await tap(p, "#about-close");

  await enter(p);
  await expect.poll(() => last(p)?.run?.phase).toBe("playing");
  expect(last(p).run).toMatchObject({ wins: 0, game: 1, you: 0 });
  await pick(p);
  // 名札: 自分はまだ連勝なし、CPU は Lv 1
  await expect(page.locator(".plate-record", { hasText: "Lv 1" })).toBeVisible();
  await expect(page.locator("#rules4-name")).toHaveText("ルール エンドレス");
  await page.screenshot({ path: `${SHOT}/${prefix(info)}-endless-play.png`, animations: "disabled" });

  await move(p);
  await expect(result(p)).toBeVisible({ timeout: 20_000 });
  expect(last(p).run).toMatchObject({ phase: "won", wins: 1 });
  expect(last(p).best).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#result-rematch-note")).toHaveText("1連勝　次は Lv 2");
  await expect(page.locator("#result-online [data-rematch=next]")).toHaveText("次の対局");
  await expect(page.locator("#result-rematch")).toBeHidden();
  await page.screenshot({ path: `${SHOT}/${prefix(info)}-endless-won.png`, animations: "disabled" });

  // 次の対局: Lv 2・後手。CPU が考えてから先に打つ
  await tap(p, "#result-online [data-rematch=next]");
  await expect(result(p)).toBeHidden();
  await expect.poll(() => last(p).run?.game).toBe(2);
  expect(last(p).run).toMatchObject({ phase: "playing", wins: 1, you: 1 });
  await expect(page.locator(".plate-record", { hasText: "Lv 2" })).toBeVisible();
  await expect(page.locator(".plate-record", { hasText: "1連勝" })).toBeVisible();
  await pick(p);
  await expect(page.locator("#status")).toHaveText(/CPU/);
  // CPU の最初の手で体力 1 のプレイヤーが負ける
  await expect(result(p)).toBeVisible({ timeout: 20_000 });
  expect(last(p).run).toMatchObject({ phase: "lost", wins: 1 });
  await expect(page.locator("#result-rematch-note")).toContainText("記録 1連勝");
  await page.screenshot({ path: `${SHOT}/${prefix(info)}-endless-lost.png`, animations: "disabled" });

  // ランキングに名前と連勝数（自分の行）
  await tap(p, "#result-online [data-rematch=ranking]");
  const me = page.locator("#ranking-list .rank-row.me");
  await expect(me).toBeVisible();
  await expect(me.locator(".rank-name")).toHaveText(name);
  await expect(me.locator(".rank-best strong")).toHaveText(/^[1-9]\d*$/);
  await expect(page.locator("#ranking-me .rank-me-no")).toHaveText(/位$/);
  await page.screenshot({ path: `${SHOT}/${prefix(info)}-endless-ranking.png`, animations: "disabled" });
  await tap(p, "#ranking-close");

  // 新しく挑戦: Lv 1・連勝 0 から
  await tap(p, "#result-online [data-rematch=restart]");
  await expect(result(p)).toBeHidden();
  await expect.poll(() => last(p).run?.phase).toBe("playing");
  expect(last(p).run).toMatchObject({ wins: 0, game: 1, you: 0 });
  await expect(page.locator(".plate-record", { hasText: "Lv 1" })).toBeVisible();
});

test("対局の途中でタブを閉じて開き直すと、同じ局面・残りの時計から続く。メニューに連勝中と出る", async ({ page: page1 }, info) => {
  const touch = !!info.project.use.hasTouch;
  const context = page1.context();
  const p = await open(page1, touch, { hp: [100, 1], cpu: "easy" });
  await enter(p);
  await pick(p);
  await move(p);
  await expect(result(p)).toBeVisible({ timeout: 20_000 });
  await tap(p, "#result-online [data-rematch=next]");
  await expect.poll(() => last(p).run?.game).toBe(2);
  await pick(p);
  // CPU の手の後、プレイヤーの手番で閉じる
  await expect.poll(() => (last(p).run!.view.turn === last(p).run!.you && !last(p).run!.thinking ? "me" : "cpu"), { timeout: 15_000 }).toBe("me");
  const seen = last(p).run!;
  await page1.close();

  const page2 = await context.newPage();
  const q = await open(page2, touch);
  await tap(q, "#menu-cpu");
  await expect(page2.locator("#menu-endless")).toBeVisible();
  await tap(q, "#menu-endless");
  await expect.poll(() => last(q)?.run?.game).toBe(2);
  const back = last(q).run!;
  expect(back.wins).toBe(1);
  expect(back.view.history).toEqual(seen.view.history);
  // 閉じていた間は時計が止まっている（残りは閉じる前の残り以下で、ほぼ同じ）
  expect(back.clock!.remainingMs).toBeLessThanOrEqual(seen.clock!.remainingMs);
  expect(back.clock!.remainingMs).toBeGreaterThan(seen.clock!.remainingMs - 5000);
  await expect(page2.locator(".board.acting")).toBeVisible();
  await expect(page2.locator(".plate-record", { hasText: "1連勝" })).toBeVisible();
  await page2.screenshot({ path: `${SHOT}/${prefix(info)}-endless-resume.png`, animations: "disabled" });
  // メニューの入口に連勝中
  await tap(q, "#btn-menu");
  await tap(q, "#menu-cpu");
  await expect(page2.locator("#menu-endless-state")).toHaveText(" 1連勝中");
  await page2.screenshot({ path: `${SHOT}/${prefix(info)}-endless-menu.png`, animations: "disabled" });
});

test("localStorage の端末のトークンを壊すと始め直しの案内。連勝数を書き足してもランキングは変わらない", async ({ page }, info) => {
  const touch = !!info.project.use.hasTouch;
  const p = await open(page, touch, { hp: [100, 100], cpu: "easy" });
  await enter(p);
  await expect.poll(() => last(p)?.run?.phase).toBe("playing");
  const dev = await page.evaluate(() => JSON.parse(localStorage.getItem("kyosho:endless")!));
  expect(Object.keys(dev).sort()).toEqual(["device", "token", "v"]);
  const before = await (await page.request.get(`/api/endless/ranking?device=${dev.device}`)).json() as RankingResponse;
  expect(before.me).toBeNull();

  // 連勝数を書き足しても、サーバーは端末 ID とトークンしか見ない
  await page.evaluate((d) => localStorage.setItem("kyosho:endless", JSON.stringify({ ...d, wins: 99, best: 99 })), dev);
  await page.reload();
  await enter(p);
  await expect.poll(() => last(p)?.run?.wins).toBe(0);
  const after = await (await page.request.get(`/api/endless/ranking?device=${dev.device}`)).json() as RankingResponse;
  expect(after.me).toBeNull();

  // 別の端末のトークンにすると、サーバーの記録と合わない
  await page.evaluate((d) => localStorage.setItem("kyosho:endless", JSON.stringify({ ...d, token: "A".repeat(43) })), dev);
  await page.reload();
  await enter(p);
  await expect(page.locator("#online-title")).toHaveText("この端末の記録が見つかりません");
  // 壊れた保存は捨てたので、新しく始めると別の端末になる
  expect(await page.evaluate(() => localStorage.getItem("kyosho:endless"))).toBeNull();
  const seen = p.states.length;
  await page.locator("#online-actions .btn.primary").click();
  await expect.poll(() => p.states.length > seen && last(p).run?.wins === 0).toBe(true);
  const now = await page.evaluate(() => JSON.parse(localStorage.getItem("kyosho:endless") ?? "null"));
  expect(now?.device).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(now.device).not.toBe(dev.device);
});
