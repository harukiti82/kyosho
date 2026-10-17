// エンドレスマッチ: 端末の発行・参加・挑戦の流れ（勝ち → 次の段階 / 引き分け → 同じ段階 / 負け → 終わり）・CPU の手・
// 制限時間（切断で止める）・ランキング・改ざん（反則手・他人のトークン・終わった挑戦への手・連勝数を送る）・管理用の API

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ENDLESS_HP, stageOf } from "../../web/src/engine/endless";
import type { GameState } from "../../web/src/engine/game";
import { TURN_GRACE_MS, type DeviceResponse, type EndlessStateMessage, type RankingResponse } from "../../web/src/net/protocol";
import worker, { allowDevice } from "../src/index";
import { newRun, settle, type DeviceRecord, type Endless } from "../src/endless";
import type { Ranking } from "../src/ranking";
import { call, Client, firstLegal } from "./helpers";

const devStub = (device: string) => (env.ENDLESS as DurableObjectNamespace<Endless>).get(env.ENDLESS.idFromName(device));
const rankStub = () => (env.RANKING as DurableObjectNamespace<Ranking>).get(env.RANKING.idFromName("global"));
const recordOf = (device: string) => runInDurableObject(devStub(device), async (_i, s) => (await s.storage.get<DeviceRecord>("device"))!);
/** メモリの記録を書き換える（次の操作で保存される） */
const patch = (device: string, f: (d: DeviceRecord) => void) =>
  runInDurableObject(devStub(device), (inst: Endless) => f((inst as unknown as { dev: DeviceRecord }).dev));

async function newDevice(): Promise<DeviceResponse> {
  const res = await call("/endless/devices", { method: "POST" });
  expect(res.status).toBe(201);
  return res.json();
}

async function join(dev: DeviceResponse, name?: unknown): Promise<{ client: Client; state: EndlessStateMessage }> {
  const client = await Client.connectTo(`/endless/devices/${dev.device}/ws`);
  client.send({ type: "join", token: dev.token, ...(name === undefined ? {} : { name }) });
  return { client, state: await client.expect("endless") };
}

/** 挑戦を始めてカードを選び、プレイヤーの手番（1 局目は先手）まで進める。test は体力・CPU の上書き */
async function started(test?: { hp?: [number, number]; cpu?: string; turnSeconds?: number }, name?: string) {
  const dev = await newDevice();
  const { client } = await join(dev, name);
  client.send({ type: "start", ...(test ? { test } : {}) });
  const s0 = await client.expect("endless");
  client.send({ type: "pick", card: s0.run!.view.skills!.sides[s0.run!.you].offer[0] });
  const s1 = await client.expect("endless");
  return { dev, client, s0, s1 };
}

/** 次に届く状態（CPU が考えている状態は飛ばして、CPU の手の後まで） */
async function settled(client: Client): Promise<EndlessStateMessage> {
  for (;;) {
    const s = await client.expect("endless");
    if (!s.run?.thinking) return s;
  }
}

describe("端末", () => {
  it("POST /api/endless/devices で端末 ID とトークンを発行する。ほかのメソッドは 405", async () => {
    const dev = await newDevice();
    expect(dev.device).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(dev.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call("/endless/devices")).status).toBe(405);
    const rec = await recordOf(dev.device);
    expect(rec).toMatchObject({ device: dev.device, token: dev.token, best: 0, run: null, name: null });
  });

  it("join するとまだ挑戦がない状態が届く。名前は検証して、不正なら名前なし", async () => {
    const { state } = await join(await newDevice(), "  るき  はる ");
    expect(state).toEqual({ type: "endless", run: null, best: 0, name: "るき はる" });
    expect((await join(await newDevice(), "x".repeat(11))).state.name).toBeNull();
    expect((await join(await newDevice(), "a​b")).state.name).toBeNull();
  });

  it("他人のトークン・ない端末・形の違う ID・トークンなしは参加できない（同じ答えで閉じる）", async () => {
    const a = await newDevice();
    const b = await newDevice();
    const tryJoin = async (device: string, token?: string) => {
      const c = await Client.connectTo(`/endless/devices/${device}/ws`);
      c.send({ type: "join", ...(token ? { token } : {}) });
      const e = await c.expect("error");
      return { code: e.code, closed: (await c.closedWith()).code };
    };
    expect(await tryJoin(a.device, b.token)).toEqual({ code: "invalid_token", closed: 4003 });
    expect(await tryJoin("A".repeat(22), a.token)).toEqual({ code: "invalid_token", closed: 4003 });
    expect(await tryJoin("short", a.token)).toEqual({ code: "invalid_token", closed: 4003 });
    expect(await tryJoin(a.device)).toEqual({ code: "bad_message", closed: 4003 });
  });

  it("join の前に start は送れない", async () => {
    const dev = await newDevice();
    const c = await Client.connectTo(`/endless/devices/${dev.device}/ws`);
    c.send({ type: "start" });
    await c.expectError("not_joined");
    expect((await c.closedWith()).code).toBe(4003);
  });

  it("同じ端末の 2 つ目の接続が入ると、古い方を 4001 で閉じる", async () => {
    const dev = await newDevice();
    const a = await join(dev);
    await join(dev);
    expect((await a.client.closedWith()).code).toBe(4001);
  });

  it("端末の発行は接続元ごとに 10 分に 10 回まで", () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < 10; i++) expect(allowDevice(ip, 5_000_000)).toBe(true);
    expect(allowDevice(ip, 5_000_001)).toBe(false);
    expect(allowDevice(ip, 5_000_000 + 10 * 60_000)).toBe(true);
    expect(allowDevice(null, 0)).toBe(true);
  });
});

