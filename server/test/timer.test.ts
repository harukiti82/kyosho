// 1 手ごとの制限時間: 部屋の作成・時計の配信・締め切りの alarm での自動の手・入れ違いの手・切断中・終局

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legalCells } from "../../web/src/engine/game";
import { presetById } from "../../web/src/engine/rules";
import { FINISHED_TTL_MS, TURN_GRACE_MS, type StateMessage } from "../../web/src/net/protocol";
import type { Room, RoomRecord } from "../src/room";
import { call, Client, createRoom, startedRoom, stubOf } from "./helpers";

/** 部屋の記録を読む */
const recordOf = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);
const alarmIn = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => ((await s.storage.getAlarm()) ?? 0) - Date.now());

/** 手番の人の締め切りを過去にする（時間が経ったことにする。保存はしないので、次の操作で保存される） */
const expire = (roomId: string) =>
  runInDurableObject(stubOf(roomId), (instance: Room) => {
    const room = (instance as unknown as { room: RoomRecord }).room;
    room.deadline = Date.now() - 1;
  });

/** 手番の人の最初の置ける手 */
function firstMove(s: StateMessage) {
  const kind = (["fu", "yoko", "gin", "kaku", "kin", "hi"] as const).find((k) => s.view.hands[s.view.turn][k] > 0)!;
  const [r, c] = legalCells(s.view as never, kind)[0];
  return { type: "move" as const, r, c, kind };
}

