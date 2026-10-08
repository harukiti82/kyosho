// 接続: 再接続・退避からの復帰・3 人目・不正な入力・存在しない部屋・放置した部屋の削除

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLOSE, FINISHED_TTL_MS, MAX_MESSAGE_BYTES, PING_TEXT, PONG_TEXT, ROOM_TTL_MS } from "../../web/src/net/protocol";
import { chooseLookahead } from "../../web/src/engine/cpu";
import { presetById } from "../../web/src/engine/rules";
import type { RoomRecord } from "../src/room";
import { call, Client, createRoom, startedRoom, stubOf } from "./helpers";

describe("再接続", () => {
  it("切断すると相手に「切断中」が届き、トークンで同じ席に戻って続きを打てる", async () => {
    const { roomId, host, guest, hostToken } = await startedRoom("v10");
    host.send({ type: "move", r: 2, c: 3, kind: "fu" });
    await host.expect("state");
    const afterMove = await guest.expect("state");
    expect(afterMove.view.turn).toBe(1);

    host.close();
    const offline = await guest.expect("state");
    expect(offline.opponent).toEqual({ joined: true, online: false, left: false });

    const back = await Client.join(roomId, hostToken);
    expect(back.joined).toMatchObject({ you: 0, token: hostToken });
    expect(back.state.view.ply).toBe(1);
    expect(back.state.view.history).toEqual(afterMove.view.history);
    expect(back.state.opponent).toEqual({ joined: true, online: true, left: false });
    expect((await guest.expect("state")).opponent.online).toBe(true);

    // 後手が打ち、戻った先手にも届く。先手も続けて打てる
    guest.send({ type: "move", r: 5, c: 4, kind: "fu" });
    expect((await back.client.expect("state")).view.ply).toBe(2);
    await guest.expect("state");
    back.client.send({ type: "move", r: 2, c: 2, kind: "fu" });
    expect((await back.client.expect("state")).view.ply).toBe(3);
  });

  it("オブジェクトが退避されても、保存した状態から続きを打てる（接続は残る）", async () => {
    const { roomId, host, guest } = await startedRoom("king");
    host.send({ type: "move", r: 2, c: 3, kind: "fu", king: true });
    await host.expect("state");
    await guest.expect("state");
    await evictDurableObject(stubOf(roomId));

    // 退避後の最初のメッセージでコンストラクタが storage から読み直す
    guest.send({ type: "move", r: 2, c: 2, kind: "fu" });
    const s = await guest.expect("state");
    expect(s.view.ply).toBe(2);
    expect((await host.expect("state")).view.myKing.cell).toEqual([2, 3]);

    // 退避後に新しくつないだ接続もトークンで復帰できる
    await evictDurableObject(stubOf(roomId), { webSockets: "close" });
    const back = await Client.join(roomId, (await createdTokens(roomId))[0]!);
    expect(back.state.view.ply).toBe(2);
    expect(back.state.view.myKing.cell).toEqual([2, 3]);
  });

  it("同じトークンで別のタブがつなぐと、古い接続は replaced で閉じる", async () => {
    const { roomId, host, hostToken } = await startedRoom("v10");
    const tab2 = await Client.join(roomId, hostToken);
    expect(tab2.joined.you).toBe(0);
    expect((await host.closedWith()).code).toBe(CLOSE.replaced);
  });

  it("合わないトークンは invalid_token で閉じる", async () => {
    const { roomId } = await startedRoom("v10");
    const c = await Client.connect(roomId);
    c.send({ type: "join", token: "x".repeat(43) });
    await c.expectError("invalid_token");
    expect((await c.closedWith()).code).toBe(CLOSE.rejected);
  });
});

