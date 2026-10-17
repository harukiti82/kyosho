// エンドレスマッチの通信層（net/endless.ts）のテスト: 端末の保存の検証・発行・ランキング・接続（join の中身・状態・つなぎ直し・
// トークン違いで端末を捨てる・抜けるときに leave を送らない）

import { describe, expect, it } from "vitest";
import { createGame, viewFor } from "../src/engine/game";
import { endlessRules } from "../src/engine/endless";
import { DEVICE_KEY, dropDevice, EndlessSession, endlessWsUrl, getRanking, loadDevice, registerDevice, saveDevice } from "../src/net/endless";
import { OnlineHttpError, type KeyValueStore, type SessionDeps, type SocketLike } from "../src/net/online";
import { CLOSE, type EndlessStateMessage } from "../src/net/protocol";

const DEV = { device: "D".repeat(22), token: "t".repeat(43) };

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

const state = (over: Partial<EndlessStateMessage> = {}): EndlessStateMessage => ({ type: "endless", run: null, best: 0, name: null, ...over });

function setup(name = "") {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const store = memStore();
  const deps: SessionDeps = {
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    store,
    setTimeout: (f) => timers.push(f),
    clearTimeout: () => {},
  };
  const got: EndlessStateMessage[] = [];
  const ended: string[] = [];
  let forgot = 0;
  const s = new EndlessSession(DEV, "ws://x/api/endless/devices/D/ws", { endless: (m) => got.push(m), ended: (r) => ended.push(r) }, deps, name, () => forgot++);
  return { s, sockets, timers, got, ended, forgot: () => forgot };
}

describe("端末の保存", () => {
  it("形の合う保存だけを読む（版・ID・トークンの形）。余計な項目は無視する", () => {
    const st = memStore();
    expect(loadDevice(st)).toBeNull();
    saveDevice(st, DEV);
    expect(JSON.parse(st.map.get(DEVICE_KEY)!)).toEqual({ v: 1, ...DEV });
    expect(loadDevice(st)).toEqual(DEV);
    st.setItem(DEVICE_KEY, JSON.stringify({ v: 1, ...DEV, wins: 99, best: 99 }));
    expect(loadDevice(st)).toEqual(DEV);
    for (const bad of ["{", "null", "[]", JSON.stringify({ v: 2, ...DEV }), JSON.stringify({ v: 1, device: "x", token: DEV.token }), JSON.stringify({ v: 1, device: DEV.device, token: "<x>" })]) {
      st.setItem(DEVICE_KEY, bad);
      expect(loadDevice(st), bad).toBeNull();
    }
    dropDevice(st);
    expect(st.map.has(DEVICE_KEY)).toBe(false);
  });
});

describe("HTTP", () => {
  it("発行: 201 の形を確かめる。429 は too_many_requests", async () => {
    const ok = (body: unknown, status = 201) => async () => new Response(JSON.stringify(body), { status });
    expect(await registerDevice(ok(DEV))).toEqual(DEV);
    await expect(registerDevice(ok({ device: "x", token: DEV.token }))).rejects.toBeInstanceOf(OnlineHttpError);
    await expect(registerDevice(ok({ error: { code: "too_many_requests", message: "" } }, 429))).rejects.toMatchObject({ code: "too_many_requests" });
  });

  it("ランキング: device を付けて引く", async () => {
    let url = "";
    const res = { top: [{ rank: 1, name: null, best: 3 }], me: null, total: 1 };
    expect(await getRanking(DEV.device, async (u) => ((url = u), new Response(JSON.stringify(res))))).toEqual(res);
    expect(url).toBe(`/api/endless/ranking?device=${DEV.device}`);
    await getRanking(null, async (u) => ((url = u), new Response(JSON.stringify(res))));
    expect(url).toBe("/api/endless/ranking");
  });

  it("WebSocket の URL は同じオリジンの /api/endless の下", () => {
    expect(endlessWsUrl(DEV.device, { protocol: "https:", host: "kyosho.example" })).toBe(`wss://kyosho.example/api/endless/devices/${DEV.device}/ws`);
    expect(endlessWsUrl(DEV.device, { protocol: "http:", host: "localhost:8787" })).toBe(`ws://localhost:8787/api/endless/devices/${DEV.device}/ws`);
  });
});

describe("EndlessSession", () => {
  it("つながると端末のトークンと名前で join し、最初の状態で参加済みになる", () => {
    const t = setup("はる");
    t.s.start();
    t.sockets[0].open();
    expect(JSON.parse(t.sockets[0].sent[0])).toEqual({ type: "join", token: DEV.token, name: "はる" });
    expect(t.s.ready).toBe(false);
    t.sockets[0].push(state({ best: 2 }));
    expect(t.s.ready).toBe(true);
    expect(t.got).toEqual([state({ best: 2 })]);
    // 対局の部屋のメッセージ（state / joined）は受けない
    t.sockets[0].push({ type: "state", roomId: "x" });
    expect(t.got).toHaveLength(1);
  });

  it("start / next / move を送る。つながっていなければ false", () => {
    const t = setup();
    t.s.start();
    expect(t.s.sendStart()).toBe(false);
    t.sockets[0].open();
    t.sockets[0].push(state());
    expect(t.s.sendStart({ hp: [1, 1] })).toBe(true);
    expect(t.s.sendNext(3)).toBe(true);
    const run = { phase: "playing" as const, wins: 0, game: 1, you: 0 as const, stage: { no: 1, base: "easy" as const, next: "easy" as const, mix: 0, hp: 0 }, view: viewFor(createGame(endlessRules(1)), 0), clock: null, thinking: false };
    t.sockets[0].push(state({ run }));
    expect(t.s.sendMove(2, 3, "fu", false, 0)).toBe(true);
    expect(t.sockets[0].sent.slice(1).map((x) => JSON.parse(x))).toEqual([
      { type: "start", test: { hp: [1, 1] } },
      { type: "next", game: 3 },
      { type: "move", r: 2, c: 3, kind: "fu", seq: 0 },
    ]);
  });

  it("切れたらつなぎ直して join し直す。close では leave を送らない", () => {
    const t = setup();
    t.s.start();
    t.sockets[0].open();
    t.sockets[0].push(state());
    t.sockets[0].drop(1006);
    expect(t.s.connState).toBe("reconnecting");
    // 最後に張ったタイマーがつなぎ直し（前のは ping）
    t.timers.pop()!();
    t.sockets[1].open();
    expect(JSON.parse(t.sockets[1].sent[0]).type).toBe("join");
    t.sockets[1].push(state());
    expect(t.s.connState).toBe("open");
    t.s.close();
    expect(t.sockets[1].sent.map((x) => JSON.parse(x).type)).toEqual(["join"]);
  });

  it("invalid_token で閉じられたら、保存した端末を捨ててつなぎ直さない", () => {
    const t = setup();
    t.s.start();
    t.sockets[0].open();
    t.sockets[0].push({ type: "error", code: "invalid_token", message: "x" });
    t.sockets[0].drop(CLOSE.rejected);
    expect(t.forgot()).toBe(1);
    expect(t.ended).toEqual(["invalid_token"]);
    expect(t.s.connState).toBe("closed");
  });
});
