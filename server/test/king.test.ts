// 隠し王: 相手の王の場所が WebSocket に一切流れないこと

import { describe, expect, it } from "vitest";
import { chooseLookahead } from "../../web/src/engine/cpu";
import { isLegal, viewFor, type GameState, type PlayerView } from "../../web/src/engine/game";
import { KIND_ORDER, presetById, type Player, type RuleSet } from "../../web/src/engine/rules";
import type { MoveMessage, StateMessage } from "../../web/src/net/protocol";
import type { RoomRecord } from "../src/room";
import { playOut, startedRoom, stubOf, type Client } from "./helpers";
import { runInDurableObject } from "cloudflare:test";

/** 盤の左上から走査して最初に打てる手（自分の王に左右されない決まった手） */
function firstLegal(view: PlayerView): Omit<MoveMessage, "type" | "king"> {
  // isLegal は kings を読まない（手番・盤・持ち駒・ルールだけ）
  const g = view as unknown as GameState;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) for (const kind of KIND_ORDER) if (isLegal(g, r, c, kind)) return { r, c, kind };
  throw new Error("打てる手がない");
}

/**
 * 隠し王プリセットの部屋で、両者が firstLegal で plies 手打つ。
 * 先手は 1 手目、後手は kingMove 手目（自分の手で数える）の駒を王にする
 */
async function play(kingMove: number, plies: number) {
  const room = await startedRoom("king");
  const clients: Record<Player, Client> = { 0: room.host, 1: room.guest };
  const last: Record<Player, StateMessage> = { 0: room.hostState, 1: room.guestState };
  const own: Record<Player, number> = { 0: 0, 1: 0 };
  for (let i = 0; i < plies; i++) {
    const p = last[0].view.turn;
    own[p]++;
    const move: MoveMessage = { type: "move", ...firstLegal(last[p].view), king: own[p] === (p === 0 ? 1 : kingMove) };
    clients[p].send(move);
    [last[0], last[1]] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
  }
  return { ...room, last };
}

/** 部屋の ID・トークンなど対局と関係ない値を伏せた、受け取ったテキスト */
const scrub = (c: Client, roomId: string, tokens: string[]) =>
  c.raw.map((t) => tokens.reduce((s, tok) => s.replaceAll(tok, "<token>"), t.replaceAll(roomId, "<room>")));

