// オンライン対戦の e2e: 2 つのブラウザコンテキストで 招待リンクの作成 → 参加 → 終局、再読み込みからの復帰、
// 隠し王の秘匿、エラー（部屋がない・満員・対局中の切断）、自分の招待リンク・同じ席を 2 つのタブで開いた場合。
// サーバーは playwright.online.config.ts が起こす wrangler dev（本番と同じ 1 Worker・同一オリジン）

import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { cellName, othelloCells } from "../../src/engine/board";
import { defaultRules, presetById } from "../../src/engine/rules";
import { cellAt, noHorizontalScroll } from "../helpers";
import {
  createRoomFromSetup,
  joinFromInvite,
  moverOf,
  newPlayer,
  playTurn,
  prefix,
  SHOT,
  waitPlaying,
  waitResult,
  watch,
  type Player,
} from "./net";

/** 終局まで打つ。each は各手の後に呼ぶ（手数ごとの確認・スクリーンショット） */
async function playToEnd(a: Player, b: Player, opts: { designate?: boolean; each?: (ply: number) => Promise<void> } = {}) {
  for (let i = 0; i < 400; i++) {
    if (a.last!.view.result) return;
    const mover = moverOf(a, b);
    await playTurn(mover, opts.designate);
    // 相手にも同じ局面が届くのを待つ
    const other = mover === a ? b : a;
    await expect.poll(() => other.last!.view.history.length, { timeout: 15_000 }).toBe(mover.last!.view.history.length);
    await opts.each?.(mover.last!.view.ply);
  }
  throw new Error("終局しなかった");
}

const resultText = (p: Page) => p.locator("#result-winner").textContent();

test("作成 → 招待リンクで参加 → 終局。途中の再読み込みで同じ席に戻り、終局後の再読み込みは結果を出す", async ({ browser }, info) => {
  const pre = prefix(info);
  const width = info.project.use.viewport!.width;
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");

  const url = await createRoomFromSetup(host, "v10", "first", `${SHOT}/${pre}-online-setup.png`);
  // 待機中: 招待リンク・自分の席・相手を待つ表示
  await expect(host.page.locator("#invite-waiting")).toBeVisible();
  await expect(host.page.locator(".online-seat")).toContainText("先手（黒）");
  await expect.poll(() => host.last?.phase).toBe("waiting");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-invite.png` });
  await noHorizontalScroll(host.page, width);
  // コピー（クリップボードが使えない環境では選択して案内する）
  await host.page.locator("#invite-copy").click();
  await expect(host.page.locator("#invite-status")).not.toHaveText("");

  await joinFromInvite(guest, url, `${SHOT}/${pre}-online-join.png`);
  await waitPlaying(host, guest);
  expect(host.last!.you).toBe(0);
  expect(guest.last!.you).toBe(1);
  await expect(host.page.locator("#net")).toHaveText("相手: 接続中");
  await expect(guest.page.locator("#player-1 .player-name")).toHaveText("後手（あなた）");
  await expect(guest.page.locator("#player-0 .player-name")).toHaveText("先手（相手）");

  // 先手（作成者）の手番: 先手は盤を操作でき、後手は待つ
  await expect(host.page.locator(".board.acting")).toBeVisible();
  await expect(guest.page.locator(".board.acting")).toHaveCount(0);
  await expect(guest.page.locator("#status")).toContainText("先手（相手）の番です");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-myturn.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-theirturn.png` });
  await noHorizontalScroll(guest.page, width);

  // 手番でない側が盤を押しても何も送らない
  const sentBefore = guest.sent.length;
  await cellAt(guest.page, 2, 3).click({ force: true });
  await guest.page.waitForTimeout(300);
  expect(guest.sent.slice(sentBefore).filter((x) => x.includes('"move"'))).toEqual([]);

  let reloaded = false;
  await playToEnd(host, guest, {
    each: async (ply) => {
      if (reloaded || ply < 6) return;
      reloaded = true;
      // 再読み込み: 同じ部屋・同じ席（後手）に戻り、盤も同じ
      const histBefore = guest.last!.view.history.length;
      const boardBefore = JSON.stringify(guest.last!.view.board);
      guest.last = null;
      await guest.page.reload();
      await expect.poll(() => guest.last?.view.history.length, { timeout: 15_000 }).toBe(histBefore);
      expect(guest.last!.you).toBe(1);
      expect(JSON.stringify(guest.last!.view.board)).toBe(boardBefore);
      await expect(guest.page.locator("#online")).toBeHidden();
      await expect(guest.page).toHaveURL(/\?room=/);
      // 相手には切断 → 復帰が届く
      await expect(host.page.locator("#net")).toHaveText("相手: 接続中");
      await expect(guest.page.locator("#log .log-item")).toHaveCount(histBefore);
    },
  });
  expect(reloaded).toBe(true);

  // 両者に結果
  await waitResult(host);
  await waitResult(guest);
  const r = host.last!.view.result!;
  const [h, g] = [await resultText(host.page), await resultText(guest.page)];
  if (r.winner === null) expect([h, g]).toEqual(["引き分け", "引き分け"]);
  else expect([h, g]).toEqual(r.winner === 0 ? ["あなたの勝ち", "相手の勝ち"] : ["相手の勝ち", "あなたの勝ち"]);
  await expect(host.page.locator("#result-rematch")).toHaveText("新しい部屋で再戦");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-result.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-result-guest.png` });

  // 終局後の再読み込み: 決着の演出なしで結果を出す
  await host.page.reload();
  await waitResult(host);
  expect(await resultText(host.page)).toBe(h);
  await host.page.locator("#result-view").click();
  await expect(host.page.locator("#status")).toContainText("終局");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-result-reload.png` });

  // 新しい部屋で再戦: 同じルールで部屋を作り直し、新しい招待リンクを出す
  await host.page.locator("#btn-rematch").click();
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "invite");
  const url2 = await host.page.locator("#invite-url").inputValue();
  expect(url2).not.toBe(url);
  await expect(host.page.locator(".online-seat")).toContainText("先手（黒）");
});