describe("挑戦の流れ", () => {
  it("start で 1 局目（プレイヤーが先手・段階 1）。カードを選ぶまで時計は止まり、選ぶと手番の時計が動く", async () => {
    const { s0, s1 } = await started();
    const run = s0.run!;
    expect(run).toMatchObject({ phase: "playing", wins: 0, game: 1, you: 0, clock: null, thinking: false });
    expect(run.stage).toMatchObject({ no: 1, ...stageOf(0) });
    expect(run.view.rules.hp).toEqual([ENDLESS_HP[0], ENDLESS_HP[1] + stageOf(0).hp]);
    expect(run.view.skills!.ready).toBe(false);
    // CPU は選び終えているが、両者が選ぶまで見せない
    expect(run.view.skills!.sides[1]).toMatchObject({ card: null, offer: [] });
    expect(s1.run!.view.skills!.ready).toBe(true);
    expect(s1.run!.view.turn).toBe(0);
    expect(s1.run!.clock!.limitMs).toBe(45_000);
    expect(s1.run!.clock!.remainingMs).toBeGreaterThan(45_000);
  });

  it("CPU の体力を 1 にして勝つと連勝 1・最高 1 でランキングに載る。次の対局は段階 2 で、先手と後手が入れ替わり CPU が先に打つ", async () => {
    const { dev, client, s1 } = await started({ hp: [100, 1], cpu: "easy" }, "勝つ人");
    client.send({ type: "move", ...firstLegal(s1.run!.view) });
    const won = await client.expect("endless");
    expect(won.run).toMatchObject({ phase: "won", wins: 1, game: 1, clock: null, thinking: false });
    expect(won.run!.stage.no).toBe(1);
    expect(won.best).toBe(1);
    const rank = await (await call(`/endless/ranking?device=${dev.device}`)).json<RankingResponse>();
    expect(rank.me).toMatchObject({ best: 1 });
    expect(rank.top.find((e) => e.me)).toMatchObject({ name: "勝つ人", best: 1 });

    client.send({ type: "next", game: 1 });
    const g2 = await client.expect("endless");
    expect(g2.run).toMatchObject({ phase: "playing", wins: 1, game: 2, you: 1 });
    expect(g2.run!.stage).toMatchObject({ no: 2, ...stageOf(1), base: "easy" });
    // 同じ番号の next の二重押しは通らない
    client.send({ type: "next", game: 1 });
    await client.expectError("stale_next");
    client.send({ type: "pick", card: g2.run!.view.skills!.sides[1].offer[1] });
    const thinking = await client.expect("endless");
    expect(thinking.run).toMatchObject({ thinking: true, clock: null });
    expect(thinking.run!.view.turn).toBe(0);
    // CPU の手番に手を送っても打てない
    client.send({ type: "move", r: 0, c: 0, kind: "fu" });
    await client.expectError("not_your_turn");
    const after = await settled(client);
    expect(after.run!.view.history.length).toBeGreaterThan(0);
    expect(after.run!.view.turn).toBe(1);
    expect(after.run!.clock).not.toBeNull();
  });

  it("体力 1 で CPU に返されて負けると挑戦の終わり。最高は残り、終わった挑戦には手も next も送れず、start で 0 からやり直す", async () => {
    const { dev, client, s1 } = await started({ hp: [1, 100], cpu: "normal" });
    await patch(dev.device, (d) => (d.best = 7));
    client.send({ type: "move", ...firstLegal(s1.run!.view) });
    const lost = await settled(client);
    expect(lost.run).toMatchObject({ phase: "lost", wins: 0, clock: null, thinking: false });
    expect(lost.run!.view.result!.winner).toBe(1);
    expect(lost.best).toBe(7);
    client.send({ type: "move", r: 0, c: 0, kind: "fu" });
    await client.expectError("no_game");
    client.send({ type: "next", game: 1 });
    await client.expectError("stale_next");
    client.send({ type: "start" });
    const again = await client.expect("endless");
    expect(again.run).toMatchObject({ phase: "playing", wins: 0, game: 1 });
    expect(again.best).toBe(7);
  });

  it("挑戦の途中の start は run_active（連勝を捨てて段階を選び直せない）", async () => {
    const { client } = await started();
    client.send({ type: "start" });
    await client.expectError("run_active");
  });

  it("settle / newRun: 勝ちは +1、引き分けはそのまま、負けは終わり。奇数局はプレイヤーが先手", () => {
    const run = newRun(5, 3, undefined, 45_000, () => 0.5);
    expect(run).toMatchObject({ wins: 5, game: 3, cpu: 1, phase: "playing" });
    expect(run.stage).toEqual(stageOf(5));
    expect(newRun(5, 4, undefined, 45_000, () => 0.5).cpu).toBe(0);
    const end = (winner: 0 | 1 | null) => settle({ ...run, state: { ...run.state, result: { winner, reason: "ko", byDiscs: false } } as GameState });
    expect(end(0)).toMatchObject({ phase: "won", wins: 6 });
    expect(end(null)).toMatchObject({ phase: "drawn", wins: 5 });
    expect(end(1)).toMatchObject({ phase: "lost", wins: 5 });
    // 終わっていない・もう決めた挑戦は変えない
    expect(settle(run)).toBe(run);
    const won = end(0);
    expect(settle(won)).toBe(won);
  });
});

