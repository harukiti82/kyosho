// スキル: カードの配布と選択・時計・使用の検証・隠し情報（偵察で分かった王・王の移し替えの先）・再戦での配り直し・再接続

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kingCandidates, viewFor, type GameState } from "../../web/src/engine/game";
import { presetById, type Player, type RuleSet } from "../../web/src/engine/rules";
import { gaugeMax, type SkillId, type SkillSide } from "../../web/src/engine/skills";
import type { StateMessage } from "../../web/src/net/protocol";
import type { Room, RoomRecord } from "../src/room";
import { Client, firstLegal, playOut, startedRoom, stubOf } from "./helpers";

const SKILL = presetById("skill").rules;

/** 両者が配られた先頭のカードを選ぶ（作成者が先手）。選び終えた state を返す */
async function pickFirst(room: Awaited<ReturnType<typeof startedRoom>>): Promise<[StateMessage, StateMessage]> {
  room.host.send({ type: "pick", card: room.hostState.view.skills!.sides[0].offer[0] });
  await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
  room.guest.send({ type: "pick", card: room.guestState.view.skills!.sides[1].offer[0] });
  return Promise.all([room.host.expect("state"), room.guest.expect("state")]);
}

/** 部屋の真の状態を書き換える（ゲージを満たす・カードを決めるなど。テストだけ） */
async function patch(roomId: string, fn: (g: GameState) => GameState) {
  await runInDurableObject(stubOf(roomId), async (inst: Room) => {
    const r = (inst as unknown as { room: RoomRecord }).room;
    r.game = fn(r.game);
  });
}

/** p のカードを card にしてゲージを満たす */
const charge = (p: Player, card: SkillId) => (g: GameState): GameState => {
  const sides: [SkillSide, SkillSide] = [g.skills!.sides[0], g.skills!.sides[1]];
  sides[p] = { offer: [card], card, gauge: gaugeMax(card) };
  return { ...g, skills: { ...g.skills!, sides, ready: true } };
};

const stored = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);

/** 両者が firstLegal で plies 手打つ（先手・後手とも最初の手の駒を王にする） */
async function playPlies(room: Awaited<ReturnType<typeof startedRoom>>, start: [StateMessage, StateMessage], plies: number) {
  const clients = [room.host, room.guest] as const;
  let last = start;
  const own = [0, 0];
  for (let i = 0; i < plies; i++) {
    const p = last[0].view.turn;
    own[p]++;
    clients[p].send({ type: "move", ...firstLegal(last[p].view), king: own[p] === 1 });
    last = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
  }
  return last;
}

