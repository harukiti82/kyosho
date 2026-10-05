// HTTP: 部屋の作成・情報・ルールの検証・/api の振り分け・Origin・不正な入力

import { describe, expect, it } from "vitest";
import { cloneRules, presetById, type RuleSet } from "../../web/src/engine/rules";
import { MAX_CREATE_BYTES, ROOM_ID_PATTERN, TOKEN_PATTERN, type RoomInfoResponse } from "../../web/src/net/protocol";
import { apiParts, originAllowed } from "../src/index";
import { BASE, call, Client, createRoom, site } from "./helpers";

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

  it("preset の ID でも作れる。知らない ID・rules との両方指定・どちらもなしは 400", async () => {
    const res = await post(JSON.stringify({ preset: "anchor" }));
    expect(res.status).toBe(201);
    const { roomId } = await res.json<{ roomId: string }>();
    const info: RoomInfoResponse = await (await call(`/rooms/${roomId}`)).json();
    expect(info.rules).toEqual(presetById("anchor").rules);
    for (const body of [{ preset: "nope" }, { preset: "__proto__" }, { preset: "v10", rules: base() }, {}]) {
      expect((await post(JSON.stringify(body))).status).toBe(400);
    }
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
    // URL の正規化で /api の外（/etc）になる
    expect((await call("/rooms/../../etc")).status).toBe(404);
  });

  it("知らないパス・メソッド", async () => {
    for (const path of ["/nope", "", "/", "/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws/x"]) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({ error: { code: "not_found" } });
    }
    expect((await call("/rooms")).status).toBe(405);
    expect((await call("/rooms/AAAAAAAAAAAAAAAAAAAAAA", { method: "DELETE" })).status).toBe(405);
    expect((await call("/health")).status).toBe(200);
  });

  it("末尾のスラッシュはあってもなくても同じ", async () => {
    expect(await (await call("/health/")).json()).toEqual({ ok: true });
    expect((await call("/rooms/")).status).toBe(405);
    const res = await call("/rooms/", { method: "POST", body: JSON.stringify({ preset: "v10" }), headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(201);
    const { roomId } = await res.json<{ roomId: string }>();
    expect((await call(`/rooms/${roomId}/`)).status).toBe(200);
  });

  it("/api の外（旧パス・画面の存在しないファイル）は Worker が 404 のテキストを返す", async () => {
    for (const path of ["/rooms", "/health", "/apix", "/api.js", "/assets/nope.js", "/nope.html"]) {
      const res = await site(path, { method: path === "/rooms" ? "POST" : "GET" });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Content-Type"), path).toContain("text/plain");
    }
  });

  it("/api の下の切り出し", () => {
    expect(apiParts("/api")).toEqual([]);
    expect(apiParts("/api/")).toEqual([]);
    expect(apiParts("/api/rooms/x/ws")).toEqual(["rooms", "x", "ws"]);
    expect(apiParts("/api//rooms/")).toEqual(["rooms"]);
    expect(apiParts("/apix")).toBeNull();
    expect(apiParts("/")).toBeNull();
    expect(apiParts("/index.html")).toBeNull();
  });

  it("/ws に WebSocket 以外で来たら 426", async () => {
    const { roomId } = await createRoom();
    const res = await call(`/rooms/${roomId}/ws`);
    expect(res.status).toBe(426);
  });
});

describe("Origin（同一オリジンだけ）", () => {
  it("画面と同じオリジンからの作成と WebSocket は通り、CORS のヘッダーは返さない", async () => {
    const res = await post(JSON.stringify({ rules: presetById("v10").rules }), { Origin: BASE });
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const { roomId } = await res.json<{ roomId: string }>();
    const client = await Client.connect(roomId, { Origin: BASE });
    client.send({ type: "join" });
    expect((await client.expect("joined")).roomId).toBe(roomId);
    client.close();
  });

  it("公開ドメイン（ALLOWED_ORIGINS）からも作成と WebSocket が通る", async () => {
    const origin = "https://kyosho.rukiharukichi.com";
    const res = await post(JSON.stringify({ preset: "v10" }), { Origin: origin });
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const { roomId } = await res.json<{ roomId: string }>();
    const client = await Client.connect(roomId, { Origin: origin });
    client.send({ type: "join" });
    expect((await client.expect("joined")).roomId).toBe(roomId);
    client.close();
  });

  it("別オリジン（旧 GitHub Pages・本番設定の localhost・ほか）は 403（WebSocket も）", async () => {
    const { roomId } = await createRoom();
    for (const origin of [
      "https://evil.example",
      "https://harukiti82.github.io",
      "http://localhost:5173",
      "https://kyosho.test.evil.example",
      "http://kyosho.test",
      // ルートのドメイン・http・似せたホストは公開ドメインではない
      "https://rukiharukichi.com",
      "http://kyosho.rukiharukichi.com",
      "https://kyosho.rukiharukichi.com.evil.example",
    ]) {
      const res = await post(JSON.stringify({ rules: presetById("v10").rules }), { Origin: origin });
      expect(res.status, origin).toBe(403);
      expect(await res.json(), origin).toMatchObject({ error: { code: "forbidden_origin" } });
      expect(res.headers.get("Access-Control-Allow-Origin"), origin).toBeNull();
      const ws = await call(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket", Origin: origin } });
      expect(ws.status, origin).toBe(403);
      expect(ws.webSocket, origin).toBeNull();
    }
  });

  it("プリフライト（OPTIONS）は受けない（同一オリジンでは来ない）", async () => {
    const pre = await call("/rooms", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await call("/rooms", { method: "OPTIONS" })).status).toBe(405);
  });

  it("許可リストの照合（ALLOWED_ORIGINS。本番は公開ドメインだけ、ローカル開発は npm run dev が localhost を足す）", () => {
    const list = "https://harukiti82.github.io,http://localhost:*";
    expect(originAllowed("https://harukiti82.github.io", list)).toBe(true);
    expect(originAllowed("http://localhost:5173", list)).toBe(true);
    expect(originAllowed("http://localhost", list)).toBe(false);
    expect(originAllowed("http://localhost:5173.evil.example", list)).toBe(false);
    expect(originAllowed("https://harukiti82.github.io.evil.example", list)).toBe(false);
    expect(originAllowed("http://harukiti82.github.io", list)).toBe(false);
    // 空のリストは何も許可しない
    expect(originAllowed("", "")).toBe(false);
    expect(originAllowed("http://localhost:5173", "")).toBe(false);
  });
});