describe("引き分けの次の対局", () => {
  it("next で同じ段階の次の局（先手と後手は入れ替わる）", async () => {
    const { dev, client } = await started();
    await patch(dev.device, (d) => {
      const r = d.run!;
      d.run = settle({ ...r, wins: 4, stage: stageOf(4), state: { ...r.state, result: { winner: null, reason: "stalled", byDiscs: false } } as GameState });
    });
    // メモリの記録で next を受ける（保存は next が書く）
    client.send({ type: "next", game: 1 });
    const s = await client.expect("endless");
    expect(s.run).toMatchObject({ phase: "playing", wins: 4, game: 2, you: 1 });
    expect(s.run!.stage).toMatchObject({ no: 5, ...stageOf(4) });
  });
});

describe("制限時間", () => {
  it("締め切りを過ぎると置ける手から自動で打ち、CPU の手番になる", async () => {
    const { dev, client } = await started({ hp: [100, 100] });
    await patch(dev.device, (d) => (d.run!.deadline = Date.now() - 1));
    await runDurableObjectAlarm(devStub(dev.device));
    const s = await client.expect("endless");
    const last = s.run!.view.history.at(-1)!;
    expect(last.type === "move" && last.timeout).toBe(true);
    expect(s.run!.thinking).toBe(true);
  });

  it("切断すると残りを覚えて止め、つなぎ直すと残りから数える（中断の間に時間切れにならず、時間も増えない）", async () => {
    const { dev, client } = await started();
    const before = (await recordOf(dev.device)).run!;
    expect(before.deadline).not.toBeNull();
    client.close();
    await new Promise((r) => setTimeout(r, 300));
    const paused = (await recordOf(dev.device)).run!;
    expect(paused.deadline).toBeNull();
    expect(paused.left).not.toBeNull();
    expect(paused.left!).toBeLessThanOrEqual(45_000 + TURN_GRACE_MS);
    expect(paused.left!).toBeGreaterThan(40_000);
    // 止めている間は alarm を張らない
    expect(await runInDurableObject(devStub(dev.device), (_i, s) => s.storage.getAlarm())).toBeNull();
    const { state } = await join(dev);
    expect(state.run!.clock!.remainingMs).toBeLessThanOrEqual(paused.left!);
    expect(state.run!.clock!.remainingMs).toBeGreaterThan(paused.left! - 1000);
    const resumed = (await recordOf(dev.device)).run!;
    expect(resumed.deadline).not.toBeNull();
    expect(resumed.left).toBeNull();
  });

  it("手番が来たときは制限時間 + 猶予から", async () => {
    const { s1 } = await started();
    expect(s1.run!.clock!.remainingMs).toBeLessThanOrEqual(45_000 + TURN_GRACE_MS);
  });
});

