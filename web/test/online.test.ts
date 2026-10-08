// オンライン対戦の通信層（net/online.ts）のテスト: 参加・トークンの保存と復帰・つなぎ直し・終わり方・ping・HTTP

import { beforeEach, describe, expect, it } from "vitest";
import { createGame, viewFor } from "../src/engine/game";
import { defaultRules } from "../src/engine/rules";
import {
  checkHealth,
  createdHere,
  createRoom,
  getRoomInfo,
  inviteUrl,
  loadToken,
  OnlineHttpError,
  OnlineSession,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  RECONNECT_DELAYS_MS,
  rememberCreated,
  roomIdFromSearch,
  safeStore,
  saveToken,
  tokenKey,
  wsUrl,
  type ConnState,
  type EndReason,
  type KeyValueStore,
  type SessionDeps,
  type SocketLike,
} from "../src/net/online";
import { CLOSE, PING_TEXT, PONG_TEXT, type ServerMessage, type StateMessage } from "../src/net/protocol";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "t".repeat(43);
const TOKEN2 = "u".repeat(43);

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // サーバー側の動き
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(m: ServerMessage | string) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

/** 手で進める時計 */
class Clock {
  now = 0;
  private timers = new Map<number, { at: number; f: () => void }>();
  private seq = 0;
  setTimeout = (f: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, f });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].f();
    }
    this.now = end;
  }
}

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

function stateMsg(over: Partial<StateMessage> = {}): StateMessage {
  return {
    type: "state",
    roomId: ROOM,
    phase: "playing",
    gameNo: 1,
    you: 0,
    view: viewFor(createGame(defaultRules()), 0),
    opponent: { joined: true, online: true, left: false },
    rematch: null,
    clock: null,
    ...over,
  };
}

let clock: Clock;
let store: ReturnType<typeof memStore>;
let sockets: FakeSocket[];
let log: { conn: [ConnState, number][]; ended: [EndReason, string][]; states: StateMessage[]; errors: string[]; joined: number[] };