describe("スキルのカード", () => {
  it("部屋の対局で 3 枚ずつ配り、自分の分だけが届く。選び終えるまで手を受けず、相手の選んだカードは見せない", async () => {
    const room = await startedRoom(SKILL);
    const h = room.hostState.view.skills!;
    const g = room.guestState.view.skills!;
    expect(h.ready).toBe(false);
    expect(h.sides[0].offer).toHaveLength(3);
    expect(h.sides[1]).toEqual({ offer: [], card: null, gauge: 0 });
    expect(g.sides[1].offer).toHaveLength(3);
    expect(g.sides[0]).toEqual({ offer: [], card: null, gauge: 0 });
    // 選ぶ前の手は engine が拒否する
    room.host.send({ type: "move", ...firstLegal(room.hostState.view) });
    await room.host.expectError("illegal_move");
    // 配られていないカード・不正な形
    const other = (["firstaid", "bigheal", "strong", "omni", "refill", "wall", "scout", "kingmove"] as SkillId[]).find((id) => !h.sides[0].offer.includes(id))!;
    room.host.send({ type: "pick", card: other });
    await room.host.expectError("illegal_skill");
    room.host.send({ type: "pick", card: "fireball" });
    await room.host.expectError("bad_message");

    room.host.send({ type: "pick", card: h.sides[0].offer[1] });
    const [h1, g1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h1.view.skills!.sides[0].card).toBe(h.sides[0].offer[1]);
    expect(g1.view.skills!.sides[0].card).toBeNull();
    // 選び直しはできない
    room.host.send({ type: "pick", card: h.sides[0].offer[0] });
    await room.host.expectError("illegal_skill");

    room.guest.send({ type: "pick", card: g.sides[1].offer[2] });
    const [h2, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h2.view.skills!.ready).toBe(true);
    expect(h2.view.skills!.sides[1].card).toBe(g.sides[1].offer[2]);
    expect(g2.view.skills!.sides[0].card).toBe(h.sides[0].offer[1]);
    // 相手の配られた残りのカードは選んだ後も見せない
    expect(g2.view.skills!.sides[0].offer).toEqual([]);
    // 選び終えたら打てる
    room.host.send({ type: "move", ...firstLegal(h2.view) });
    await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
  });

  it("選んでいる間は時計が止まり、両者が選んだら手番の時計が動く", async () => {
    const room = await startedRoom(SKILL, 20);
    expect(room.hostState.clock).toBeNull();
    const [h, g] = await pickFirst(room);
    expect(h.clock!.limitMs).toBe(20_000);
    expect(g.clock!.limitMs).toBe(20_000);
  });

  it("つなぎ直すと、配られたカード・選んだカード・ゲージがそのまま届く", async () => {
    const room = await startedRoom(SKILL);
    room.guest.send({ type: "pick", card: room.guestState.view.skills!.sides[1].offer[0] });
    await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    room.guest.close();
    await room.host.expect("state");
    const back = await Client.join(room.roomId, room.guestToken);
    expect(back.state.view.skills!.sides[1].offer).toEqual(room.guestState.view.skills!.sides[1].offer);
    expect(back.state.view.skills!.sides[1].card).toBe(room.guestState.view.skills!.sides[1].offer[0]);
    expect(back.state.view.skills!.ready).toBe(false);
  });
});

