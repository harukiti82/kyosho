// オンライン対戦のスキル（プリセット「スキルあり」）: 2 つのブラウザコンテキストで
// 両者がカードを選ぶ（先に選んだ側は「相手が選んでいます」・選ぶ途中の再読み込み）→ 名札のゲージ → 使う → 相手の画面にも演出 →
// ゲージ満タンのまま終局 → 再戦で配り直し、と、偵察・王の移し替えの隠し情報が相手に届かないこと。
// 配るカードはサーバーの crypto で決まるので、1 本目は配られた中から溜まりやすいカードを選び、
// 2 本目は API と WebSocket で部屋を作り直して偵察と王の移し替えが配られた部屋を探し、そのトークンでブラウザを席に入れる

import { expect, test, type APIRequestContext, type Browser, type TestInfo } from "@playwright/test";
import type { Cell } from "../../src/engine/board";
import { legalCells, playableKinds, targetsAt, type GameState } from "../../src/engine/game";
import type { PieceKind, Player as Seat } from "../../src/engine/rules";
import { gaugeMax, SKILLS, type SkillId } from "../../src/engine/skills";
import type { CreateRoomResponse, StateMessage } from "../../src/net/protocol";
import { noHorizontalScroll, play } from "../helpers";
import { createRoomFromSetup, joinFromInvite, moverOf, newPlayer, playToEnd, prefix, SHOT, waitPlaying, waitResult, type Player } from "./net";

/** 溜まりやすく、満タンになればすぐ使えるカードから選ぶ（偵察・王の移し替え・大回復は使える時期が限られる・長い） */
const PREFER: readonly SkillId[] = ["wall", "strong", "omni", "firstaid", "refill", "scout", "kingmove", "bigheal"];

async function tap(p: Player, sel: string) {
  const el = p.page.locator(sel).first();
  if (p.touch) await el.tap();
  else await el.click();
}

/** 届いた state（全部） */
const statesOf = (p: Player): StateMessage[] =>
  p.frames.filter((f) => f.startsWith("{")).map((f) => JSON.parse(f)).filter((m) => m.type === "state");

const offerOf = (p: Player) => p.last!.view.skills!.sides[p.last!.you].offer;
const preferred = (offer: SkillId[]) => PREFER.find((id) => offer.includes(id))!;

/** カードを選ぶダイアログで id を選んで決める */
async function pickCard(p: Player, id: SkillId) {
  const dialog = p.page.locator("#skill-pick");
  await expect(dialog.locator(".tarot")).toHaveCount(3);
  await tap(p, `#skill-pick .tarot[data-skill=${id}]`);
  await expect(dialog.locator(`.tarot[data-skill=${id}]`)).toHaveAttribute("aria-pressed", "true");
  await tap(p, "#skill-pick-ok");
  await expect.poll(() => p.last!.view.skills!.sides[p.last!.you].card).toBe(id);
}

/**
 * 手番の人が 1 手打つ（UI を操作）。返す駒が最も多い手で、avoid（相手の王。テストだけが知っている）は返さない。
 * designate なら王を指定できる手番で「この駒を王にする」を押してから置く
 */
async function move(mover: Player, avoid: Cell | null = null, designate = false) {
  const { page } = mover;
  await expect(page.locator(".board.acting")).toBeVisible({ timeout: 30_000 });
  const s = mover.last!.view as unknown as GameState;
  const before = s.history.length;
  type Pick = { r: number; c: number; kind: PieceKind; n: number };
  let best: Pick | null = null;
  let fallback: Pick | null = null;
  for (const kind of playableKinds(s)) {
    for (const [r, c] of legalCells(s, kind)) {
      const ts = targetsAt(s, r, c, kind);
      const n = ts.length;
      if (!fallback || n > fallback.n) fallback = { r, c, kind, n };
      if (avoid && ts.some(([y, x]) => y === avoid[0] && x === avoid[1])) continue;
      if (!best || n > best.n) best = { r, c, kind, n };
    }
  }
  const mv = best ?? fallback!;
  if (designate && mover.last!.view.myKing.canDesignate) {
    const t = page.locator("#king-toggle");
    if ((await t.getAttribute("aria-pressed")) !== "true") await tap(mover, "#king-toggle");
    await expect(t).toHaveAttribute("aria-pressed", "true");
  }
  await play(page, mv.r, mv.c, mv.kind, mover.touch);
  await expect.poll(() => mover.last!.view.history.length, { timeout: 15_000 }).toBeGreaterThan(before);
}

