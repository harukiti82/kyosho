// オンライン対戦の e2e の共通部品: プレイヤー（ブラウザコンテキスト＋届いた WebSocket のメッセージ）・部屋の作成と参加・手の選び方

import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { legalCells, playableKinds, playMove, lastMoveOf, type GameState } from "../../src/engine/game";
import type { PieceKind, PresetId } from "../../src/engine/rules";
import type { StateMessage } from "../../src/net/protocol";
import { play } from "../helpers";

export const SHOT = "screenshots";

export interface Player {
  name: string;
  page: Page;
  touch: boolean;
  /** このページに届いた WebSocket のテキスト（全部） */
  frames: string[];
  /** このページが送った WebSocket のテキスト（全部） */
  sent: string[];
  /** 最後に届いた state */
  last: StateMessage | null;
}

/** プロジェクト（desktop / mobile）と同じ画面の大きさ・タッチでコンテキストを作り、届くメッセージを記録する */
export async function newPlayer(browser: Browser, info: TestInfo, name: string): Promise<Player> {
  const u = info.project.use;
  const context = await browser.newContext({
    baseURL: u.baseURL,
    viewport: u.viewport,
    hasTouch: u.hasTouch,
    isMobile: u.isMobile,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
  });
  const page = await context.newPage();
  return watch(page, name, !!u.hasTouch);
}

/** ページに届く WebSocket のメッセージを記録する（再読み込みしても続けて記録する） */
export function watch(page: Page, name: string, touch: boolean): Player {
  const p: Player = { name, page, touch, frames: [], sent: [], last: null };
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => p.sent.push(typeof f.payload === "string" ? f.payload : f.payload.toString("utf8")));
    ws.on("framereceived", (f) => {
      const text = typeof f.payload === "string" ? f.payload : f.payload.toString("utf8");
      p.frames.push(text);
      try {
        const m = JSON.parse(text);
        if (m.type === "state") p.last = m;
      } catch {
        // pong など
      }
    });
  });
  return p;
}

export const prefix = (info: TestInfo) => (info.project.name === "desktop" ? "pc" : "sp");

/** 設定画面でオンライン対戦を選び、部屋を作って招待リンクを返す */
export async function createRoomFromSetup(host: Player, preset: PresetId, seat: "first" | "second" | "random", shot?: string): Promise<string> {
  const { page } = host;
  await page.goto("/");
  await expect(page.locator("#setup")).toBeVisible();
  // /api/health に届いたら入口が出る
  await expect(page.locator("#mode-online")).toBeVisible();
  await page.locator(`.preset[data-preset=${preset}]`).click();
  await page.locator("#mode-online").click();
  await expect(page.locator("input[name=mode][value=online]")).toBeChecked();
  await expect(page.locator("#side-field")).toBeHidden();
  await page.locator(`label:has(> input[name=host][value=${seat}])`).click();
  await expect(page.locator("#setup-start")).toHaveText("部屋を作る");
  if (shot) await page.screenshot({ path: shot });
  await page.locator("#setup-start").click();
  await expect(page.locator("#online")).toHaveAttribute("data-view", "invite");
  const url = await page.locator("#invite-url").inputValue();
  expect(url).toMatch(/\?room=[A-Za-z0-9_-]{22}$/);
  return url;
}

/** 招待リンクを開いて参加する */
export async function joinFromInvite(guest: Player, url: string, shot?: string) {
  const { page } = guest;
  await page.goto(new URL(url).pathname + new URL(url).search);
  await expect(page.locator("#online")).toHaveAttribute("data-view", "join");
  if (shot) await page.screenshot({ path: shot });
  await page.locator("#join-room").click();
  await expect(page.locator("#online")).toBeHidden();
}

/** 部屋が対局中になった（両者に state playing が届き、案内が閉じた）のを待つ */
export async function waitPlaying(...ps: Player[]) {
  for (const p of ps) {
    await expect.poll(() => p.last?.phase, { timeout: 15_000 }).toBe("playing");
    await expect(p.page.locator("#online")).toBeHidden();
    await expect(p.page.locator("#game")).toBeVisible();
  }
}

/** 返す（取る）駒が最も多い手。view をそのまま engine に渡す（合法手・予測は kings を読まない） */
export function bestMove(m: StateMessage) {
  const s = m.view as unknown as GameState;
  let best: { r: number; c: number; kind: PieceKind; n: number } | null = null;
  for (const kind of playableKinds(s)) {
    for (const [r, c] of legalCells(s, kind)) {
      // kings を持たない view でも playMove を試せるよう、空の王の状態を足す（盤とダメージの計算は同じ）
      const trial = playMove({ ...s, kings: [{ cell: null, auto: false, revealed: false }, { cell: null, auto: false, revealed: false }] }, r, c, kind);
      const n = lastMoveOf(trial)!.targets.length;
      if (!best || n > best.n) best = { r, c, kind, n };
    }
  }
  return best!;
}

/**
 * 手番の人が 1 手打つ（UI を操作）。打った人に新しい state が届くまで待つ。
 * designate: 王を指定できる手番なら「この駒を王にする」を押してから置く
 */
export async function playTurn(mover: Player, designate = false) {
  const { page } = mover;
  await expect(page.locator(".board.acting")).toBeVisible({ timeout: 30_000 });
  const before = mover.last!.view.history.length;
  const mv = bestMove(mover.last!);
  if (designate && mover.last!.view.myKing.canDesignate) {
    const t = page.locator("#king-toggle");
    if ((await t.getAttribute("aria-pressed")) !== "true") {
      if (mover.touch) await t.tap();
      else await t.click();
    }
    await expect(t).toHaveAttribute("aria-pressed", "true");
  }
  await play(page, mv.r, mv.c, mv.kind, mover.touch);
  await expect.poll(() => mover.last!.view.history.length, { timeout: 15_000 }).toBeGreaterThan(before);
  return mv;
}

/** 今の手番の人 */
export function moverOf(a: Player, b: Player): Player {
  const m = a.last!;
  return m.view.turn === m.you ? a : b;
}

/** 終局画面（決着の演出の後）が出るまで待つ */
export async function waitResult(p: Player) {
  await expect(p.page.locator("#result")).toBeVisible({ timeout: 20_000 });
}
