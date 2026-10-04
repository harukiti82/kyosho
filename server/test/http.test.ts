// HTTP: 部屋の作成・情報・ルールの検証・CORS / Origin・不正な入力

import { describe, expect, it } from "vitest";
import { cloneRules, presetById, type RuleSet } from "../../web/src/engine/rules";
import { MAX_CREATE_BYTES, ROOM_ID_PATTERN, TOKEN_PATTERN, type RoomInfoResponse } from "../../web/src/net/protocol";
import { originAllowed } from "../src/index";
import { call, createRoom } from "./helpers";

const post = (body: string, headers: Record<string, string> = {}) =>
  call("/rooms", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

describe("部屋の作成", () => {
  it("プリセットのルールで部屋を作り、推測されにくい ID とトークンを受け取る", async () => {
    const a = await createRoom("king");
    const b = await createRoom("king");
    expect(a.roomId).toMatch(ROOM_ID_PATTERN);
    expect(a.token).toMatch(TOKEN_PATTERN);
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.token).not.toBe(b.token);
    expect([0, 1]).toContain(a.you);
  });

  it("hostSeat で作成者の手番を選べる", async () => {
    expect((await createRoom("v10", "first")).you).toBe(0);
    expect((await createRoom("v10", "second")).you).toBe(1);
  });

  it("GET /rooms/:id でルールと空き席が分かる", async () => {
    const { roomId } = await createRoom("dir");
    const res = await call(`/rooms/${roomId}`);
    expect(res.status).toBe(200);
    const info: RoomInfoResponse = await res.json();
    expect(info).toEqual({ roomId, phase: "waiting", rules: presetById("dir").rules, open: true });
  });

  it("全プリセットで作れる", async () => {
    for (const id of ["v04", "v10", "v2", "orig", "king", "dir", "anchor"] as const) {
      const { roomId } = await createRoom(id);
      const info: RoomInfoResponse = await (await call(`/rooms/${roomId}`)).json();
      expect(info.rules).toEqual(presetById(id).rules);
    }
  });
});

describe("不正なルール・本文", () => {
  const base = () => cloneRules(presetById("king").rules);

  it.each([
    ["体力が範囲外", { ...base(), hp: [0, 20] }],
    ["体力が小数", { ...base(), hp: [20.5, 20] }],
    ["体力が文字列", { ...base(), hp: ["20", 20] }],
    ["列挙の外", { ...base(), action: "explode" }],
    ["項目が欠けている", (() => { const r: Partial<RuleSet> = base(); delete r.king; return r; })()],
    ["持ち駒が負", { ...base(), hand: { ...base().hand, fu: -1 } }],
    ["持ち駒の駒種が欠けている", { ...base(), hand: { fu: 8 } }],
    ["駒の数字が範囲外", { ...base(), values: { ...base().values, hi: 999 } }],
    ["gate が真偽値でない", { ...base(), gate: "yes" }],
    ["配列", []],
    ["null", null],
  ])("%s は 400 bad_rules", async (_name, rules) => {
    const res = await post(JSON.stringify({ rules }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_rules" } });
  });

  it("hostSeat が不正なら 400", async () => {
    const res = await post(JSON.stringify({ rules: base(), hostSeat: "middle" }));
    expect(res.status).toBe(400);
  });

  it("壊れた JSON は 400 bad_request", async () => {
    const res = await post("{ rules: ");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("巨大な本文は 413", async () => {
    const res = await post(JSON.stringify({ rules: base(), pad: "x".repeat(MAX_CREATE_BYTES) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "too_large" } });
  });

  it("余計なキーは捨てて保存する", async () => {
    const res = await post(JSON.stringify({ rules: { ...base(), extra: "x" } }));
    expect(res.status).toBe(201);
    const { roomId } = await res.json<{ roomId: string }>();
    const info: RoomInfoResponse = await (await call(`/rooms/${roomId}`)).json();
    expect(info.rules).toEqual(base());
    expect(info.rules).not.toHaveProperty("extra");
  });
});

describe("パス・メソッド", () => {
  it("存在しない部屋・形式の違う ID は 404", async () => {
    expect((await call("/rooms/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await call("/rooms/short")).status).toBe(404);
    expect((await call("/rooms/../../etc")).status).toBe(404);
  });

  it("知らないパス・メソッド", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/rooms")).status).toBe(405);
    expect((await call("/rooms/AAAAAAAAAAAAAAAAAAAAAA", { method: "DELETE" })).status).toBe(405);
    expect((await call("/health")).status).toBe(200);
  });

  it("/ws に WebSocket 以外で来たら 426", async () => {
    const { roomId } = await createRoom();
    const res = await call(`/rooms/${roomId}/ws`);
    expect(res.status).toBe(426);
  });
});

describe("CORS / Origin", () => {
  it("公開中の画面と localhost は許可し、CORS のヘッダーを返す", async () => {
    for (const origin of ["https://harukiti82.github.io", "http://localhost:5173", "http://127.0.0.1:4179"]) {
      const pre = await call("/rooms", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      const res = await post(JSON.stringify({ rules: presetById("v10").rules }), { Origin: origin });
      expect(res.status).toBe(201);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });

  it("ほかのオリジンは 403（WebSocket も）", async () => {
    const res = await post(JSON.stringify({ rules: presetById("v10").rules }), { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const { roomId } = await createRoom();
    const ws = await call(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket", Origin: "https://evil.example" } });
    expect(ws.status).toBe(403);
    expect(ws.webSocket).toBeNull();
  });

  it("許可リストの照合", () => {
    const list = "https://harukiti82.github.io,http://localhost:*";
    expect(originAllowed("https://harukiti82.github.io", list)).toBe(true);
    expect(originAllowed("http://localhost:5173", list)).toBe(true);
    expect(originAllowed("http://localhost", list)).toBe(false);
    expect(originAllowed("http://localhost:5173.evil.example", list)).toBe(false);
    expect(originAllowed("https://harukiti82.github.io.evil.example", list)).toBe(false);
    expect(originAllowed("http://harukiti82.github.io", list)).toBe(false);
  });
});
