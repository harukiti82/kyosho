// 対局: 参加・終局までの通し・手番違い・不正な手・終局後の手

import { describe, expect, it } from "vitest";
import { chooseLookahead } from "../../web/src/engine/cpu";
import { createGame, playMove, type GameState } from "../../web/src/engine/game";
import { presetById, type PresetId } from "../../web/src/engine/rules";
import type { MoveMessage, StateMessage } from "../../web/src/net/protocol";
import { Client, createRoom, startedRoom } from "./helpers";

/** 種付き乱数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 両者が 2 手読みの CPU で終局まで打つ。打った手と最後の state を返す */
async function playOut(host: Client, guest: Client, first: [StateMessage, StateMessage], seed: number) {
  const rand = rng(seed);
  let [hs, gs] = first;
  const moves: MoveMessage[] = [];
  while (hs.phase === "playing") {
    const mover = hs.view.turn === hs.you ? { c: host, s: hs } : { c: guest, s: gs };
    const choice = chooseLookahead(mover.s.view, rand);
    if (!choice) throw new Error("打てる手がない");
    const move: MoveMessage = { type: "move", ...choice };
    mover.c.send(move);
    moves.push(move);
    [hs, gs] = await Promise.all([host.expect("state"), guest.expect("state")]);
    if (moves.length > 400) throw new Error("終わらない");
  }
  return { moves, hs, gs };
}

describe("参加から終局まで", () => {
  it.each<[PresetId, number]>([
    ["v10", 1],
    ["king", 2],
    ["anchor", 3],
  ])("%s: 2 人が参加して終局まで打ち、両者に同じ勝敗が届く（ローカルの再生と一致）", async (preset, seed) => {
    const created = await createRoom(preset, "first");
    const host = await Client.join(created.roomId, created.token);
    expect(host.joined).toMatchObject({ you: 0, token: created.token });
    expect(host.state).toMatchObject({ phase: "waiting", you: 0, opponent: { joined: false, online: false } });

    const guest = await Client.join(created.roomId);
    expect(guest.joined).toMatchObject({ you: 1 });
    expect(guest.joined.token).not.toBe(created.token);
    expect(guest.state).toMatchObject({ phase: "playing", you: 1, opponent: { joined: true, online: true } });
    const hostStart = await host.client.expect("state");
    expect(hostStart).toMatchObject({ phase: "playing", opponent: { joined: true, online: true } });

    const { moves, hs, gs } = await playOut(host.client, guest.client, [hostStart, guest.state], seed);
    expect(hs.phase).toBe("finished");
    expect(gs.phase).toBe("finished");
    expect(hs.view.result).not.toBeNull();
    expect(gs.view.result).toEqual(hs.view.result);

    // サーバーの結果は、同じ手をローカルの engine で打った結果と一致する
    let g: GameState = createGame(presetById(preset).rules);
    for (const m of moves) g = playMove(g, m.r, m.c, m.kind, { king: m.king });
    expect(hs.view.result).toEqual(g.result);
    expect(hs.view.history).toEqual(g.history);
    expect(hs.view.hp).toEqual(g.hp);

    // 終局後の手は拒否
    host.client.send({ type: "move", r: 0, c: 0, kind: "fu" });
    await host.client.expectError("game_over");
    host.client.close();
    guest.client.close();
  });
});

describe("手の検証", () => {
  it("相手の手番に送った手は not_your_turn。状態は変わらない", async () => {
    const { host, guest, guestState } = await startedRoom("v10");
    expect(guestState.view.turn).toBe(0);
    guest.send({ type: "move", r: 2, c: 3, kind: "fu" });
    await guest.expectError("not_your_turn");
    expect(await host.quiet()).toBe(true);
    // 先手は打てる（ply 1 になる）
    host.send({ type: "move", r: 2, c: 3, kind: "fu" });
    expect((await host.expect("state")).view.ply).toBe(1);
    expect((await guest.expect("state")).view.ply).toBe(1);
  });

  it("打てない手は illegal_move。状態は変わらず、続けて正しい手を打てる", async () => {
    // v2 案（裏返す）: 空きマスでも返せる駒がなければ置けない
    const { host, guest } = await startedRoom("v2");
    host.send({ type: "move", r: 0, c: 0, kind: "fu" });
    await host.expectError("illegal_move");
    // 中央の初期配置のマス（埋まっている）
    host.send({ type: "move", r: 3, c: 3, kind: "fu" });
    await host.expectError("illegal_move");
    // 持ち駒にない駒（v2 は横 0 個）
    host.send({ type: "move", r: 2, c: 3, kind: "yoko" });
    await host.expectError("illegal_move");
    // 隠し王なしの設定で王を指定
    host.send({ type: "move", r: 2, c: 3, kind: "fu", king: true });
    await host.expectError("illegal_move");
    expect(await guest.quiet()).toBe(true);
    host.send({ type: "move", r: 2, c: 3, kind: "fu" });
    const s = await host.expect("state");
    expect(s.view.ply).toBe(1);
    expect(s.view.board[2][3]).toEqual({ owner: 0, kind: "fu" });
  });

  it("相手の参加前の手は waiting_opponent", async () => {
    const created = await createRoom("v10", "first");
    const host = await Client.join(created.roomId, created.token);
    host.client.send({ type: "move", r: 2, c: 3, kind: "fu" });
    await host.client.expectError("waiting_opponent");
  });
});