function session(initialToken?: string) {
  if (initialToken) saveToken(store, ROOM, initialToken);
  const deps: SessionDeps = {
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    store,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const s = new OnlineSession(ROOM, `ws://x/api/rooms/${ROOM}/ws`, {
    conn: (st, n) => log.conn.push([st, n]),
    ended: (r, m) => log.ended.push([r, m]),
    state: (m) => log.states.push(m),
    error: (m) => log.errors.push(m.code),
    joined: (m) => log.joined.push(m.you),
  }, deps);
  s.start();
  return s;
}
const last = () => sockets[sockets.length - 1];
const sentOf = (s: FakeSocket) => s.sent.map((x) => (x === PING_TEXT ? "ping" : JSON.parse(x)));

beforeEach(() => {
  clock = new Clock();
  store = memStore();
  sockets = [];
  log = { conn: [], ended: [], states: [], errors: [], joined: [] };
});

describe("参加とトークン", () => {
  it("トークンがなければ token なしで join し、joined のトークンを部屋ごとに保存する", () => {
    session();
    last().serverOpen();
    expect(sentOf(last())).toEqual([{ type: "join" }]);
    last().serverSend({ type: "joined", roomId: ROOM, you: 1, token: TOKEN });
    expect(store.map.get(tokenKey(ROOM))).toBe(TOKEN);
    expect(log.joined).toEqual([1]);
    expect(log.conn).toEqual([["open", 0]]);
  });

  it("保存したトークンがあれば token 付きで join する（再読み込みからの復帰）", () => {
    session(TOKEN);
    last().serverOpen();
    expect(sentOf(last())).toEqual([{ type: "join", token: TOKEN }]);
  });

  it("state は届いた順に渡し、別の部屋の state は捨てる", () => {
    session();
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    last().serverSend(stateMsg({ phase: "waiting" }));
    last().serverSend(stateMsg({ roomId: "B".repeat(22) }));
    last().serverSend("壊れた JSON");
    last().serverSend(PONG_TEXT);
    expect(log.states.map((m) => m.phase)).toEqual(["waiting"]);
  });

  it("手は参加してつながっているときだけ送る（王の指定は king: true のときだけ載せる）", () => {
    const s = session();
    expect(s.sendMove(2, 3, "fu")).toBe(false);
    last().serverOpen();
    expect(s.sendMove(2, 3, "fu")).toBe(false); // joined の前
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    expect(s.sendMove(2, 3, "fu")).toBe(true);
    expect(s.sendMove(2, 4, "kin", true)).toBe(true);
    // 考えた局面の棋譜の長さ（seq）は渡したときだけ載せる
    expect(s.sendMove(5, 4, "fu", false, 7)).toBe(true);
    expect(sentOf(last()).slice(1)).toEqual([
      { type: "move", r: 2, c: 3, kind: "fu" },
      { type: "move", r: 2, c: 4, kind: "kin", king: true },
      { type: "move", r: 5, c: 4, kind: "fu", seq: 7 },
    ]);
  });

  it("再戦の申し込み・取り消し・断りは参加してつながっているときだけ、終わった対局の番号を付けて送る", () => {
    const s = session();
    expect(s.sendRematch("request", 1)).toBe(false);
    last().serverOpen();
    expect(s.sendRematch("request", 1)).toBe(false); // joined の前
    last().serverSend({ type: "joined", roomId: ROOM, you: 1, token: TOKEN });
    expect(s.sendRematch("request", 1)).toBe(true);
    expect(s.sendRematch("cancel", 1)).toBe(true);
    expect(s.sendRematch("decline", 2)).toBe(true);
    expect(sentOf(last()).slice(1)).toEqual([
      { type: "rematch", action: "request", gameNo: 1 },
      { type: "rematch", action: "cancel", gameNo: 1 },
      { type: "rematch", action: "decline", gameNo: 2 },
    ]);
  });

  it("再戦で先手と後手が入れ替わった state（you が変わる）もそのまま渡す", () => {
    session();
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    last().serverSend(stateMsg({ phase: "finished", rematch: { you: "requested", opponent: "none" } }));
    last().serverSend(stateMsg({ gameNo: 2, you: 1, view: viewFor(createGame(defaultRules()), 1) }));
    expect(log.states.map((m) => [m.gameNo, m.you, m.rematch?.you ?? null])).toEqual([
      [1, 0, "requested"],
      [2, 1, null],
    ]);
  });

  it("拒否された手（illegal_move など）は error で渡し、接続は残す", () => {
    const s = session();
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    last().serverSend({ type: "error", code: "not_your_turn", message: "相手の手番です" });
    expect(log.errors).toEqual(["not_your_turn"]);
    expect(s.ready).toBe(true);
  });
});

describe("つなぎ直し", () => {
  it("通信が切れたら 1 秒・2 秒・4 秒…（最大 30 秒）待ってトークン付きでつなぎ直す", () => {
    session();
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 1, token: TOKEN });
    last().serverClose(1006);
    expect(log.conn.at(-1)).toEqual(["reconnecting", 1]);
    expect(sockets).toHaveLength(1);
    clock.advance(RECONNECT_DELAYS_MS[0] - 1);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    // つながらないまま失敗が続くと待ち時間が延びる
    let total = 0;
    for (let i = 1; i < 8; i++) {
      last().serverClose(1006);
      const wait = RECONNECT_DELAYS_MS[Math.min(i, RECONNECT_DELAYS_MS.length - 1)];
      total += wait;
      clock.advance(wait);
      expect(sockets).toHaveLength(2 + i);
    }
    expect(RECONNECT_DELAYS_MS.at(-1)).toBe(30_000);
    expect(total).toBe(2000 + 4000 + 8000 + 16000 + 30000 * 3);
    // 復帰: 保存したトークンで join し、参加が通ったら待ち時間を戻す
    last().serverOpen();
    expect(sentOf(last())).toEqual([{ type: "join", token: TOKEN }]);
    last().serverSend({ type: "joined", roomId: ROOM, you: 1, token: TOKEN });
    expect(log.conn.at(-1)).toEqual(["open", 0]);
    last().serverClose(1011);
    clock.advance(RECONNECT_DELAYS_MS[0]);
    expect(log.conn.at(-1)).toEqual(["reconnecting", 1]);
  });

  it("wake() は待ち時間を飛ばしてすぐつなぎ直す", () => {
    const s = session();
    last().serverOpen();
    last().serverClose(1006);
    s.wake();
    expect(sockets).toHaveLength(2);
    // つなぎ直し中（接続待ち）にもう一度呼んでも増えない
    s.wake();
    expect(sockets).toHaveLength(2);
  });

  it("ping に応答がなければ切れたとみなしてつなぎ直す。何か届けば生きている", () => {
    session();
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    clock.advance(PING_INTERVAL_MS);
    expect(last().sent.at(-1)).toBe(PING_TEXT);
    last().serverSend(PONG_TEXT);
    clock.advance(PONG_TIMEOUT_MS);
    expect(sockets).toHaveLength(1);
    // 次の ping に応答しない
    clock.advance(PING_INTERVAL_MS - PONG_TIMEOUT_MS);
    clock.advance(PONG_TIMEOUT_MS);
    expect(sockets[0].closedWith).toBe(4000);
    expect(log.conn.at(-1)).toEqual(["reconnecting", 1]);
    clock.advance(RECONNECT_DELAYS_MS[0]);
    expect(sockets).toHaveLength(2);
  });

  it("close() の後はつなぎ直さない。参加済みなら閉じる前に leave を送る", () => {
    const s = session();
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    s.close();
    expect(sentOf(sockets[0]).at(-1)).toEqual({ type: "leave" });
    expect(sockets[0].closedWith).toBe(1000);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(log.ended).toEqual([]);
  });
});

