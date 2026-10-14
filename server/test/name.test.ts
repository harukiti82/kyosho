// プレイヤーの名前: join で送った名前を検証して相手の state に入れる・名前を送らない古い画面・不正な名前は名前なし・
// つなぎ直しで変えない・再戦で人に付いて回る・別の部屋に漏れない

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NAME_MAX } from "../../web/src/net/name";
import type { RoomRecord } from "../src/room";
import { parseClientMessage } from "../src/validate";
import { Client, createRoom, playOut, quickRules, stubOf } from "./helpers";

const recordOf = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);
const both = (a: Client, b: Client) => Promise.all([a.expect("state"), b.expect("state")]);

/** 先手の作成者と後手の参加者が、それぞれの名前で join した部屋 */
async function namedRoom(hostName?: unknown, guestName?: unknown) {
  const created = await createRoom(quickRules(), "first");
  const host = await Client.join(created.roomId, created.token, hostName);
  const guest = await Client.join(created.roomId, undefined, guestName);
  const hostState = await host.client.expect("state");
  return { ...created, host: host.client, guest: guest.client, hostWait: host.state, hostState, guestState: guest.state, guestToken: guest.joined.token };
}

describe("join の名前の検証（parseClientMessage）", () => {
  const join = (x: object) => {
    const p = parseClientMessage(JSON.stringify({ type: "join", ...x }));
    if (!p.ok) throw new Error(p.message);
    return p.msg;
  };
  it("通る名前は正規化して載せる。空・省略は載せない", () => {
    expect(join({ name: "  はる  " })).toEqual({ type: "join", name: "はる" });
    expect(join({ name: "🍣".repeat(NAME_MAX) })).toEqual({ type: "join", name: "🍣".repeat(NAME_MAX) });
    expect(join({ name: "<script>" })).toEqual({ type: "join", name: "<script>" });
    expect(join({ name: "" })).toEqual({ type: "join" });
    expect(join({})).toEqual({ type: "join" });
  });
  it("不正な名前は参加を断らず名前なし（長すぎる・改行・制御文字・見えない文字・文字列でない）", () => {
    for (const bad of ["あ".repeat(NAME_MAX + 1), "a\nb", "a\u0000", "a​b", "‮ab", 1, true, null, ["a"], { a: 1 }, "<script>alert(1)</script>"]) {
      expect(join({ name: bad }), JSON.stringify(bad)).toEqual({ type: "join" });
    }
  });
});

describe("部屋の名前", () => {
  it("両者の名前が相手の state に届く（作成者の待機中は自分の名前だけ）", async () => {
    const room = await namedRoom("はる", "ゆき");
    expect(room.hostWait).toMatchObject({ phase: "waiting", name: "はる", opponent: { joined: false, name: null } });
    expect(room.hostState).toMatchObject({ phase: "playing", name: "はる", opponent: { joined: true, name: "ゆき" } });
    expect(room.guestState).toMatchObject({ phase: "playing", name: "ゆき", opponent: { joined: true, name: "はる" } });
  });

  it("名前を送らない古い画面の人は名前なし（null）。相手の名前はそのまま届く", async () => {
    const room = await namedRoom(undefined, "ゆき");
    expect(room.hostState).toMatchObject({ name: null, opponent: { name: "ゆき" } });
    expect(room.guestState).toMatchObject({ name: "ゆき", opponent: { name: null } });
    // 両者とも送らない部屋（前の画面同士）も今までどおり打てる
    const old = await namedRoom();
    expect(old.hostState).toMatchObject({ phase: "playing", name: null, opponent: { name: null } });
  });

  it("不正な名前（長い・改行・見えない文字・HTML の長い文字列・文字列でない）は名前なしで参加できる", async () => {
    for (const bad of ["あ".repeat(NAME_MAX + 1), "a\nb", "a​b", "<script>alert(1)</script>", 123]) {
      const room = await namedRoom(bad, "ゆき");
      expect(room.hostState).toMatchObject({ phase: "playing", name: null, opponent: { name: "ゆき" } });
      expect(room.guestState.opponent.name).toBeNull();
      expect((await recordOf(room.roomId)).names).toEqual([null, "ゆき"]);
    }
  });

  it("HTML の記号を含む名前は文字列のまま届く（画面は textContent で出す）", async () => {
    const room = await namedRoom("<b>x</b>", "a&b");
    expect(room.guestState.opponent.name).toBe("<b>x</b>");
    expect(room.hostState.opponent.name).toBe("a&b");
  });

  it("つなぎ直しで別の名前を送っても変えない。最初に名前を送らなかった人は、後の join の名前で決まる", async () => {
    const room = await namedRoom("はる", undefined);
    room.host.close();
    await room.guest.expect("state"); // 作成者の切断
    const back = await Client.join(room.roomId, room.token, "べつの名前");
    expect(back.state).toMatchObject({ name: "はる", opponent: { name: null } });
    expect((await room.guest.expect("state")).opponent).toMatchObject({ online: true, name: "はる" });

    room.guest.close();
    await back.client.expect("state");
    const guestBack = await Client.join(room.roomId, room.guestToken, "ゆき");
    expect(guestBack.state).toMatchObject({ name: "ゆき", opponent: { name: "はる" } });
    expect((await back.client.expect("state")).opponent.name).toBe("ゆき");
  });

  it("再戦で先手と後手が入れ替わっても、名前は人に付いて回る", async () => {
    const room = await namedRoom("はる", "ゆき");
    const [hEnd] = await playOut([room.host, room.guest], [room.hostState, room.guestState]);
    expect(hEnd).toMatchObject({ phase: "finished", name: "はる", opponent: { name: "ゆき" } });
    room.host.send({ type: "rematch", action: "request", gameNo: 1 });
    await both(room.host, room.guest);
    room.guest.send({ type: "rematch", action: "request", gameNo: 1 });
    const [h2, g2] = await both(room.host, room.guest);
    expect(h2).toMatchObject({ gameNo: 2, you: 1, name: "はる", opponent: { name: "ゆき" } });
    expect(g2).toMatchObject({ gameNo: 2, you: 0, name: "ゆき", opponent: { name: "はる" } });
  });

  it("別の部屋に前の部屋の名前は入らない", async () => {
    await namedRoom("はる", "ゆき");
    const next = await namedRoom(undefined, undefined);
    expect(next.hostState).toMatchObject({ name: null, opponent: { name: null } });
    expect((await recordOf(next.roomId)).names).toBeUndefined();
  });
});