describe("隠し王の秘匿", () => {
  it("相手が王を指定した手が違っても、自分に届くメッセージは 1 バイトも変わらない（王が返されるまで）", async () => {
    // firstLegal 同士だと、後手が 3 手目か 4 手目で王を決めた場合は 12 手まで王が返されない（1・2 手目だと先手が返してしまう）
    const PLIES = 12;
    const a = await play(3, PLIES);
    const b = await play(4, PLIES);
    // 前提: まだどちらの王も返されていない（公開されたら場所が分かるのは正しい）
    for (const r of [a, b]) {
      expect(r.last[0].view.history.some((e) => e.type === "move" && e.king)).toBe(false);
      expect(r.last[0].view.myKing.status).toBe("hidden");
      expect(r.last[1].view.myKing.status).toBe("hidden");
    }
    // 後手は別のマスを王にしている
    expect(a.last[1].view.myKing.cell).not.toEqual(b.last[1].view.myKing.cell);

    const ha = scrub(a.host, a.roomId, [a.hostToken, a.guestToken]);
    const hb = scrub(b.host, b.roomId, [b.hostToken, b.guestToken]);
    expect(ha.length).toBeGreaterThan(PLIES);
    expect(ha).toEqual(hb);
    // 検査が効いていることの確認: 後手自身に届く内容は違う（自分の王は見える）
    expect(scrub(a.guest, a.roomId, [a.hostToken, a.guestToken])).not.toEqual(scrub(b.guest, b.roomId, [b.hostToken, b.guestToken]));
  });

  it("どのメッセージにも kings（真の状態）はなく、state は viewFor(真の状態, 自分) と一致する", async () => {
    const room = await play(3, 10);
    const stored = await runInDurableObject(stubOf(room.roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);
    for (const c of [room.host, room.guest]) {
      for (const t of c.raw) expect(t).not.toContain('"kings"');
    }
    // 最後の state は真の状態から作った各自の見え方そのもの
    expect(room.last[0].view).toEqual(viewFor(stored.game, 0));
    expect(room.last[1].view).toEqual(viewFor(stored.game, 1));
    // 自分の王の場所は自分にだけ届く
    const k1 = stored.game.kings[1].cell!;
    expect(room.last[1].view.myKing.cell).toEqual(k1);
    expect(room.last[0].view.oppKing).not.toHaveProperty("cell");
  });

  it("CPU 同士で終局まで打っても、届いたメッセージに kings はない", async () => {
    const room = await startedRoom("king");
    let [hs, gs] = [room.hostState, room.guestState];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    while (hs.phase === "playing") {
      const mover = hs.view.turn === 0 ? { c: room.host, s: hs } : { c: room.guest, s: gs };
      mover.c.send({ type: "move", ...chooseLookahead(mover.s.view, rand)! });
      [hs, gs] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    }
    expect(hs.view.result).not.toBeNull();
    for (const c of [room.host, room.guest]) for (const t of c.raw) expect(t).not.toContain('"kings"');
  });

  it("再戦: 前の対局の王の指定が違っても、次の対局で相手が王を指定した手が違っても、自分に届くメッセージは 1 バイトも変わらない", async () => {
    // 体力を下げて、参加者の王が返される前に体力 0 で決着させる（firstLegal 同士。1 局目は 19 手、2 局目は 3 手で決着）
    const rules: RuleSet = { ...presetById("king").rules, hp: [12, 12] };
    /** 1 局目は後手（参加者）が自分の kingMove1 手目、2 局目は先手になった参加者が kingMove2 手目の駒を王にする。作成者は 1 手目 */
    async function run(kingMove1: number, kingMove2: number) {
      const room = await startedRoom(rules);
      const pickFor = (guestKing: number, guestSeat: Player) => (s: StateMessage, own: number) => ({
        ...firstLegal(s.view),
        king: own === (s.you === guestSeat ? guestKing : 1),
      });
      const end1 = await playOut([room.host, room.guest], [room.hostState, room.guestState], pickFor(kingMove1, 1));
      room.host.send({ type: "rematch", action: "request", gameNo: 1 });
      await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      room.guest.send({ type: "rematch", action: "request", gameNo: 1 });
      const [h2, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      // 2 局目は参加者が先手（clients は [先手, 後手]）
      const last2 = await playOut([room.guest, room.host], [g2, h2], pickFor(kingMove2, 0));
      const stored = await runInDurableObject(stubOf(room.roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);
      return { ...room, end1, last2, stored };
    }
    const a = await run(3, 1);
    const b = await run(4, 2);
    for (const r of [a, b]) {
      // 前提: 1 局目は体力 0 で終わり、どちらの王も返されていない。2 局目も参加者（先手）の王は返されていない
      expect(r.end1[0].view.result?.reason).toBe("ko");
      expect(r.end1[0].view.oppKing.revealed).toBe(false);
      expect(r.end1[1].view.oppKing.revealed).toBe(false);
      expect(r.last2[0].view.result).not.toBeNull();
      expect(r.last2[1].view.oppKing.revealed).toBe(false);
      // 新しい対局の記録に前の対局の王は残らず、届く view は新しい対局の viewFor そのもの
      expect(r.stored.gameNo).toBe(2);
      expect(r.last2[1].view).toEqual(viewFor(r.stored.game, 1));
      for (const c of [r.host, r.guest]) for (const t of c.raw) expect(t).not.toContain('"kings"');
    }
    // 参加者は 1 局目・2 局目とも別のマスを王にしている
    expect(a.end1[1].view.myKing.cell).not.toEqual(b.end1[1].view.myKing.cell);
    expect(a.last2[0].view.myKing.cell).not.toEqual(b.last2[0].view.myKing.cell);

    const ha = scrub(a.host, a.roomId, [a.hostToken, a.guestToken]);
    const hb = scrub(b.host, b.roomId, [b.hostToken, b.guestToken]);
    expect(ha.some((t) => t.includes('"gameNo":2'))).toBe(true);
    expect(ha).toEqual(hb);
    // 検査が効いていることの確認: 参加者自身に届く内容は違う
    expect(scrub(a.guest, a.roomId, [a.hostToken, a.guestToken])).not.toEqual(scrub(b.guest, b.roomId, [b.hostToken, b.guestToken]));
  });
});
