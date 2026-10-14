// 合言葉（POST /api/match）: 同じ合言葉どうしが同じ部屋になる・違えばつながらない・そろったら空く・待つのをやめたら空く・
// ほぼ同時でも分かれない・不正な合言葉は弾く・送りすぎの制限・合言葉を外に出さない

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { presetById, type RuleSet } from "../../web/src/engine/rules";
import { CLOSE, MATCH_LIMIT, PHRASE_CONNECT_GRACE_MS, type MatchResponse } from "../../web/src/net/protocol";
import { allowMatch } from "../src/index";
import type { RoomRecord } from "../src/room";
import { call, Client, stubOf } from "./helpers";

let seq = 0;
/** テストごとに違う合言葉（ほかのテストの部屋とつながらない） */
const fresh = (base = "あいことば") => `${base}${++seq}`;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call("/match", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

async function match(phrase: string, rules: RuleSet = presetById("v10").rules, extra: Record<string, unknown> = {}): Promise<MatchResponse> {
  const res = await post({ phrase, rules, ...extra });
  if (res.status !== 200 && res.status !== 201) throw new Error(`合言葉が通らない: ${res.status} ${await res.text()}`);
  const body: MatchResponse = await res.json();
  expect(res.status).toBe(body.status === "wait" ? 201 : 200);
  return body;
}

/** 待つ人: 合言葉で部屋を作ってつなぐ */
async function waiter(phrase: string, rules?: RuleSet) {
  const m = await match(phrase, rules);
  if (m.status !== "wait") throw new Error(`待つはずが ${m.status}`);
  const { client, state } = await Client.join(m.roomId, m.token);
  expect(state.phase).toBe("waiting");
  return { ...m, client };
}

const recordOf = (roomId: string) => runInDurableObject(stubOf(roomId), async (_i, s) => (await s.storage.get<RoomRecord>("room"))!);

describe("同じ合言葉", () => {
  it("全角と半角・大文字と小文字・空白の違いは同じ合言葉。2 人目は作成者のルールで参加し、対局が始まる", async () => {
    const n = ++seq;
    const host = await waiter(`Ｋｙｏｓｈｏ　　${n}`, presetById("king").rules);
    const second = await match(`  kyosho ${n} `, presetById("v10").rules);
    expect(second).toEqual({ status: "join", roomId: host.roomId, rules: presetById("king").rules, turnSeconds: 0 });
    const guest = await Client.join(second.roomId);
    expect(guest.state.phase).toBe("playing");
    expect((await host.client.expect("state")).phase).toBe("playing");
  });

  it("違う合言葉ならつながらない（どちらも新しい部屋で待つ）", async () => {
    const a = await waiter(fresh("りんご"));
    const b = await match(fresh("みかん"));
    expect(b.status).toBe("wait");
    expect(b.roomId).not.toBe(a.roomId);
  });

  it("ほぼ同時に入れた 2 人は同じ部屋になる（作成者がつなぐ前でも）", async () => {
    for (let i = 0; i < 3; i++) {
      const phrase = fresh("同時");
      const rs = await Promise.all([match(phrase), match(phrase)]);
      expect(rs.map((r) => r.status).sort()).toEqual(["join", "wait"]);
      expect(rs[0].roomId).toBe(rs[1].roomId);
    }
  });

  it("5 人が同時に入れても部屋は 1 つ（作った 1 人と、参加の案内 4 人）", async () => {
    const phrase = fresh("五人");
    const rs = await Promise.all(Array.from({ length: 5 }, () => match(phrase)));
    expect(rs.filter((r) => r.status === "wait")).toHaveLength(1);
    expect(new Set(rs.map((r) => r.roomId)).size).toBe(1);
  });
});

describe("合言葉が空く", () => {
  it("2 人がそろったら、同じ合言葉の 3 人目は新しい部屋で待つ", async () => {
    const phrase = fresh();
    const host = await waiter(phrase);
    const second = await match(phrase);
    await Client.join(second.roomId);
    const third = await match(phrase);
    expect(third.status).toBe("wait");
    expect(third.roomId).not.toBe(host.roomId);
    // 4 人目は 3 人目の部屋へ
    const fourth = await match(phrase);
    expect(fourth).toMatchObject({ status: "join", roomId: third.roomId });
  });

  it("待っている人が leave で抜けたら、次の人は新しい部屋で待つ", async () => {
    const phrase = fresh();
    const host = await waiter(phrase);
    host.client.send({ type: "leave" });
    await host.client.quiet(50);
    host.client.close();
    const next = await match(phrase);
    expect(next.status).toBe("wait");
    expect(next.roomId).not.toBe(host.roomId);
  });

  it("待っている人が閉じた（切断）なら、次の人は新しい部屋で待つ", async () => {
    const phrase = fresh();
    const host = await waiter(phrase);
    host.client.close();
    await host.client.closedWith();
    const next = await match(phrase);
    expect(next.status).toBe("wait");
    expect(next.roomId).not.toBe(host.roomId);
  });

  it("作った後につながないまま猶予が過ぎた部屋には案内しない", async () => {
    const phrase = fresh();
    const first = await match(phrase);
    // 作った時刻を猶予より前にする（時間が経ったことにする。判定はオブジェクトのメモリの記録を読む）
    await runInDurableObject(stubOf(first.roomId), async (inst) => {
      (inst as unknown as { room: RoomRecord }).room.createdAt -= PHRASE_CONNECT_GRACE_MS + 1;
    });
    const next = await match(phrase);
    expect(next.status).toBe("wait");
    expect(next.roomId).not.toBe(first.roomId);
  });

  it("参加の案内を受けた後に作成者が抜けたら、その部屋への参加は room_not_found で閉じる（ひとりの部屋に座らせない）", async () => {
    const phrase = fresh();
    const host = await waiter(phrase);
    const second = await match(phrase);
    expect(second.status).toBe("join");
    host.client.send({ type: "leave" });
    await host.client.quiet(50);
    host.client.close();
    const late = await Client.connect(second.roomId);
    late.send({ type: "join" });
    await late.expectError("room_not_found");
    expect((await late.closedWith()).code).toBe(CLOSE.notFound);
    // 部屋の席は空いたまま（参加者のトークンを発行していない）
    expect((await recordOf(second.roomId)).tokens.filter((t) => t !== null)).toHaveLength(1);
  });

  it("招待リンクの部屋は、作成者が切断していてもトークンなしで参加できる（今までどおり）", async () => {
    const res = await call("/rooms", { method: "POST", body: JSON.stringify({ preset: "v10", hostSeat: "first" }), headers: { "Content-Type": "application/json" } });
    const created = await res.json<{ roomId: string; token: string }>();
    const host = await Client.join(created.roomId, created.token);
    host.client.close();
    await host.client.closedWith();
    const guest = await Client.join(created.roomId);
    expect(guest.state.phase).toBe("playing");
  });
});

describe("入力の検証", () => {
  const bad = ["", "   ", "　", "a".repeat(21), "あ".repeat(21), "a\u0000b", "a\tb", "a\nb", "a​b", "a b", 123, null, ["a"]];
  it.each(bad.map((p) => [JSON.stringify(p), p]))("不正な合言葉 %s は 400 bad_phrase", async (_label, phrase) => {
    const res = await post({ phrase, preset: "v10" });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("bad_phrase");
  });

  it("合言葉がない・ルールが不正・JSON でない", async () => {
    expect((await post({ preset: "v10" })).status).toBe(400);
    const badRules = await post({ phrase: fresh(), preset: "nope" });
    expect(badRules.status).toBe(400);
    expect((await badRules.json<{ error: { code: string } }>()).error.code).toBe("bad_rules");
    expect((await post("{")).status).toBe(400);
    expect((await call("/match")).status).toBe(405);
  });

  it("20 字ちょうど（全角・絵文字のサロゲートペアも 1 字）は通る", async () => {
    expect((await match(`${++seq}`.padEnd(20, "x"))).status).toBe("wait");
    expect((await match(`${++seq}`.padEnd(20, "あ"))).status).toBe("wait");
    expect((await match(`${++seq}`.padEnd(20 - 1, "z") + "😀")).status).toBe("wait");
  });
});

describe("送りすぎの制限", () => {
  it(`同じ接続元からは ${MATCH_LIMIT} 回まで。超えると 429 too_many_requests（ほかの接続元は通る）`, async () => {
    const ip = { "CF-Connecting-IP": `203.0.113.${++seq % 250}` };
    // 合言葉が不正でも数える（部屋は作らない）
    for (let i = 0; i < MATCH_LIMIT; i++) expect((await post({ phrase: "", preset: "v10" }, ip)).status).toBe(400);
    const over = await post({ phrase: fresh(), preset: "v10" }, ip);
    expect(over.status).toBe(429);
    expect((await over.json<{ error: { code: string } }>()).error.code).toBe("too_many_requests");
    expect((await post({ phrase: fresh(), preset: "v10" }, { "CF-Connecting-IP": "198.51.100.7" })).status).toBe(201);
  });

  it("数え直しの時刻を過ぎたら、また通る", () => {
    const ip = "192.0.2.1";
    const t = 1_000_000;
    for (let i = 0; i < MATCH_LIMIT; i++) expect(allowMatch(ip, t)).toBe(true);
    expect(allowMatch(ip, t + 1)).toBe(false);
    expect(allowMatch(ip, t + 60_000)).toBe(true);
  });
});

describe("合言葉を外に出さない", () => {
  it("部屋の記録・部屋の情報・WebSocket のメッセージに合言葉が入らない", async () => {
    const phrase = `ひみつ${++seq}`;
    const host = await waiter(phrase);
    const second = await match(phrase);
    expect(JSON.stringify(second)).not.toContain(phrase);
    const guest = await Client.join(second.roomId);
    await host.client.expect("state");
    const record = await recordOf(host.roomId);
    expect(record.phrase).toBe(true);
    expect(JSON.stringify(record)).not.toContain(phrase);
    expect(await (await call(`/rooms/${host.roomId}`)).text()).not.toContain(phrase);
    for (const raw of [...host.client.raw, ...guest.client.raw]) expect(raw).not.toContain(phrase);
  });
});
