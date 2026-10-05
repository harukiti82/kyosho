// テスト用: Worker への HTTP と、WebSocket のクライアント（受け取ったメッセージを順に読む）

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { presetById, type PresetId, type RuleSet } from "../../web/src/engine/rules";
import type {
  CreateRoomResponse,
  ErrorMessage,
  HostSeat,
  JoinedMessage,
  ServerMessage,
  StateMessage,
} from "../../web/src/net/protocol";
import type { Room } from "../src/room";

const worker = (exports as unknown as { default: Fetcher }).default;
/** テストの Worker のオリジン（同一オリジンの Origin はこれ） */
export const BASE = "https://kyosho.test";

/** サイトのパス（/ や /api/...）に Worker を直接呼ぶ。静的アセットの振り分け（run_worker_first）は通らない */
export const site = (path: string, init?: RequestInit) => worker.fetch(`${BASE}${path}`, init);
/** API のパス（/rooms など）。/api を前に付ける */
export const call = (path: string, init?: RequestInit) => site(`/api${path}`, init);

export async function createRoom(rules: RuleSet | PresetId = "v10", hostSeat?: HostSeat): Promise<CreateRoomResponse> {
  const body = { rules: typeof rules === "string" ? presetById(rules).rules : rules, hostSeat };
  const res = await call("/rooms", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  if (res.status !== 201) throw new Error(`部屋を作れない: ${res.status} ${await res.text()}`);
  return res.json();
}

export const stubOf = (roomId: string) => (env.ROOMS as DurableObjectNamespace<Room>).get(env.ROOMS.idFromName(roomId));

const TIMEOUT_MS = 3000;

export class Client {
  /** 受け取った生のテキスト（隠し情報の検査用） */
  readonly raw: string[] = [];
  readonly msgs: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private cursor = 0;
  private wake: (() => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const text = typeof e.data === "string" ? e.data : "";
      this.raw.push(text);
      this.msgs.push(JSON.parse(text) as ServerMessage);
      this.wake?.();
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake?.();
    });
  }

  static async connect(roomId: string, headers: Record<string, string> = {}): Promise<Client> {
    const res = await call(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket", ...headers } });
    if (!res.webSocket) throw new Error(`WebSocket にならない: ${res.status} ${await res.text()}`);
    res.webSocket.accept();
    return new Client(res.webSocket);
  }

  /** 接続して join し、joined と最初の state を読む */
  static async join(roomId: string, token?: string): Promise<{ client: Client; joined: JoinedMessage; state: StateMessage }> {
    const client = await Client.connect(roomId);
    client.send(token === undefined ? { type: "join" } : { type: "join", token });
    const joined = await client.expect("joined");
    const state = await client.expect("state");
    return { client, joined, state };
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  /** まだ読んでいない次のメッセージ */
  async next(): Promise<ServerMessage> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (this.cursor >= this.msgs.length) {
      if (this.closed) throw new Error(`接続が閉じた: ${this.closed.code} ${this.closed.reason}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("メッセージが来ない");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
    return this.msgs[this.cursor++];
  }

  async expect<T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    const m = await this.next();
    if (m.type !== type) throw new Error(`${type} のはずが ${JSON.stringify(m).slice(0, 300)}`);
    return m as Extract<ServerMessage, { type: T }>;
  }

  async expectError(code: ErrorMessage["code"]): Promise<ErrorMessage> {
    const m = await this.expect("error");
    if (m.code !== code) throw new Error(`${code} のはずが ${m.code}: ${m.message}`);
    return m;
  }

  /** 接続が閉じるのを待つ */
  async closedWith(): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("接続が閉じない");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closed;
  }

  /** 未読のメッセージがないこと（少し待って確かめる） */
  async quiet(ms = 100): Promise<boolean> {
    await new Promise((r) => setTimeout(r, ms));
    return this.cursor >= this.msgs.length;
  }

  close(): void {
    try {
      this.ws.close(1000, "bye");
    } catch {
      // 閉じている
    }
  }
}

/** 部屋を作り、作成者（先手）と参加者（後手）が join した状態にする */
export async function startedRoom(rules: RuleSet | PresetId = "v10") {
  const created = await createRoom(rules, "first");
  const host = await Client.join(created.roomId, created.token);
  const guest = await Client.join(created.roomId);
  // 参加者の join で、作成者にも state（相手が参加）が届く
  const hostState = await host.client.expect("state");
  return { roomId: created.roomId, host: host.client, guest: guest.client, hostToken: created.token, guestToken: guest.joined.token, hostState, guestState: guest.state };
}