describe("改ざんと不正な入力", () => {
  it("反則手は illegal_move で、局面も連勝数も変わらない", async () => {
    const { dev, client, s1 } = await started();
    const v = s1.run!.view;
    // 盤の中央（埋まっている）に置く
    client.send({ type: "move", r: 3, c: 3, kind: "fu", seq: v.history.length });
    await client.expectError("illegal_move");
    client.send({ type: "move", ...firstLegal(v), seq: 99 });
    await client.expectError("stale_move");
    expect((await recordOf(dev.device)).run!.state.history).toHaveLength(0);
  });

  it("連勝数・最高・段階を送っても受け付けない（ランキングも変わらない）", async () => {
    const { dev, client } = await started();
    client.send({ type: "win" });
    await client.expectError("bad_message");
    client.send({ type: "next", game: 1, wins: 99, best: 99 });
    await client.expectError("stale_next");
    client.send({ type: "join", token: dev.token, best: 99 });
    await client.expectError("already_joined");
    client.send({ type: "rematch", action: "request", gameNo: 1 });
    await client.expectError("bad_message");
    client.send({ type: "leave" });
    await client.expectError("bad_message");
    const rec = await recordOf(dev.device);
    expect(rec.best).toBe(0);
    expect(rec.run!.wins).toBe(0);
    const rank = await (await call(`/endless/ranking?device=${dev.device}`)).json<RankingResponse>();
    expect(rank.me).toBeNull();
  });

  it("test の上書きは形を検証する（範囲の外・知らない CPU は bad_message）", async () => {
    const dev = await newDevice();
    const { client } = await join(dev);
    for (const test of [{ hp: [0, 5] }, { hp: [5] }, { cpu: "god" }, { turnSeconds: 0 }, "x"]) {
      client.send({ type: "start", test });
      await client.expectError("bad_message");
    }
  });

  it("送られる view に CPU の王・巻き戻しの局面（GameState.kings / skills.undo）は入らない", async () => {
    const { client, s1 } = await started({ hp: [100, 100], cpu: "easy" });
    let s = s1;
    for (let i = 0; i < 8 && s.run!.phase === "playing"; i++) {
      client.send({ type: "move", ...firstLegal(s.run!.view) });
      s = await settled(client);
    }
    for (const raw of client.raw) {
      expect(raw).not.toContain('"kings"');
      expect(raw).not.toContain('"undo"');
    }
    // 相手（CPU）の王は公開情報（候補・返されたか・偵察したか）だけで、場所の項目はない（候補の数は CPU の乱数で 0 もありうる）
    expect(Object.keys(s.run!.view.oppKing).sort()).toEqual(["candidates", "revealed", "scouted"]);
  }, 20_000);

  it("カードの選び直し・配られていないカード・2 回目の配り直しは illegal_skill", async () => {
    const dev = await newDevice();
    const { client } = await join(dev);
    client.send({ type: "start" });
    const s0 = await client.expect("endless");
    const offer = s0.run!.view.skills!.sides[0].offer;
    const missing = (["firstaid", "bigheal", "strong", "omni", "refill", "wall", "scout", "kingmove", "fool", "wheel"] as const).find((id) => !offer.includes(id))!;
    client.send({ type: "pick", card: missing });
    await client.expectError("illegal_skill");
    client.send({ type: "pick", card: "judge" });
    await client.expectError("illegal_skill");
    client.send({ type: "reroll" });
    const r1 = await client.expect("endless");
    expect(r1.run!.view.skills!.sides[0].offer).not.toContain("judge");
    client.send({ type: "reroll" });
    await client.expectError("illegal_skill");
    client.send({ type: "pick", card: r1.run!.view.skills!.sides[0].offer[0] });
    await client.expect("endless");
    client.send({ type: "pick", card: r1.run!.view.skills!.sides[0].offer[1] });
    await client.expectError("illegal_skill");
  });
});