/** 相手にも同じ局面が届くのを待つ */
async function synced(a: Player, b: Player) {
  await expect.poll(() => b.last!.view.history.length, { timeout: 15_000 }).toBe(a.last!.view.history.length);
}

/** 名札のカードを押して使う（補充は戻す駒、王の移し替えは移す先を選ぶ）。使った人に armed が届くまで待つ */
async function cast(p: Player, id: SkillId) {
  await tap(p, "#skill-use");
  if (id === "refill" && (await p.page.locator(".skill-aim [data-refill]").count()) > 0) await tap(p, ".skill-aim [data-refill]");
  if (id === "kingmove") {
    await expect(p.page.locator(".cell.skill-target").first()).toBeVisible();
    await tap(p, ".cell.skill-target");
  }
  await expect.poll(() => p.last!.view.skills!.armed?.id).toBe(id);
}

/** 使った演出（.fx-skill）が出て、消えるのを待つ */
async function seeCast(p: Player, id: SkillId, shot?: string) {
  const fx = p.page.locator(".fx-skill");
  await expect(fx).toBeVisible();
  await expect(fx).toHaveAttribute("data-skill", id);
  if (shot) await p.page.screenshot({ path: shot });
  await expect(fx).toHaveCount(0, { timeout: 5_000 });
}