describe("つなぎ直さない終わり方", () => {
  it("4001: 別のタブで同じ席が開かれた → replaced。resume() でこのタブに戻せる", () => {
    const s = session(TOKEN);
    last().serverOpen();
    last().serverSend({ type: "joined", roomId: ROOM, you: 0, token: TOKEN });
    last().serverClose(CLOSE.replaced);
    expect(log.ended.map((e) => e[0])).toEqual(["replaced"]);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    s.resume();
    expect(sockets).toHaveLength(2);
    last().serverOpen();
    expect(sentOf(last())).toEqual([{ type: "join", token: TOKEN }]);
  });

  it("満員（room_full → 4003）", () => {
    session();
    last().serverOpen();
    last().serverSend({ type: "error", code: "room_full", message: "満員です" });
    last().serverClose(CLOSE.rejected);
    expect(log.ended).toEqual([["room_full", "満員です"]]);
    expect(log.errors).toEqual([]);
  });

  it("トークンが合わない（invalid_token → 4003）: 保存したトークンを消す", () => {
    session(TOKEN);
    last().serverOpen();
    last().serverSend({ type: "error", code: "invalid_token", message: "x" });
    last().serverClose(CLOSE.rejected);
    expect(log.ended[0][0]).toBe("invalid_token");
    expect(loadToken(store, ROOM)).toBeNull();
  });

  it("部屋がない（4004）・期限切れ（4010）", () => {
    session();
    last().serverOpen();
    last().serverSend({ type: "error", code: "room_not_found", message: "部屋がありません" });
    last().serverClose(CLOSE.notFound);
    session();
    last().serverOpen();
    last().serverClose(CLOSE.expired);
    expect(log.ended.map((e) => e[0])).toEqual(["room_not_found", "expired"]);
  });
});

