// 終局後の同じ部屋での再戦: 申し込み・受ける・断る・取り消し・同時の申し込み・二重押し・切断と再接続・退室・制限時間

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FINISHED_TTL_MS, TURN_GRACE_MS, type RematchAction, type StateMessage } from "../../web/src/net/protocol";
import type { RoomRecord } from "../src/room";
import { call, Client, finishedRoom, firstLegal, playOut, quickRules, startedRoom, stubOf } from "./helpers";

const recordOf = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);
const alarmIn = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => ((await s.storage.getAlarm()) ?? 0) - Date.now());

const ask = (c: Client, action: RematchAction, gameNo = 1) => c.send({ type: "rematch", action, gameNo });

/** 両者に state が届くのを待つ（[先手の人, 後手の人] ではなく [host, guest] の順） */
const both = (host: Client, guest: Client) => Promise.all([host.expect("state"), guest.expect("state")]);

describe("再戦の申し込みと成立", () => {
  it("終局すると再戦の状態が届く。申し込むと相手に届き、受けると先手と後手を入れ替えた次の対局が両者に始まる", async () => {
    const room = await finishedRoom();
    const { host, guest, roomId } = room;
    expect(room.hostEnd).toMatchObject({ phase: "finished", gameNo: 1, you: 0, rematch: { you: "none", opponent: "none" } });
    expect(room.guestEnd).toMatchObject({ phase: "finished", gameNo: 1, you: 1, rematch: { you: "none", opponent: "none" } });

    ask(host, "request");
    const [h1, g1] = await both(host, guest);
    expect(h1.rematch).toEqual({ you: "requested", opponent: "none" });
    expect(g1.rematch).toEqual({ you: "none", opponent: "requested" });
    expect(g1.phase).toBe("finished");

    ask(guest, "request");
    const [h2, g2] = await both(host, guest);
    for (const s of [h2, g2]) {
      expect(s).toMatchObject({ phase: "playing", gameNo: 2, rematch: null, clock: null, opponent: { joined: true, online: true, left: false } });
      expect(s.view.history).toEqual([]);
      expect(s.view.result).toBeNull();
      expect(s.view.rules).toEqual(room.hostEnd.view.rules);
      expect(s.view.hp).toEqual(quickRules().hp);
      expect(s.view.turn).toBe(0);
    }
    // 先手と後手が入れ替わる: 作成者は後手、参加者は先手
    expect(h2.you).toBe(1);
    expect(g2.you).toBe(0);
    const rec = await recordOf(roomId);
    expect(rec.tokens).toEqual([room.guestToken, room.hostToken]);
    expect(rec.host).toBe(1);
    expect(rec.gameNo).toBe(2);

    // 新しい先手（参加者）が打てて、後手（作成者）は打てない
    host.send({ type: "move", ...firstLegal(h2.view) });
    await host.expectError("not_your_turn");
    guest.send({ type: "move", ...firstLegal(g2.view) });
    const [h3, g3] = await both(host, guest);
    expect(h3.view.history).toHaveLength(1);
    expect(g3.view.turn).toBe(1);

    // 2 局目を終えてもう一度再戦すると、元の席に戻る（交互）
    const [hEnd, gEnd] = await playOut([guest, host], [g3, h3]).then(([a, b]) => [b, a] as const);
    expect(hEnd).toMatchObject({ phase: "finished", gameNo: 2 });
    ask(guest, "request", 2);
    await both(host, guest);
    ask(host, "request", 2);
    const [h4, g4] = await both(host, guest);
    expect([h4.you, g4.you, h4.gameNo, gEnd.gameNo]).toEqual([0, 1, 3, 2]);
    host.close();
    guest.close();
  });

  it("両者が同時に申し込んでもそのまま成立し、対局は 1 つだけ始まる", async () => {
    const { host, guest, roomId } = await finishedRoom();
    ask(host, "request");
    ask(guest, "request");
    // 先に届いた方の「申し込み中」と、成立の state
    let h: StateMessage = await host.expect("state");
    let g: StateMessage = await guest.expect("state");
    if (h.phase === "finished") [h, g] = await both(host, guest);
    expect([h.phase, g.phase, h.gameNo, g.gameNo]).toEqual(["playing", "playing", 2, 2]);
    expect(await host.quiet()).toBe(true);
    expect(await guest.quiet()).toBe(true);
    expect((await recordOf(roomId)).gameNo).toBe(2);
    host.close();
    guest.close();
  });

  it("二重押し: 申し込みの 2 回目は何もしない。受けた後に届いた古い申し込み（gameNo が前の対局）は stale_rematch で、次の対局は変わらない", async () => {
    const { host, guest, roomId } = await finishedRoom();
    ask(host, "request");
    ask(host, "request");
    await both(host, guest);
    expect(await host.quiet()).toBe(true);
    expect(await guest.quiet()).toBe(true);
    ask(guest, "request");
    ask(guest, "request");
    const [h, g] = await both(host, guest);
    expect([h.gameNo, g.gameNo, h.phase]).toEqual([2, 2, "playing"]);
    await guest.expectError("stale_rematch");
    expect(await host.quiet()).toBe(true);
    const rec = await recordOf(roomId);
    expect([rec.gameNo, rec.game.history.length]).toEqual([2, 0]);
    host.close();
    guest.close();
  });

  it("対局中・待機中の申し込みは stale_rematch。形の違う申し込みは bad_message", async () => {
    const { host, guest } = await startedRoom(quickRules());
    ask(host, "request");
    await host.expectError("stale_rematch");
    for (const bad of [
      { type: "rematch", action: "accept", gameNo: 1 },
      { type: "rematch", action: "request" },
      { type: "rematch", action: "request", gameNo: 0 },
      { type: "rematch", action: "request", gameNo: 1.5 },
      { type: "rematch", action: "request", gameNo: "1" },
    ]) {
      host.send(bad);
      await host.expectError("bad_message");
    }
    expect(await guest.quiet()).toBe(true);
    host.close();
    guest.close();
  });
});