describe("ランキング", () => {
  it("上位は連勝数の大きい順（同じなら先に達した順）・同じ連勝数は同じ順位。自分の順位と、載っていない端末は null", async () => {
    const ids = ["rankAaaaaaaaaaaaaaaaaa", "rankBbbbbbbbbbbbbbbbbbb", "rankCccccccccccccccccc", "rankDddddddddddddddddd"];
    const r = rankStub();
    await r.report(ids[0], "a", 900, 10);
    await r.report(ids[1], "b", 950, 20);
    await r.report(ids[2], null, 900, 5);
    // 小さい値では下がらない・名前は最新
    await r.report(ids[1], "b2", 3, 30);
    const res = await (await call(`/endless/ranking?device=${ids[0]}`)).json<RankingResponse>();
    expect(res.top.slice(0, 3)).toEqual([
      { rank: 1, name: "b2", best: 950 },
      { rank: 2, name: null, best: 900 },
      { rank: 2, name: "a", best: 900, me: true },
    ]);
    expect(res.me).toEqual({ rank: 2, best: 900 });
    expect((await (await call(`/endless/ranking?device=${ids[3]}`)).json<RankingResponse>()).me).toBeNull();
    // 形の違う device は無視
    expect((await (await call("/endless/ranking?device=<script>")).json<RankingResponse>()).me).toBeNull();
  });

  it("名前を変えて join すると、載っている行の名前も変わる", async () => {
    const { dev, client, s1 } = await started({ hp: [100, 1] }, "前の名前");
    client.send({ type: "move", ...firstLegal(s1.run!.view) });
    await client.expect("endless");
    await join(dev, "次の名前");
    const res = await (await call(`/endless/ranking?device=${dev.device}`)).json<RankingResponse>();
    expect(res.top.find((e) => e.me)?.name).toBe("次の名前");
  });
});

describe("管理用の API", () => {
  const auth = { Authorization: "Bearer test-admin-token" };

  it("トークンがなければ 401。一覧（名前で検索）・消す・block した端末は以後も載らない", async () => {
    const id = "adminXxxxxxxxxxxxxxxxx";
    await rankStub().report(id, "わるいなまえ", 800, 1);
    expect((await call("/endless/admin/scores")).status).toBe(401);
    expect((await call("/endless/admin/scores", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    const list = await (await call(`/endless/admin/scores?q=${encodeURIComponent("わるい")}`, { headers: auth })).json<{ device: string }[]>();
    expect(list.map((x) => x.device)).toContain(id);
    const del = await call(`/endless/admin/scores/${id}?block=1`, { method: "DELETE", headers: auth });
    expect(await del.json()).toEqual({ removed: true });
    await rankStub().report(id, "わるいなまえ", 801, 2);
    const after = await (await call(`/endless/admin/scores?q=${encodeURIComponent("わるい")}`, { headers: auth })).json<{ device: string }[]>();
    expect(after.map((x) => x.device)).not.toContain(id);
    await call(`/endless/admin/scores/${id}?unblock=1`, { method: "POST", headers: auth });
    await rankStub().report(id, "なおした", 802, 3);
    const back = await (await call(`/endless/admin/scores?q=${encodeURIComponent("なおした")}`, { headers: auth })).json<{ device: string }[]>();
    expect(back.map((x) => x.device)).toContain(id);
  });

  it("検索の % _ は文字のまま", async () => {
    await rankStub().report("adminYyyyyyyyyyyyyyyyy", "100%", 5, 1);
    const list = await (await call(`/endless/admin/scores?q=${encodeURIComponent("%")}`, { headers: auth })).json<{ name: string }[]>();
    expect(list.every((x) => x.name.includes("%"))).toBe(true);
  });
});

describe("機能フラグ", () => {
  /** Worker の fetch を env を差し替えて直接呼ぶ */
  const fetchWith = (e: Env, url: string, init?: RequestInit) => worker.fetch(new Request(url, init) as Parameters<typeof worker.fetch>[0], e);
  const offEnv = () => ({ ...env, ENDLESS_ENABLED: "0" }) as unknown as Env;
  const fetchOff = (path: string, init?: RequestInit) => fetchWith(offEnv(), `https://kyosho.test/api${path}`, init);

  it("off なら /api/endless の下はすべて 404、health に endless が出ない", async () => {
    expect(await (await fetchOff("/health")).json()).toEqual({ ok: true });
    for (const [path, method] of [
      ["/endless/devices", "POST"],
      ["/endless/ranking", "GET"],
      ["/endless/devices/AAAAAAAAAAAAAAAAAAAAAA/ws", "GET"],
      ["/endless/admin/scores", "GET"],
      ["/endless", "GET"],
    ] as const) {
      const res = await fetchOff(path, { method, headers: path.endsWith("/ws") ? { Upgrade: "websocket" } : {} });
      expect(res.status, path).toBe(404);
    }
  });

  it("on なら health に endless: true", async () => {
    expect(await (await call("/health")).json()).toEqual({ ok: true, endless: true });
  });

  it("管理用の Secret がなければ admin は 404", async () => {
    const noAdmin = { ...env, ENDLESS_ADMIN_TOKEN: undefined } as unknown as Env;
    const res = await fetchWith(noAdmin, "https://kyosho.test/api/endless/admin/scores", { headers: { Authorization: "Bearer test-admin-token" } });
    expect(res.status).toBe(404);
  });
});
