// スキル: カードの配布と選択・時計・使用の検証・隠し情報（偵察で分かった王・王の移し替えの先・副将）・再戦での配り直し・再接続

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kingCandidates, kingMoveCells, refillKinds, viewFor, type GameState, type PlayerView } from "../../web/src/engine/game";
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

/** 両者が firstLegal で plies 手打つ（designate なら先手・後手とも最初の手の駒を王にする。しなければ期限の手で自動） */
async function playPlies(room: Awaited<ReturnType<typeof startedRoom>>, start: [StateMessage, StateMessage], plies: number, designate = true) {
  const clients = [room.host, room.guest] as const;
  let last = start;
  const own = [0, 0];
  for (let i = 0; i < plies; i++) {
    const p = last[0].view.turn;
    own[p]++;
    clients[p].send({ type: "move", ...firstLegal(last[p].view), king: designate && own[p] === 1 });
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
    // 補充で減っていない駒は戻せない
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
    const room = await startedRoom({ ...SKILL, king: { ...SKILL.king, deadline: 5 } });
    const start = await pickFirst(room);
    // 両者が 5 手ずつ打ち、期限の 5 手目で王が決まった。先手の手番。後手の王の候補は 2 つ以上
    const [h] = await playPlies(room, start, 10, false);
    expect(h.view.oppKing.candidates.length).toBeGreaterThanOrEqual(2);
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

    // 2 回目（王が分かっている）は相手の今の副将を特定する。副将が未定なら使えない
    room.host.send({ type: "move", ...firstLegal(h1.view) });
    const [, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(g2.view.myVice).toMatchObject({ status: "unset" });
    room.guest.send({ type: "move", ...firstLegal(g2.view) });
    const [h3] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    // 後手の副将を出す期限（王の期限 5 手 ＋ 7 手 = 12 手）まで、出したかどうかも先手に出ない
    expect(h3.view.oppVice).toEqual({ set: false, wait: 6, scouted: false, cell: null });
    await patch(room.roomId, charge(0, "scout"));
    room.host.send({ type: "skill", id: "scout" });
    await room.host.expectError("illegal_skill");
    room.host.send({ type: "move", ...firstLegal(h3.view) });
    const [, g4] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    // 副将は置く手の vice で出す。型の違う vice・王と同じ手・相手の手番は拒否
    const mv = firstLegal(g4.view);
    room.guest.send({ type: "move", ...mv, vice: "yes" } as never);
    await room.guest.expectError("bad_message");
    room.guest.send({ type: "move", ...mv, king: true, vice: true });
    await room.guest.expectError("illegal_move");
    room.host.send({ type: "move", ...mv, vice: true });
    await room.host.expectError("not_your_turn");
    room.guest.send({ type: "move", ...mv, vice: true });
    const [h5, g5] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    const viceAt: [number, number] = [mv.r, mv.c];
    expect(g5.view.myVice).toMatchObject({ status: "set", cell: viceAt, auto: false });
    // 先手には出したことも届かない（副将を出していない手と同じ view）
    expect(h5.view.oppVice).toEqual({ set: false, wait: 5, scouted: false, cell: null });
    expect(JSON.stringify(h5)).not.toContain('"vice"');
    expect((await stored(room.roomId)).game.kings[1].vice).toMatchObject({ cell: viceAt });
    // もう出してあれば出せない
    room.host.send({ type: "move", ...firstLegal(h5.view) });
    const [, g6] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    room.guest.send({ type: "move", ...firstLegal(g6.view), vice: true });
    await room.guest.expectError("illegal_move");
    // 期限を過ぎたことにして（返されて始まった期間で、期限の手を打ち終えた）、先手が偵察で後手の副将を特定する
    await patch(room.roomId, (g) => {
      const c = charge(0, "scout")(g);
      const kings: GameState["kings"] = [c.kings[0], { ...c.kings[1], vice: { ...c.kings[1].vice!, since: -7, hit: true } }];
      return { ...c, kings, skills: { ...c.skills!, sides: [c.skills!.sides[0], { ...c.skills!.sides[1], gauge: 101 }] } };
    });
    room.guest.send({ type: "move", ...firstLegal(g6.view) });
    const [h6] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h6.view.oppVice).toEqual({ set: true, wait: 0, scouted: false, cell: null });
    const oppGauge = h6.view.skills!.sides[1].gauge;
    room.host.send({ type: "skill", id: "scout" });
    const [h7, g7] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h7.view.skills!.armed).toEqual({ id: "scout", scout: "vice" });
    expect(h7.view.oppVice).toEqual({ set: true, wait: 0, scouted: true, cell: viceAt });
    // ゲージ半減の効果はない
    expect(g7.view.skills!.sides[1].gauge).toBe(oppGauge);
    expect(g7.view.myVice.seen).toBe(true);
    expect(g7.view.oppVice.cell).toBeNull();
    for (const c of [room.host, room.guest]) for (const t of c.raw) expect(t).not.toContain('"kings"');
  });

  it("副将: 相手の副将の場所は特定されるまで先手の view に出ない（出した駒が違っても・出していなくても同じ）", async () => {
    // サーバーが送る view は viewFor そのもの。後手の副将をどの駒にしても、先手への view は 1 バイトも変わらない
    const room = await startedRoom({ ...SKILL, king: { ...SKILL.king, deadline: 1 } });
    const start = await pickFirst(room);
    const [, g] = await playPlies(room, start, 7);
    expect(g.view.turn).toBe(1);
    const base = (await stored(room.roomId)).game;
    const mine: [number, number][] = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (base.board[r][c]?.owner === 1 && !(base.kings[1].cell![0] === r && base.kings[1].cell![1] === c)) mine.push([r, c]);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    // 出していない（null）ときも同じ（後手が副将を出す期限の前は、出したかどうかも出ない）
    const seen = new Set([...mine, null].map((cell) => JSON.stringify(viewFor({ ...base, kings: [base.kings[0], { ...base.kings[1], vice: { cell, since: 1 } }] }, 0))));
    expect(seen.size).toBe(1);
  });

  it("王の移し替え: 移した先が違っても、相手に届くメッセージは 1 バイトも変わらない", async () => {
    /** 先手が王を移し替えて 1 手打ち、後手が 1 手打つまで。to は移す先を候補から選ぶ添字 */
    async function run(pick: number) {
      const room = await startedRoom({ ...SKILL, king: { ...SKILL.king, deadline: 1 } });
      const start = await pickFirst(room);
      const [h] = await playPlies(room, start, 6);
      // 配られたカード（部屋ごとにランダム）をそろえる: 先手は王の移し替えが満タン、後手は鉄壁 0。
      // 配られたのが巻き戻しなら打つ間に戻す局面（undo）を覚えているので、それも消して 2 部屋をそろえる
      await patch(room.roomId, (g) => {
        const c = charge(0, "kingmove")(g);
        const { undo: _undo, ...sk } = c.skills!;
        return { ...c, skills: { ...sk, sides: [sk.sides[0], { offer: ["wall"], card: "wall", gauge: 0 }] } };
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

describe("新しいカード", () => {
  /** 運命の輪の指定（補充の駒・王の移し替えの先）を view から 1 つ選ぶ */
  const aimOf = (v: PlayerView) =>
    v.skills!.armed!.effect === "refill" ? { kind: refillKinds(v)[0] } : { to: kingMoveCells(v)[0] };

  it("巻き戻し: 2 手戻した局面が両者に届く。戻す局面（王を含む）はどのメッセージにも出ず、相手の王の指定は残る", async () => {
    const room = await startedRoom(SKILL);
    const start = await pickFirst(room);
    // 先手は巻き戻し（ゲージ 0）。後手は最初の手で王を決める
    await patch(room.roomId, (g) => ({ ...g, skills: { ...g.skills!, sides: [{ offer: ["judge"], card: "judge", gauge: 0 }, { offer: ["wall"], card: "wall", gauge: 0 }] } }));
    const [h] = await playPlies(room, start, 2);
    const kept = (await stored(room.roomId)).game;
    expect(kept.skills!.undo![0]).not.toBeNull();
    expect(kept.kings[1].cell).not.toBeNull();
    expect(h.view.skills!.undoable).toEqual([true, false]);
    await patch(room.roomId, charge(0, "judge"));
    room.host.send({ type: "skill", id: "judge", seq: h.view.history.length });
    const [h1, g1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h1.view.history).toHaveLength(h.view.history.length - 2);
    expect(h1.view.turn).toBe(0);
    expect(h1.view.skills!.armed).toMatchObject({ id: "judge", back: 2 });
    expect(g1.view.skills!.armed).toMatchObject({ id: "judge", back: 2 });
    // 後手の王の指定は残る（次に置く駒が王）。先手には何も分からない
    expect(g1.view.myKing).toMatchObject({ status: "unset", kept: true, forcedNow: true });
    expect(h1.view.oppKing).toEqual({ revealed: false, candidates: [], scouted: false });
    for (const c of [room.host, room.guest]) {
      for (const t of c.raw) {
        expect(t).not.toContain('"kings"');
        expect(t).not.toContain('"undo"');
      }
    }
    for (const t of room.host.raw) expect(t).not.toContain('"kept":true');
    // 戻した局面から打ち直せる。後手の次の手の駒が王になる
    room.host.send({ type: "move", ...firstLegal(h1.view), seq: h1.view.history.length });
    const [, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    const m = g2.view.history.at(-1)!;
    expect(m.type === "move" && m.skill).toMatchObject({ id: "judge", back: 2 });
    const mv = firstLegal(g2.view);
    room.guest.send({ type: "move", ...mv });
    const [, g3] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(g3.view.myKing).toMatchObject({ status: "hidden", cell: [mv.r, mv.c] });
  });

  it("巻き戻し: 戻す手がなければ拒否する", async () => {
    const room = await startedRoom(SKILL);
    await pickFirst(room);
    await patch(room.roomId, charge(0, "judge"));
    room.host.send({ type: "skill", id: "judge" });
    await room.host.expectError("illegal_skill");
  });

  it("運命の輪: 引く効果はサーバーが決め、補充・王の移し替えが出たら続けて指定する。指定を待つ間は置けない", async () => {
    /** 部屋を作って 16 手進め、先手が運命の輪を使って 1 手打つ。引いた効果を返す */
    async function spin(): Promise<string> {
      const room = await startedRoom(SKILL);
      const start = await pickFirst(room);
      const [h] = await playPlies(room, start, 16);
      expect(h.view.turn).toBe(0);
      await patch(room.roomId, charge(0, "wheel"));
      room.host.send({ type: "skill", id: "wheel" });
      const [h1, g1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      const armed = h1.view.skills!.armed!;
      expect(armed.id).toBe("wheel");
      expect(g1.view.skills!.armed!.effect).toBe(armed.effect);
      let v = h1.view;
      if (armed.aim) {
        room.host.send({ type: "move", ...firstLegal(v) });
        await room.host.expectError("illegal_move");
        room.host.send({ type: "skill", id: "wheel", ...aimOf(v) });
        const [a] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
        v = a.view;
        expect(v.skills!.armed!.aim).toBeUndefined();
      }
      room.host.send({ type: "move", ...firstLegal(v) });
      const [h2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
      const m = h2.view.history.filter((e) => e.type === "move").at(-1)!;
      expect(m.type === "move" && m.skill?.effect).toBe(armed.effect);
      return armed.effect!;
    }
    const effects = new Set<string>();
    for (let i = 0; i < 6; i++) effects.add(await spin());
    expect(effects.size).toBeGreaterThanOrEqual(2);
  });

  it("連続行動: 1 手目の後も同じ人の番で、相手の手は受けない。2 手目のダメージは半分", async () => {
    const room = await startedRoom(SKILL);
    const start = await pickFirst(room);
    const [h] = await playPlies(room, start, 4);
    await patch(room.roomId, charge(0, "fool"));
    room.host.send({ type: "skill", id: "fool" });
    const [h1] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    room.host.send({ type: "move", ...firstLegal(h1.view) });
    const [h2, g2] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    expect(h.view.turn).toBe(0);
    expect(h2.view.turn).toBe(0);
    expect(g2.view.skills!.second).toBe(true);
    room.guest.send({ type: "move", ...firstLegal(g2.view) });
    await room.guest.expectError("not_your_turn");
    room.host.send({ type: "skill", id: "fool" });
    await room.host.expectError("illegal_skill");
    room.host.send({ type: "move", ...firstLegal(h2.view) });
    const [h3] = await Promise.all([room.host.expect("state"), room.guest.expect("state")]);
    const m = h3.view.history.filter((e) => e.type === "move").at(-1)!;
    expect(m.type === "move" && m.second).toBe(true);
    expect(m.type === "move" && m.damage).toBe(m.type === "move" ? Math.floor(m.plain! / 2) : -1);
    expect(h3.view.skills!.second).toBeUndefined();
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