describe("断る・取り消す", () => {
  it("断ると申し込んだ側に declined が届き、もう一度申し込める（断った印は消える）", async () => {
    const { host, guest } = await finishedRoom();
    ask(host, "request");
    await both(host, guest);
    ask(guest, "decline");
    const [h1, g1] = await both(host, guest);
    expect(h1.rematch).toEqual({ you: "none", opponent: "declined" });
    expect(g1.rematch).toEqual({ you: "declined", opponent: "none" });
    expect(h1.phase).toBe("finished");
    // 申し込みがないときの断る・取り消すは何もしない
    ask(guest, "decline");
    ask(host, "cancel");
    expect(await host.quiet()).toBe(true);
    expect(await guest.quiet()).toBe(true);
    // もう一度申し込む
    ask(host, "request");
    const [h2, g2] = await both(host, guest);
    expect(h2.rematch).toEqual({ you: "requested", opponent: "none" });
    expect(g2.rematch).toEqual({ you: "none", opponent: "requested" });
    // 断った側からも申し込める（相手が申し込み済みなので成立）
    ask(guest, "request");
    const [h3] = await both(host, guest);
    expect(h3.gameNo).toBe(2);
    host.close();
    guest.close();
  });

  it("取り消すと両者の申し込みが消え、相手は受けられなくなる（受けると新しい申し込みになる）", async () => {
    const { host, guest } = await finishedRoom();
    ask(host, "request");
    await both(host, guest);
    ask(host, "cancel");
    const [h1, g1] = await both(host, guest);
    expect(h1.rematch).toEqual({ you: "none", opponent: "none" });
    expect(g1.rematch).toEqual({ you: "none", opponent: "none" });
    // 取り消しと入れ違いで受けた: 成立せず、受けた側の申し込みになる
    ask(guest, "request");
    const [h2, g2] = await both(host, guest);
    expect(h2).toMatchObject({ phase: "finished", rematch: { you: "none", opponent: "requested" } });
    expect(g2.rematch).toEqual({ you: "requested", opponent: "none" });
    host.close();
    guest.close();
  });
});