test("隠し王: 自分の王の指定と相手の王の候補。相手に届くメッセージに王の場所が入らない", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const url = await createRoomFromSetup(host, "king", "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);

  // 先手が最初の手で王を指定する
  await expect(host.page.locator("#king-toggle")).toBeVisible();
  const hostMove = await playTurn(host, true);
  const hostKing = host.last!.view.myKing.cell!;
  expect(hostKing).toEqual([hostMove.r, hostMove.c]);
  await expect(host.page.locator(`.cell[data-r="${hostMove.r}"][data-c="${hostMove.c}"] .king-mark`)).toBeVisible();
  // 後手の画面: 先手の王は分からない（王の印なし）。候補の「?」は出る
  await expect.poll(() => guest.last!.view.history.length).toBe(host.last!.view.history.length);
  await expect(guest.page.locator(".king-mark")).toHaveCount(0);
  await expect(guest.page.locator(`.cell[data-r="${hostMove.r}"][data-c="${hostMove.c}"] .king-cand`)).toBeVisible();
  await expect(guest.page.locator("#king-cands")).toContainText("相手の王の候補 1 個");
  await expect(guest.page.locator("#player-0 .king-tag")).toHaveText("王 ？");

  // 後手も王を指定し、続けて打つ
  await playTurn(guest, true);
  await expect(guest.page.locator(".king-mark")).toHaveCount(1);
  await expect.poll(() => host.last!.view.history.length).toBe(guest.last!.view.history.length);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-king.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-king-guest.png` });

  await playToEnd(host, guest, { designate: true });
  await waitResult(host);
  await waitResult(guest);

  // 秘匿の確認: どちらにも GameState.kings は届かない。相手の王の場所は自分の myKing にしか出ない
  for (const [me, foe] of [
    [host, guest],
    [guest, host],
  ] as const) {
    const foeKing = foe.frames.map((f) => JSON.parse(f)).filter((m) => m.type === "state" && m.view.myKing.cell)[0]?.view.myKing.cell;
    expect(foeKing).toBeTruthy();
    for (const f of me.frames) {
      expect(f).not.toContain('"kings"');
      if (!f.startsWith("{")) continue;
      const m = JSON.parse(f);
      if (m.type !== "state") continue;
      expect(Object.keys(m.view.oppKing).sort()).toEqual(["candidates", "revealed"]);
      expect(m.view.myKing.cell === null || JSON.stringify(m.view.myKing.cell) !== JSON.stringify(foeKing)).toBe(true);
    }
  }
  // 先手の王の場所（ログ用）
  expect(hostKing).toHaveLength(2);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-king-result.png` });
});