describe("制限時間の部屋", () => {
  it("作るときに turnSeconds（なし・20・45・90）を選べ、部屋の情報に載る。ほかの値は 400", async () => {
    for (const t of [0, 20, 45, 90]) {
      const { roomId } = await createRoom("v10", "first", t);
      const info = await (await call(`/rooms/${roomId}`)).json<{ turnSeconds: number }>();
      expect(info.turnSeconds).toBe(t);
    }
    // 省略は制限なし（制限時間の入る前の画面・scripts/play.mjs）
    const { roomId } = await createRoom("v10", "first");
    expect((await (await call(`/rooms/${roomId}`)).json<{ turnSeconds: number }>()).turnSeconds).toBe(0);
    for (const bad of [30, -1, 45.5, "45", null, 1e9]) {
      const res = await call("/rooms", {
        method: "POST",
        body: JSON.stringify({ preset: "v10", turnSeconds: bad }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status, String(bad)).toBe(400);
    }
  });

  it("対局が始まると時計が届く（制限時間 + 猶予）。待機中・制限なしは null", async () => {
    const created = await createRoom("v10", "first", 20);
    const host = await Client.join(created.roomId, created.token);
    expect(host.state.phase).toBe("waiting");
    expect(host.state.clock).toBeNull();
    const guest = await Client.join(created.roomId);
    const hs = await host.client.expect("state");
    for (const s of [hs, guest.state]) {
      expect(s.phase).toBe("playing");
      expect(s.clock!.limitMs).toBe(20_000);
      expect(s.clock!.remainingMs).toBeGreaterThan(20_000 + TURN_GRACE_MS - 5_000);
      expect(s.clock!.remainingMs).toBeLessThanOrEqual(20_000 + TURN_GRACE_MS);
    }
    // alarm は放置の 24 時間ではなく手番の締め切り
    expect(await alarmIn(created.roomId)).toBeLessThanOrEqual(20_000 + TURN_GRACE_MS);

    const none = await startedRoom("v10");
    expect(none.hostState.clock).toBeNull();
    expect(none.guestState.clock).toBeNull();
  });

  it("手を打つたびに時計は制限時間に戻る", async () => {
    const { roomId, host, guest, hostState } = await startedRoom("v10", 45);
    const before = (await recordOf(roomId)).deadline!;
    host.send({ ...firstMove(hostState) });
    const [hs, gs] = await Promise.all([host.expect("state"), guest.expect("state")]);
    expect(hs.view.turn).toBe(1);
    expect(gs.clock!.remainingMs).toBeGreaterThan(45_000 + TURN_GRACE_MS - 5_000);
    expect((await recordOf(roomId)).deadline!).toBeGreaterThanOrEqual(before);
  });
});

describe("時間切れ", () => {
  it("締め切りの alarm で、手番の人の手を置ける手から自動で打つ。両者に同じ局面が届き、時計は次の手番で戻る", async () => {
    const { roomId, host, guest, hostState } = await startedRoom("std", 20);
    expect(hostState.view.turn).toBe(0);
    await expire(roomId);
    expect(await runDurableObjectAlarm(stubOf(roomId))).toBe(true);
    const [hs, gs] = await Promise.all([host.expect("state"), guest.expect("state")]);
    for (const s of [hs, gs]) {
      expect(s.view.ply).toBe(1);
      const m = s.view.history.at(-1)!;
      expect(m).toMatchObject({ type: "move", player: 0, timeout: true });
      expect(s.view.turn).toBe(1);
      expect(s.clock!.limitMs).toBe(20_000);
    }
    // 両者の画面で局面（盤・棋譜・体力）が一致する
    expect(gs.view.board).toEqual(hs.view.board);
    expect(gs.view.history).toEqual(hs.view.history);
    expect(gs.view.hp).toEqual(hs.view.hp);
    // 次の締め切りに張り直す
    expect(await alarmIn(roomId)).toBeGreaterThan(20_000 + TURN_GRACE_MS - 5_000);
    // 隠し王の真の場所（kings）は送らない
    for (const raw of [...host.raw, ...guest.raw]) expect(raw).not.toContain('"kings"');
  });

  it("締め切りの前に起きた alarm では打たない（張り直すだけ）", async () => {
    const { roomId, host, guest } = await startedRoom("v10", 90);
    expect(await runDurableObjectAlarm(stubOf(roomId))).toBe(true);
    expect(await host.quiet()).toBe(true);
    expect(await guest.quiet()).toBe(true);
    expect((await recordOf(roomId)).game.ply).toBe(0);
    expect(await alarmIn(roomId)).toBeGreaterThan(80_000);
  });

  it("締め切りを過ぎて届いた手は打たず、先に自動の手を打って stale_move を返す（二重に打たない）", async () => {
    const { roomId, host, guest, hostState } = await startedRoom("v10", 20);
    await expire(roomId);
    host.send(firstMove(hostState));
    const hs = await host.expect("state");
    await host.expectError("stale_move");
    const gs = await guest.expect("state");
    expect(hs.view.history).toHaveLength(1);
    expect(hs.view.history[0]).toMatchObject({ timeout: true });
    expect(gs.view.history).toEqual(hs.view.history);
    expect(await host.quiet()).toBe(true);
    expect((await recordOf(roomId)).game.ply).toBe(1);
  });

  it("考えた局面の棋譜の長さ（seq）が違う手は stale_move（自動の手と入れ違い）。合っていれば打てる", async () => {
    const { roomId, host, guest, hostState } = await startedRoom("v10", 45);
    host.send({ ...firstMove(hostState), seq: 3 });
    await host.expectError("stale_move");
    expect((await recordOf(roomId)).game.ply).toBe(0);
    host.send({ ...firstMove(hostState), seq: 0 });
    const [hs] = await Promise.all([host.expect("state"), guest.expect("state")]);
    expect(hs.view.ply).toBe(1);
    expect(hs.view.history[0]).not.toHaveProperty("timeout");
    // seq の型が違えば bad_message
    host.send({ type: "move", r: 0, c: 0, kind: "fu", seq: -1 });
    await host.expectError("bad_message");
  });

  it("相手も自分も切断していても時間は進み、自動の手で終局まで打つ。終局後の alarm は放置の 1 時間", async () => {
    // 裏返すルールは毎手 1 枚以上返すので、体力 5（下限）なら数手で決着する
    const rules = { ...presetById("orig").rules, heal: "none" as const, hp: [5, 5] as [number, number] };
    const { roomId, host, guest } = await startedRoom(rules, 20);
    host.close();
    guest.close();
    await guest.closedWith();
    let n = 0;
    while ((await recordOf(roomId)).game.result === null) {
      await expire(roomId);
      expect(await runDurableObjectAlarm(stubOf(roomId))).toBe(true);
      if (++n > 60) throw new Error("終わらない");
    }
    const rec = await recordOf(roomId);
    expect(rec.game.history.filter((e) => e.type === "move").every((e) => e.type === "move" && e.timeout)).toBe(true);
    expect(rec.deadline).toBeNull();
    const left = await alarmIn(roomId);
    expect(left).toBeGreaterThan(FINISHED_TTL_MS - 60_000);
    expect(left).toBeLessThanOrEqual(FINISHED_TTL_MS);
    // 戻ると終局した局面が届き、時計はない
    const back = await Client.join(roomId, (await recordOf(roomId)).tokens[0]!);
    expect(back.state.phase).toBe("finished");
    expect(back.state.clock).toBeNull();
    expect(back.state.view.result).not.toBeNull();
  });

  it("隠し王の期限の手で時間切れなら、置いた駒が自動で本人の王になり、相手には場所が届かない", async () => {
    const rules = { ...presetById("king").rules, king: { ...presetById("king").rules.king, deadline: 1 } };
    const { roomId, host, guest } = await startedRoom(rules, 20);
    await expire(roomId);
    expect(await runDurableObjectAlarm(stubOf(roomId))).toBe(true);
    const [hs, gs] = await Promise.all([host.expect("state"), guest.expect("state")]);
    const m = hs.view.history[0];
    expect(m).toMatchObject({ type: "move", player: 0, timeout: true });
    if (m.type !== "move") throw new Error("手のはず");
    // 先手（本人）には自分の王が、後手には候補（公開情報）だけが届く
    expect(hs.view.myKing).toMatchObject({ status: "hidden", cell: [m.r, m.c], auto: true });
    expect(gs.view.oppKing.revealed).toBe(false);
    expect(gs.view.myKing.status).not.toBe("hidden");
  });
});