describe("切断・退室", () => {
  it("申し込み中に切断してトークンで戻っても申し込みは残り、戻った後に受けられる", async () => {
    const { host, guest, hostToken, roomId } = await finishedRoom();
    ask(host, "request");
    await both(host, guest);
    host.close();
    const away = await guest.expect("state");
    expect(away).toMatchObject({ opponent: { online: false, left: false }, rematch: { you: "none", opponent: "requested" } });

    // オブジェクトが退避されても（記録から読み直す）残る
    expect((await recordOf(roomId)).rematch).toEqual(["requested", "none"]);
    const back = await Client.join(roomId, hostToken);
    expect(back.state).toMatchObject({ phase: "finished", you: 0, rematch: { you: "requested", opponent: "none" } });
    expect(await guest.expect("state")).toMatchObject({ opponent: { online: true } });

    ask(guest, "request");
    const [h, g] = await both(back.client, guest);
    expect([h.you, g.you, h.gameNo]).toEqual([1, 0, 2]);
    // 次の対局でも同じトークンで戻れる（席は入れ替わった後の席）
    back.client.close();
    await guest.expect("state");
    const again = await Client.join(roomId, hostToken);
    expect(again.joined.you).toBe(1);
    expect(again.state).toMatchObject({ phase: "playing", gameNo: 2, you: 1 });
    again.client.close();
    guest.close();
  });

  it("申し込まれた側が切断中でも申し込める。戻ると申し込みが見える", async () => {
    const { host, guest, guestToken, roomId } = await finishedRoom();
    guest.close();
    await host.expect("state");
    ask(host, "request");
    expect((await host.expect("state")).rematch).toEqual({ you: "requested", opponent: "none" });
    const back = await Client.join(roomId, guestToken);
    expect(back.state.rematch).toEqual({ you: "none", opponent: "requested" });
    host.close();
    back.client.close();
  });

  it("退室（leave）すると相手に left が届き、申し込みは取り下げ、退室した相手には申し込めない。同じトークンで戻ると消える", async () => {
    const { host, guest, guestToken, roomId } = await finishedRoom();
    ask(host, "request");
    await both(host, guest);
    guest.send({ type: "leave" });
    const h1 = await host.expect("state");
    expect(h1).toMatchObject({ opponent: { left: true }, rematch: { you: "none", opponent: "none" } });
    // 2 回目の leave は何もしない
    guest.send({ type: "leave" });
    expect(await host.quiet()).toBe(true);
    guest.close();
    expect(await host.expect("state")).toMatchObject({ opponent: { online: false, left: true } });
    ask(host, "request");
    await host.expectError("opponent_left");
    expect((await recordOf(roomId)).rematch).toEqual(["none", "none"]);

    const back = await Client.join(roomId, guestToken);
    expect(back.state.opponent.left).toBe(false);
    expect(await host.expect("state")).toMatchObject({ opponent: { online: true, left: false } });
    ask(host, "request");
    expect((await back.client.expect("state")).rematch).toEqual({ you: "none", opponent: "requested" });
    host.close();
    back.client.close();
  });
});

describe("制限時間・後片付け", () => {
  it("制限時間のある部屋の再戦は同じ制限時間で、新しい先手の時計が始まり、締め切りの alarm で自動の手を打つ", async () => {
    const { host, guest, roomId } = await finishedRoom(quickRules(), 20);
    expect((await recordOf(roomId)).deadline).toBeNull();
    // 終局後の申し込みは放置の 1 時間で張り直す
    ask(host, "request");
    await both(host, guest);
    const left = await alarmIn(roomId);
    expect(left).toBeGreaterThan(FINISHED_TTL_MS - 60_000);
    expect(left).toBeLessThanOrEqual(FINISHED_TTL_MS);

    ask(guest, "request");
    const [h, g] = await both(host, guest);
    for (const s of [h, g]) {
      expect(s.clock!.limitMs).toBe(20_000);
      expect(s.clock!.remainingMs).toBeGreaterThan(20_000 + TURN_GRACE_MS - 2000);
    }
    const rec = await recordOf(roomId);
    expect(rec.turnMs).toBe(20_000);
    expect(await alarmIn(roomId)).toBeLessThanOrEqual(20_000 + TURN_GRACE_MS);

    // 締め切りを過ぎたら、新しい先手（参加者）の手を自動で打つ
    await runInDurableObject(stubOf(roomId), (instance) => {
      (instance as unknown as { room: RoomRecord }).room.deadline = Date.now() - 1;
    });
    expect(await runDurableObjectAlarm(stubOf(roomId))).toBe(true);
    const [h2, g2] = await both(host, guest);
    const m = h2.view.history[0];
    expect(m).toMatchObject({ type: "move", player: 0, timeout: true });
    expect(g2.view.history).toHaveLength(1);
    host.close();
    guest.close();
  });

  it("部屋の情報は次の対局が始まると playing になる（満員のまま）", async () => {
    const { host, guest, roomId } = await finishedRoom();
    const info = async () => (await call(`/rooms/${roomId}`)).json<{ phase: string; open: boolean }>();
    expect(await info()).toMatchObject({ phase: "finished", open: false });
    ask(host, "request");
    await both(host, guest);
    ask(guest, "request");
    await both(host, guest);
    expect(await info()).toMatchObject({ phase: "playing", open: false });
    host.close();
    guest.close();
  });
});