test("既定（標準）のまま部屋を作る: 部屋のルールが標準になり、終局まで打てる", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const url = await createRoomFromSetup(host, null, "first", `${SHOT}/${pre}-online-std-setup.png`);
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  // サーバーが持つ部屋のルール（両者に届く view.rules）が既定と同じ
  for (const p of [host, guest]) expect(p.last!.view.rules).toEqual(defaultRules());
  await expect(host.page.locator("#rules4-name")).toHaveText(`ルール — ${presetById("std").name}`);
  await expect(guest.page.locator("#player-1 .hp-max")).toHaveText("/ 130");

  await playToEnd(host, guest);
  await waitResult(host);
  await waitResult(guest);
  expect(host.last!.view.result).toEqual(guest.last!.view.result);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-std-result.png` });
});

test("普通のオセロなら置けるマス: 自分の手番だけ、自分の色で枠を出す。相手の手番では出さない", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const url = await createRoomFromSetup(host, null, "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  const marked = (p: Player) =>
    p.page.locator(".cell.othello").evaluateAll((cs) => cs.map((c) => (c.getAttribute("aria-label") ?? "").split(" ")[0]).sort());
  for (let ply = 0; ply < 4; ply++) {
    const mover = moverOf(host, guest);
    const other = mover === host ? guest : host;
    await expect(mover.page.locator(".board.acting")).toBeVisible();
    const v = mover.last!.view;
    const want = othelloCells(v.board, v.turn).map(([r, c]) => cellName(r, c)).sort();
    expect(want.length).toBeGreaterThan(0);
    expect(await marked(mover)).toEqual(want);
    // 相手の画面は操作できず、枠もない
    await expect(other.page.locator(".board.acting")).toHaveCount(0);
    await expect(other.page.locator(".cell.othello")).toHaveCount(0);
    if (ply === 0) {
      // 初期配置の標準: 歩（縦だけ）の丸は d3・e6、オセロの枠は c4・d3・e6・f5
      expect(want).toEqual(["c4", "d3", "e6", "f5"]);
      await mover.page.screenshot({ path: `${SHOT}/${pre}-online-othello-mine.png` });
      await other.page.screenshot({ path: `${SHOT}/${pre}-online-othello-theirs.png` });
    }
    await playTurn(mover);
    await expect.poll(() => other.last!.view.history.length, { timeout: 15_000 }).toBe(mover.last!.view.history.length);
  }
});

test("エラー: 存在しない部屋・満員の部屋の招待リンク", async ({ browser, request, baseURL }, info) => {
  const pre = prefix(info);
  const p = await newPlayer(browser, info, "p");
  // 存在しない部屋
  await p.page.goto(`/?room=${"Z".repeat(22)}`);
  await expect(p.page.locator("#online")).toHaveAttribute("data-view", "error");
  await expect(p.page.locator("#online-title")).toHaveText("部屋が見つかりません");
  await p.page.screenshot({ path: `${SHOT}/${pre}-online-error-notfound.png` });
  // 形式の違う ID
  await p.page.goto("/?room=abc");
  await expect(p.page.locator("#online-title")).toHaveText("部屋が見つかりません");
  // 設定画面へ戻ると、アドレスから部屋が外れ、ふつうに遊べる
  await p.page.locator("#online-actions .btn.primary").click();
  await expect(p.page.locator("#setup")).toBeVisible();
  expect(new URL(p.page.url()).search).not.toContain("room=");

  // 満員: API で部屋を作り、2 つの WebSocket で両方の席を埋める
  const res = await request.post("/api/rooms", { data: { preset: "v10" } });
  expect(res.status()).toBe(201);
  const { roomId, token } = await res.json();
  const ws = `${baseURL!.replace(/^http/, "ws")}/api/rooms/${roomId}/ws`;
  const sockets = await Promise.all(
    [{ type: "join", token }, { type: "join" }].map(
      (join) =>
        new Promise<WebSocket>((resolve, reject) => {
          const s = new WebSocket(ws);
          s.addEventListener("open", () => s.send(JSON.stringify(join)));
          s.addEventListener("message", (e) => JSON.parse(String(e.data)).type === "joined" && resolve(s));
          s.addEventListener("error", reject);
        }),
    ),
  );
  await p.page.goto(`/?room=${roomId}`);
  await expect(p.page.locator("#online-title")).toHaveText("この部屋は満員です");
  await p.page.screenshot({ path: `${SHOT}/${pre}-online-error-full.png` });
  sockets.forEach((s) => s.close());
});

test("対局中のサーバー切断: 再接続中の表示 → 復帰。相手には切断中を出す", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  // 作成者の WebSocket を Playwright 経由でサーバーにつなぎ、切断を起こせるようにする
  let down = false;
  const live: [WebSocketRoute, WebSocketRoute][] = [];
  await host.page.routeWebSocket(/\/api\/rooms\/.+\/ws$/, (ws) => {
    if (down) {
      ws.close({ code: 1011, reason: "down" });
      return;
    }
    live.push([ws, ws.connectToServer()]);
  });
  const url = await createRoomFromSetup(host, "v10", "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);
  await playTurn(host);
  await playTurn(guest);

  // サーバーが落ちた: 作成者の接続を切り、つなぎ直しも失敗させる
  down = true;
  for (const [page, server] of live.splice(0)) {
    await server.close({ code: 1000, reason: "down" });
    await page.close({ code: 1011, reason: "down" });
  }
  await expect(host.page.locator("#net")).toHaveText("再接続中…");
  await expect(host.page.locator("#status")).toContainText("接続が切れました");
  await expect(host.page.locator(".board.acting")).toHaveCount(0);
  // 直前の手の演出が消えてから撮る
  await host.page.waitForTimeout(1800);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-error-disconnected.png` });
  // 相手の画面: 相手が切断中
  await expect(guest.page.locator("#net")).toHaveText("相手: 切断中");
  await expect(guest.page.locator("#status")).toContainText("相手の接続が切れています");
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-opponent-away.png` });

  // サーバーが戻った: 自動でつなぎ直し、同じ席で続きを打てる
  down = false;
  await expect(host.page.locator("#net")).toHaveText("相手: 接続中", { timeout: 20_000 });
  await expect(guest.page.locator("#net")).toHaveText("相手: 接続中");
  expect(host.last!.you).toBe(0);
  await playTurn(host);
});

test("自分の招待リンクを開いた場合の注意・同じ席を 2 つのタブで開いた場合", async ({ browser }, info) => {
  const pre = prefix(info);
  const host = await newPlayer(browser, info, "host");
  const url = await createRoomFromSetup(host, "v10", "random");
  const path = new URL(url).pathname + new URL(url).search;

  // 作成者が同じブラウザの別タブで自分の招待リンクを開く: トークンは共有しない（別人として参加できる）が、注意を出す
  const own = watch(await host.page.context().newPage(), "own", host.touch);
  await own.page.goto(path);
  await expect(own.page.locator("#online")).toHaveAttribute("data-view", "join");
  await expect(own.page.locator("#join-own")).toBeVisible();
  await own.page.screenshot({ path: `${SHOT}/${pre}-online-join-own.png` });
  await own.page.close();

  // 相手が参加
  const guest = await newPlayer(browser, info, "guest");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);

  // 同じ席（作成者のトークン）を別のタブで開く（タブの複製で sessionStorage が写った場合）
  const token = await host.page.evaluate((id) => sessionStorage.getItem(`kyosho:token:${id}`), url.split("room=")[1]);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const dup = watch(await host.page.context().newPage(), "dup", host.touch);
  await dup.page.addInitScript(([id, t]) => sessionStorage.setItem(`kyosho:token:${id}`, t), [url.split("room=")[1], token!] as const);
  await dup.page.goto(path);
  await expect.poll(() => dup.last?.phase).toBe("playing");
  expect(dup.last!.you).toBe(host.last!.you);
  // 古いタブは閉じられ、つなぎ直さない
  await expect(host.page.locator("#online")).toHaveAttribute("data-view", "error");
  await expect(host.page.locator("#online-title")).toHaveText("別のタブで開かれました");
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-error-replaced.png` });
  // 「このタブで続ける」で取り戻す（今度は複製したタブが閉じられる）
  await host.page.locator("#resume-here").click();
  await expect(host.page.locator("#online")).toBeHidden();
  await expect(dup.page.locator("#online-title")).toHaveText("別のタブで開かれました");
  await expect(host.page.locator("#net")).toHaveText("相手: 接続中");
});