describe("スキルの使用", () => {
  it("満タンでない・手番でない・指定が違う使用は拒否し、局面を変えない", async () => {
    const room = await startedRoom(SKILL);
    const [h] = await pickFirst(room);
    const mine = h.view.skills!.sides[0].card!;
    room.host.send({ type: "skill", id: mine });
    await room.host.expectError("illegal_skill");
    room.guest.send({ type: "skill", id: "strong" });
    await room.guest.expectError("not_your_turn");
    await patch(room.roomId, charge(0, "refill"));
    // 補充で使い切っていない駒は戻せない
    room.host.send({ type: "skill", id: "refill", kind: "fu" });
    await room.host.expectError("illegal_skill");
    room.host.send({ type: "skill", id: "strong", to: [9, 9] });
    await room.host.expectError("bad_message");
    expect(await room.host.quiet()).toBe(true);
  });

  it("使うと両者に state が届き、棋譜の次の手にスキルが残る（強打で 1.5 倍）", async () => {
    const room = await startedRoom(SKILL);
    const [h] = await pickFirst(room);
    await patch(room.roomId, charge(0, "strong"));
    room.host.send({ type: "skill", id: "strong", seq: h.view.history.length });
    const [h1, g1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h1.view.skills!.armed).toEqual({ id: "strong" });
    expect(g1.view.skills!.armed).toEqual({ id: "strong" });
    expect(h1.view.skills!.sides[0].gauge).toBe(0);
    room.host.send({ type: "move", ...firstLegal(h1.view) });
    const [h2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    const m = h2.view.history.at(-1)!;
    expect(m.type === "move" && m.skill).toEqual({ id: "strong" });
    expect(h2.view.skills!.armed).toBeNull();
  });

  it("偵察: 相手の王の場所は使った人にだけ届き、どのメッセージにも kings はない", async () => {
    const room = await startedRoom({ ...SKILL, king: { ...SKILL.king, deadline: 1 } });
    const start = await pickFirst(room);
    // 両者が 1 手ずつ打って王を決めた（期限 1 手）。先手の手番
    const [h] = await playPlies(room, start, 2);
    await patch(room.roomId, charge(0, "scout"));
    room.host.send({ type: "skill", id: "scout" });
    const [h1, g1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    const truth = (await stored(room.roomId)).game.kings[1].cell!;
    expect(h1.view.oppKing).toEqual({ revealed: false, candidates: [[truth[0], truth[1]]], scouted: true });
    expect(h.view.oppKing.scouted).toBe(false);
    // 後手には使われたことだけ（自分の王は知られた）
    expect(g1.view.myKing.seen).toBe(true);
    expect(g1.view.oppKing.scouted).toBe(false);
    for (const c of [room.host, room.guest]) for (const t of c.raw) expect(t).not.toContain('"kings"');
  });

  it("王の移し替え: 移した先が違っても、相手に届くメッセージは 1 バイトも変わらない", async () => {
    /** 先手が王を移し替えて 1 手打ち、後手が 1 手打つまで。to は移す先を候補から選ぶ添字 */
    async function run(pick: number) {
      const room = await startedRoom({ ...SKILL, king: { ...SKILL.king, deadline: 1 } });
      const start = await pickFirst(room);
      const [h] = await playPlies(room, start, 6);
      // 配られたカード（部屋ごとにランダム）をそろえる: 先手は王の移し替えが満タン、後手は鉄壁 0
      await patch(room.roomId, (g) => {
        const c = charge(0, "kingmove")(g);
        return { ...c, skills: { ...c.skills!, sides: [c.skills!.sides[0], { offer: ["wall"], card: "wall", gauge: 0 }] } };
      });
      const from = room.guest.raw.length;
      const g = (await stored(room.roomId)).game;
      // 先手の王から 2 マス以内の自分の駒
      const k = g.kings[0].cell!;
      const dests: [number, number][] = [];
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++)
          if (g.board[r][c]?.owner === 0 && !(r === k[0] && c === k[1]) && Math.max(Math.abs(r - k[0]), Math.abs(c - k[1])) <= 2) dests.push([r, c]);
      room.host.send({ type: "skill", id: "kingmove", to: dests[pick] });
      const [h1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      room.host.send({ type: "move", ...firstLegal(h1.view) });
      const [h2, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      room.guest.send({ type: "move", ...firstLegal(g2.view) });
      await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      return { room, h, h2, from, dest: dests[pick], ndest: dests.length, game: (await stored(room.roomId)).game };
    }
    const a = await run(0);
    const b = await run(1);
    expect(a.ndest).toBeGreaterThanOrEqual(2);
    expect(a.dest).not.toEqual(b.dest);
    expect(a.game.kings[0].cell).toEqual(a.dest);
    expect(b.game.kings[0].cell).toEqual(b.dest);
    // 先手自身には移した先が届く
    expect(a.h2.view.myKing.cell).toEqual(a.dest);
    // 王を移した後に後手に届いた 2 通（使った・先手が打った。部屋 ID・トークンを伏せる）は同じ。
    // その後の後手の手は、移した先によっては王を返す（返したら公開されるのは正しい）ので比べない
    const scrub = (r: typeof a) =>
      r.room.guest.raw.slice(r.from, r.from + 2).map((t) => [r.room.hostToken, r.room.guestToken].reduce((s, tok) => s.replaceAll(tok, "<token>"), t.replaceAll(r.room.roomId, "<room>")));
    expect(scrub(a).length).toBe(2);
    expect(scrub(a)).toEqual(scrub(b));
    // 後手から見た先手の王の候補は、使った時点の先手の駒すべて（返した駒は除く）
    expect(viewFor(a.game, 1).oppKing.candidates.length).toBe(kingCandidates(a.game, 0).length);
  });
});

describe("再戦", () => {
  it("同じ部屋の再戦では配り直し、前の対局のカード・ゲージを持ち越さない", async () => {
    const rules: RuleSet = { ...SKILL, hp: [12, 12] };
    const room = await startedRoom(rules);
    const start = await pickFirst(room);
    await playOut([room.host, room.guest], start);
    room.host.send({ type: "rematch", action: "request", gameNo: 1 });
    await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    room.guest.send({ type: "rematch", action: "request", gameNo: 1 });
    const [h2, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h2.gameNo).toBe(2);
    // 参加者が先手になった
    expect(g2.view.skills!.ready).toBe(false);
    expect(g2.view.skills!.sides[0].offer).toHaveLength(3);
    expect(g2.view.skills!.sides[0].card).toBeNull();
    expect(g2.view.skills!.sides[0].gauge).toBe(0);
    expect(h2.view.skills!.sides[1].offer).toHaveLength(3);
  });
});