test("スキルありの部屋: 両者が選ぶ（先に選んだ側は相手待ち・途中の再読み込み）→ 名札のゲージ → 使う → 相手にも演出 → 終局 → 再戦で配り直し", async ({ browser }, info) => {
  const pre = prefix(info);
  const width = info.project.use.viewport!.width;
  const host = await newPlayer(browser, info, "host");
  const guest = await newPlayer(browser, info, "guest");
  const url = await createRoomFromSetup(host, "skill", "first");
  await joinFromInvite(guest, url);
  await waitPlaying(host, guest);

  // 両者にカードを選ぶ画面。選ぶ間は盤を操作できず、時計も止まる
  for (const p of [host, guest]) {
    await expect(p.page.locator("#skill-pick")).toBeVisible();
    await expect(p.page.locator("#skill-pick .tarot")).toHaveCount(3);
    await expect(p.page.locator("#status")).toHaveText("カードを選んでいます");
    await expect(p.page.locator(".board.acting")).toHaveCount(0);
    expect(p.last!.view.skills!.ready).toBe(false);
    expect(p.last!.clock).toBeNull();
    expect(offerOf(p)).toHaveLength(3);
    // 相手の配られたカードは届かない
    expect(p.last!.view.skills!.sides[1 - p.last!.you].offer).toEqual([]);
  }
  const offered = offerOf(guest);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-skill-pick.png` });
  if (host.touch) await noHorizontalScroll(host.page, width);

  // 作成者が先に選ぶ: 作成者は「相手が選んでいます」、参加者には作成者のカードが届かない
  const hostCard = preferred(offerOf(host));
  await pickCard(host, hostCard);
  await expect(host.page.locator("#skill-pick .pick-who")).toHaveText("相手が選んでいます");
  await expect(host.page.locator("#skill-pick .tarot")).toHaveCount(1);
  await expect(host.page.locator("#skill-pick-ok")).toHaveCount(0);
  await expect(guest.page.locator("#skill-pick .tarot")).toHaveCount(3);
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-skill-wait.png` });

  // 選ぶ途中の再読み込み: 参加者は同じ 3 枚、作成者は選んだカードのまま相手を待つ
  guest.last = null;
  await guest.page.reload();
  await expect.poll(() => guest.last?.phase, { timeout: 15_000 }).toBe("playing");
  await expect(guest.page.locator("#skill-pick .tarot")).toHaveCount(3);
  expect(offerOf(guest)).toEqual(offered);
  host.last = null;
  await host.page.reload();
  await expect.poll(() => host.last?.phase, { timeout: 15_000 }).toBe("playing");
  await expect(host.page.locator("#skill-pick .pick-who")).toHaveText("相手が選んでいます");
  await expect(host.page.locator(`#skill-pick .tarot[data-skill=${hostCard}]`)).toBeVisible();

  // 参加者が選ぶ: 両者の画面が閉じ、両者の名札にカードとゲージ。作成者のカードはここで初めて参加者に届く
  const guestCard = preferred(offerOf(guest));
  await pickCard(guest, guestCard);
  for (const p of [host, guest]) {
    await expect(p.page.locator("#skill-pick")).toBeHidden();
    await expect.poll(() => p.last!.view.skills!.ready).toBe(true);
    await expect(p.page.locator(`#player-0 .plate-skill .ps-name`)).toHaveText(SKILLS[hostCard].name);
    await expect(p.page.locator(`#player-1 .plate-skill .ps-name`)).toHaveText(SKILLS[guestCard].name);
    await expect(p.page.locator(`#player-0 .plate-skill .ps-state`)).toHaveText(`あと${SKILLS[hostCard].length}`);
  }
  await expect(host.page.locator("#toast")).toContainText(`あなたは${SKILLS[hostCard].name}`);
  await expect(guest.page.locator("#toast")).toContainText(`あなたは${SKILLS[guestCard].name}`);
  // 参加者に届いた state のうち、両者が選び終える前のものには作成者のカードが入らない
  for (const m of statesOf(guest)) if (!m.view.skills!.ready) expect(m.view.skills!.sides[0].card).toBeNull();
  await expect(host.page.locator(".board.acting")).toBeVisible();
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-skill-ready.png` });
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-skill-ready-guest.png` });
  if (guest.touch) await noHorizontalScroll(guest.page, width);

  // 打ってゲージを溜め、先に使えるようになった人が使う。相手の画面にも同じカードの演出が出る
  let used = false;
  for (let i = 0; i < 120 && !used; i++) {
    if (host.last!.view.result) break;
    const mover = moverOf(host, guest);
    const other = mover === host ? guest : host;
    await expect(mover.page.locator(".board.acting")).toBeVisible({ timeout: 30_000 });
    if ((await mover.page.locator("#skill-use").count()) > 0) {
      const id = mover.last!.view.skills!.sides[mover.last!.you].card!;
      await expect(mover.page.locator("#skill-use")).toHaveClass(/\bready\b/);
      await mover.page.screenshot({ path: `${SHOT}/${pre}-online-skill-full.png` });
      // 相手の画面では満タンでも押せない
      await expect(other.page.locator("#skill-use")).toHaveCount(0);
      await cast(mover, id);
      await Promise.all([seeCast(mover, id), seeCast(other, id, `${SHOT}/${pre}-online-skill-cast-other.png`)]);
      await expect.poll(() => other.last!.view.skills!.armed?.id).toBe(id);
      await expect(other.page.locator(`#player-${mover.last!.you} .plate-skill`)).toHaveClass(/\barmed\b/);
      // 使ったら手番の頭のまま置ける。置いた手の棋譜にスキルが残る
      await move(mover);
      await synced(mover, other);
      const last = other.last!.view.history.at(-1)!;
      expect(last.type === "move" && last.skill?.id).toBe(id);
      expect(mover.last!.view.skills!.armed).toBeNull();
      used = true;
      break;
    }
    await move(mover);
    await synced(mover, other);
  }
  expect(used).toBe(true);

  // 使わずに終局まで打つ（満タンのままでも終局画面が出て、名札のカードは押せない）
  await playToEnd(host, guest);
  await waitResult(host);
  await waitResult(guest);
  for (const p of [host, guest]) await expect(p.page.locator("#skill-use")).toHaveCount(0);
  const full = [host, guest].filter((p) => {
    const side = p.last!.view.skills!.sides[p.last!.you];
    return side.gauge >= gaugeMax(side.card!);
  });
  info.annotations.push({ type: "満タンのまま終局", description: full.map((p) => p.name).join(",") || "なし" });
  await host.page.screenshot({ path: `${SHOT}/${pre}-online-skill-result.png` });

  // 再戦: 配り直し（カード・ゲージは持ち越さない）。もう一度選ぶ画面が出る
  await host.page.locator("#result [data-rematch=request]").click();
  await expect(guest.page.locator("#result [data-rematch=request]")).toHaveText("受ける");
  await guest.page.locator("#result [data-rematch=request]").click();
  for (const p of [host, guest]) {
    await expect.poll(() => p.last!.gameNo, { timeout: 15_000 }).toBe(2);
    await expect(p.page.locator("#skill-pick")).toBeVisible();
    await expect(p.page.locator("#skill-pick .tarot")).toHaveCount(3);
    const sk = p.last!.view.skills!;
    expect(sk.ready).toBe(false);
    expect(sk.sides.map((s) => [s.card, s.gauge])).toEqual([
      [null, 0],
      [null, 0],
    ]);
    expect(sk.sides[p.last!.you].offer).toHaveLength(3);
  }
  await guest.page.screenshot({ path: `${SHOT}/${pre}-online-skill-rematch.png` });
  // 2 局目も選べば始まる
  await pickCard(guest, preferred(offerOf(guest)));
  await pickCard(host, preferred(offerOf(host)));
  for (const p of [host, guest]) await expect(p.page.locator("#skill-pick")).toBeHidden();
  await expect(moverOf(host, guest).page.locator(".board.acting")).toBeVisible();
});