/** storage の席のトークン（テスト用に直接読む） */
const createdTokens = (roomId: string) =>
  runInDurableObject(stubOf(roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!.tokens);

describe("3 人目", () => {
  it("席が埋まった部屋にトークンなしで join すると room_full で閉じる（観戦はしない）", async () => {
    const { roomId, host, guest } = await startedRoom("v10");
    const third = await Client.connect(roomId);
    third.send({ type: "join" });
    await third.expectError("room_full");
    expect((await third.closedWith()).code).toBe(CLOSE.rejected);
    // 対局の 2 人には何も届かない
    expect(await host.quiet()).toBe(true);
    expect(await guest.quiet()).toBe(true);
    const info = await (await call(`/rooms/${roomId}`)).json<{ open: boolean; phase: string }>();
    expect(info).toMatchObject({ open: false, phase: "playing" });
  });
});

describe("不正な入力", () => {
  it("join 後の不正なメッセージはエラーを返すだけで、接続も部屋も生きている", async () => {
    const { host, guest } = await startedRoom("v10");
    const cases: [unknown, string][] = [
      ["{not json", "bad_json"],
      ["x".repeat(MAX_MESSAGE_BYTES + 1), "too_large"],
      // 1 文字 3 バイトなので、文字数は上限以下でもバイト数は超える
      [JSON.stringify({ type: "move", pad: "あ".repeat(400) }), "too_large"],
      ["[1,2]", "bad_message"],
      ["null", "bad_message"],
      [{ type: "hello" }, "bad_message"],
      [{ type: "move", r: 8, c: 0, kind: "fu" }, "bad_message"],
      [{ type: "move", r: -1, c: 0, kind: "fu" }, "bad_message"],
      [{ type: "move", r: 1.5, c: 0, kind: "fu" }, "bad_message"],
      [{ type: "move", r: "2", c: 3, kind: "fu" }, "bad_message"],
      [{ type: "move", r: 2, c: 3, kind: "toString" }, "bad_message"],
      [{ type: "move", r: 2, c: 3, kind: "__proto__" }, "bad_message"],
      [{ type: "move", r: 2, c: 3, kind: "fu", king: "yes" }, "bad_message"],
      [{ type: "join" }, "already_joined"],
    ];
    for (const [msg, code] of cases) {
      host.send(msg);
      await host.expectError(code as never);
    }
    // バイナリ
    host.ws.send(new Uint8Array([1, 2, 3]));
    await host.expectError("bad_message");
    expect(host.closed).toBeNull();
    expect(await guest.quiet()).toBe(true);
    // ping は自動で返る
    host.send(PING_TEXT);
    expect(await host.next()).toEqual(JSON.parse(PONG_TEXT));
    // 部屋はそのまま使える
    host.send({ type: "move", r: 2, c: 3, kind: "fu" });
    expect((await host.expect("state")).view.ply).toBe(1);
  });

  it("join 前に join 以外・壊れた JSON を送ると、エラーを返して閉じる", async () => {
    const { roomId } = await createRoom("v10");
    for (const msg of [{ type: "move", r: 2, c: 3, kind: "fu" }, "{oops", { type: "join", token: 123 }]) {
      const c = await Client.connect(roomId);
      c.send(msg);
      expect((await c.next()).type).toBe("error");
      expect((await c.closedWith()).code).toBe(CLOSE.rejected);
    }
    // 部屋は無事で、作成者は参加できる
    const info = await (await call(`/rooms/${roomId}`)).json<{ open: boolean }>();
    expect(info.open).toBe(true);
  });

  it("存在しない部屋・形式の違う ID に WebSocket でつなぐと room_not_found で閉じる", async () => {
    for (const id of ["AAAAAAAAAAAAAAAAAAAAAA", "bad-id"]) {
      const c = await Client.connect(id);
      await c.expectError("room_not_found");
      expect((await c.closedWith()).code).toBe(CLOSE.notFound);
    }
    // 形式が正しいだけの ID で部屋は作られない
    expect((await call("/rooms/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });

  it("join せずに溜まった接続は古い順に閉じる", async () => {
    const { roomId } = await createRoom("v10");
    const idle: Client[] = [];
    for (let i = 0; i < 5; i++) idle.push(await Client.connect(roomId));
    expect((await idle[0].closedWith()).code).toBe(CLOSE.rejected);
    expect(idle[4].closed).toBeNull();
  });
});

describe("放置した部屋の削除", () => {
  const alarmIn = (roomId: string) =>
    runInDurableObject(stubOf(roomId), async (_i, s) => ((await s.storage.getAlarm()) ?? 0) - Date.now());

  it("操作のたびに alarm を 24 時間後に張り直し、発火したら接続を閉じて部屋を消す", async () => {
    const { roomId, host, guest } = await startedRoom("v10");
    const left = await alarmIn(roomId);
    expect(left).toBeGreaterThan(ROOM_TTL_MS - 60_000);
    expect(left).toBeLessThanOrEqual(ROOM_TTL_MS);

    expect(await runDurableObjectAlarm(stubOf(roomId))).toBe(true);
    expect((await host.closedWith()).code).toBe(CLOSE.expired);
    expect((await guest.closedWith()).code).toBe(CLOSE.expired);
    expect((await call(`/rooms/${roomId}`)).status).toBe(404);
    const late = await Client.connect(roomId);
    await late.expectError("room_not_found");
    expect(await runInDurableObject(stubOf(roomId), (_i, s) => s.storage.get("room"))).toBeUndefined();
  });

  it("終局したら alarm は 1 時間後", async () => {
    // 体力 5 の v1.0 なら数手で決着する
    const { roomId, host, guest, hostState, guestState } = await startedRoom({ ...presetById("v10").rules, hp: [5, 5] });
    let [hs, gs] = [hostState, guestState];
    while (hs.phase === "playing") {
      const mover = hs.view.turn === 0 ? { c: host, s: hs } : { c: guest, s: gs };
      mover.c.send({ type: "move", ...chooseLookahead(mover.s.view, () => 0)! });
      [hs, gs] = await Promise.all([host.expect("state"), guest.expect("state")]);
    }
    expect(gs.phase).toBe("finished");
    const left = await alarmIn(roomId);
    expect(left).toBeGreaterThan(FINISHED_TTL_MS - 60_000);
    expect(left).toBeLessThanOrEqual(FINISHED_TTL_MS);
  });
});