describe("保存先・URL", () => {
  it("トークンは形式が合うものだけ読む。部屋ごとに別のキー", () => {
    saveToken(store, ROOM, TOKEN);
    saveToken(store, "B".repeat(22), TOKEN2);
    expect(loadToken(store, ROOM)).toBe(TOKEN);
    expect(loadToken(store, "B".repeat(22))).toBe(TOKEN2);
    store.setItem(tokenKey(ROOM), "<script>");
    expect(loadToken(store, ROOM)).toBeNull();
  });

  it("Storage が使えなくても落ちない", () => {
    const broken = safeStore(() => {
      throw new Error("SecurityError");
    });
    expect(broken.getItem("x")).toBeNull();
    expect(() => broken.setItem("x", "y")).not.toThrow();
    expect(loadToken(broken, ROOM)).toBeNull();
  });

  it("この端末で作った部屋を覚える（壊れた値は無視、最大 20 件）", () => {
    expect(createdHere(store, ROOM)).toBe(false);
    rememberCreated(store, ROOM);
    expect(createdHere(store, ROOM)).toBe(true);
    for (let i = 0; i < 25; i++) rememberCreated(store, `${String(i).padStart(2, "0")}${"C".repeat(20)}`);
    expect(createdHere(store, ROOM)).toBe(false);
    store.setItem("kyosho:created", "{壊れた");
    expect(createdHere(store, ROOM)).toBe(false);
  });

  it("招待 URL・部屋 ID の読み取り・WebSocket の URL", () => {
    expect(inviteUrl(ROOM, { origin: "https://kyosho.rukiharukichi.com", pathname: "/" })).toBe(`https://kyosho.rukiharukichi.com/?room=${ROOM}`);
    expect(roomIdFromSearch(`?room=${ROOM}`)).toBe(ROOM);
    expect(roomIdFromSearch("?take=flip")).toBeUndefined();
    expect(roomIdFromSearch("?room=abc")).toBeNull();
    expect(roomIdFromSearch("?room=../../x")).toBeNull();
    expect(wsUrl(ROOM, { protocol: "https:", host: "kyosho.rukiharukichi.com" })).toBe(`wss://kyosho.rukiharukichi.com/api/rooms/${ROOM}/ws`);
    expect(wsUrl(ROOM, { protocol: "http:", host: "localhost:8787" })).toBe(`ws://localhost:8787/api/rooms/${ROOM}/ws`);
  });
});

describe("HTTP", () => {
  const res = (status: number, body: unknown) =>
    Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

  it("health: {ok:true} のときだけ true（/api のない公開先の 404・画面の HTML・通信失敗は false）", async () => {
    expect(await checkHealth(() => res(200, { ok: true }))).toBe(true);
    expect(await checkHealth(() => res(404, "Not Found"))).toBe(false);
    expect(await checkHealth(() => res(200, "<!doctype html><html></html>"))).toBe(false);
    expect(await checkHealth(() => Promise.reject(new TypeError("Failed to fetch")))).toBe(false);
  });

  it("部屋の作成: 本文を JSON で送り、応答を確かめる。エラーは code で分かる", async () => {
    let sent: { url: string; init?: RequestInit } | null = null;
    const ok = await createRoom({ preset: "king", hostSeat: "first" }, (url, init) => {
      sent = { url, init };
      return res(201, { roomId: ROOM, token: TOKEN, you: 0 });
    });
    expect(ok).toEqual({ roomId: ROOM, token: TOKEN, you: 0 });
    expect(sent!.url).toBe("/api/rooms");
    expect(sent!.init?.method).toBe("POST");
    expect(JSON.parse(String(sent!.init?.body))).toEqual({ preset: "king", hostSeat: "first" });
    await expect(createRoom({ preset: "king" }, () => res(400, { error: { code: "bad_rules", message: "不正" } }))).rejects.toMatchObject({
      status: 400,
      code: "bad_rules",
    });
    await expect(createRoom({ preset: "king" }, () => Promise.reject(new TypeError("x")))).rejects.toBeInstanceOf(OnlineHttpError);
    await expect(createRoom({ preset: "king" }, () => res(200, "<html>"))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("部屋の確認: 404 は not_found", async () => {
    const info = { roomId: ROOM, phase: "waiting", rules: defaultRules(), open: true };
    expect(await getRoomInfo(ROOM, () => res(200, info))).toEqual(info);
    await expect(getRoomInfo(ROOM, () => res(404, { error: { code: "not_found", message: "なし" } }))).rejects.toMatchObject({ code: "not_found" });
  });
});