/** 部屋を API で作り、2 つの WebSocket で両方の席に入って配られたカードを見る。合わなければ閉じる */
async function dealt(request: APIRequestContext, baseURL: string) {
  const res = await request.post("/api/rooms", { data: { preset: "skill", hostSeat: "first", turnSeconds: 0 } });
  expect(res.status()).toBe(201);
  const created = (await res.json()) as CreateRoomResponse;
  const ws = `${baseURL.replace(/^http/, "ws")}/api/rooms/${created.roomId}/ws`;
  const seats = await Promise.all(
    [{ type: "join", token: created.token }, { type: "join" }].map(
      (join) =>
        new Promise<{ token: string; offer: SkillId[]; socket: WebSocket }>((resolve, reject) => {
          const s = new WebSocket(ws);
          let token = "";
          s.addEventListener("open", () => s.send(JSON.stringify(join)));
          s.addEventListener("message", (e) => {
            const m = JSON.parse(String(e.data));
            if (m.type === "joined") token = m.token;
            if (m.type === "state" && token) resolve({ token, offer: m.view.skills.sides[m.you].offer, socket: s });
          });
          s.addEventListener("error", reject);
        }),
    ),
  );
  for (const s of seats) s.socket.close();
  return { roomId: created.roomId, tokens: seats.map((s) => s.token), offers: seats.map((s) => s.offer) };
}

/** 保存したトークンで部屋の席に入る（作成者・参加者のタブを開き直したのと同じ） */
async function enter(browser: Browser, info: TestInfo, name: string, roomId: string, token: string) {
  const p = await newPlayer(browser, info, name);
  await p.page.addInitScript(([id, t]) => sessionStorage.setItem(`kyosho:token:${id}`, t), [roomId, token] as const);
  await p.page.goto(`/?room=${roomId}`);
  return p;
}

test("偵察と王の移し替え: 偵察で分かった王は使った人だけ、移した先は相手に届かない", async ({ browser, request, baseURL }, info) => {
  const pre = prefix(info);
  // 偵察と王の移し替えが両者に分かれて配られた部屋を探す（1 部屋あたり約 25%）
  let room: Awaited<ReturnType<typeof dealt>> | null = null;
  let scoutSeat: Seat = 0;
  for (let i = 0; i < 60 && !room; i++) {
    const r = await dealt(request, baseURL!);
    for (const s of [0, 1] as const) {
      if (r.offers[s].includes("scout") && r.offers[1 - s].includes("kingmove")) {
        room = r;
        scoutSeat = s;
        break;
      }
    }
  }
  expect(room).not.toBeNull();
  const host = await enter(browser, info, "host", room!.roomId, room!.tokens[0]);
  const guest = await enter(browser, info, "guest", room!.roomId, room!.tokens[1]);
  await waitPlaying(host, guest);
  const scouter = scoutSeat === 0 ? host : guest;
  const mover2 = scoutSeat === 0 ? guest : host;
  await expect(scouter.page.locator("#skill-pick")).toBeVisible();
  await pickCard(scouter, "scout");
  await pickCard(mover2, "kingmove");
  for (const p of [host, guest]) await expect(p.page.locator("#skill-pick")).toBeHidden();

  /** p の王の本当の場所（p の画面にだけ届く） */
  const kingOf = (p: Player) => p.last!.view.myKing.cell;
  let scouted = false;
  let moved: Cell | null = null;
  // 王を移した直後・偵察した直後に、偵察した人が受け取っていた frames の数
  let movedAt = -1;
  let scoutedAt = -1;
  for (let i = 0; i < 160 && !(scouted && moved); i++) {
    if (host.last!.view.result) break;
    const mover = moverOf(host, guest);
    const other = mover === host ? guest : host;
    await expect(mover.page.locator(".board.acting")).toBeVisible({ timeout: 30_000 });
    if ((await mover.page.locator("#skill-use").count()) > 0) {
      if (mover === scouter && !scouted) {
        await cast(scouter, "scout");
        await Promise.all([seeCast(scouter, "scout"), seeCast(mover2, "scout")]);
        // 偵察した人: 相手の王が 1 マスに分かり、盤に金の「王」の印
        const real = kingOf(mover2)!;
        expect(scouter.last!.view.oppKing).toEqual({ revealed: false, candidates: [real], scouted: true });
        await expect(scouter.page.locator(`.cell[data-r="${real[0]}"][data-c="${real[1]}"] .king-cand.scouted`)).toBeVisible();
        await scouter.page.screenshot({ path: `${SHOT}/${pre}-online-skill-scout.png` });
        // 偵察された人には、使われたことだけが届く
        expect(mover2.last!.view.skills!.armed?.id).toBe("scout");
        expect(mover2.last!.view.oppKing.scouted).toBe(false);
        scouted = true;
        scoutedAt = scouter.frames.length;
      } else if (mover === mover2 && !moved) {
        const from = kingOf(mover2)!;
        const before = scouter.last!.view.oppKing;
        await cast(mover2, "kingmove");
        moved = kingOf(mover2)!;
        movedAt = scouter.frames.length;
        expect(moved).not.toEqual(from);
        await Promise.all([seeCast(mover2, "kingmove"), seeCast(scouter, "kingmove")]);
        // 相手から見た候補は使った時点の自分の駒すべて（移した先を絞れない）。偵察で知られていても知られていない状態に戻る
        const opp = scouter.last!.view.oppKing;
        expect(opp.scouted).toBe(false);
        expect(opp.candidates.length).toBeGreaterThan(1);
        expect(opp.candidates).toContainEqual(moved);
        if (before.scouted) await expect(scouter.page.locator(".king-cand.scouted")).toHaveCount(0);
        await mover2.page.screenshot({ path: `${SHOT}/${pre}-online-skill-kingmove.png` });
        await scouter.page.screenshot({ path: `${SHOT}/${pre}-online-skill-kingmove-other.png` });
      }
      await move(mover, kingOf(other));
      await synced(mover, other);
      continue;
    }
    // 王は最初の手で決め、相手の王は返さない（偵察・王の移し替えが使えるうちに満タンにする）
    await move(mover, kingOf(other), true);
    await synced(mover, other);
  }
  expect([scouted, !!moved]).toEqual([true, true]);

  // 王の移し替えの先は、相手に届いたどのメッセージにも王の場所として入らない（偵察し直すまで）。GameState.kings も届かない
  const hidden = scouter.frames.slice(movedAt, scoutedAt > movedAt ? scoutedAt - 1 : undefined);
  expect(hidden.length).toBeGreaterThan(0);
  for (const f of scouter.frames) expect(f).not.toContain('"kings"');
  for (const f of hidden) {
    if (!f.startsWith("{")) continue;
    const m = JSON.parse(f);
    if (m.type !== "state") continue;
    // 候補の数は移した直後に確かめた（その後は相手の駒が返されて、公開情報だけで絞れることがある）
    expect(m.view.oppKing.scouted).toBe(false);
    const armed = m.view.skills?.armed;
    if (armed) expect(Object.keys(armed)).not.toContain("to");
    for (const e of m.view.history) if (e.type === "move" && e.skill) expect(Object.keys(e.skill)).not.toContain("to");
  }
  // 偵察で分かった王の場所は、偵察された人に scouted として届かない
  for (const m of statesOf(mover2)) expect(m.view.oppKing.scouted).toBe(false);
});
