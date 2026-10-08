// テスト用: Worker への HTTP と、WebSocket のクライアント（受け取ったメッセージを順に読む）

import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { isLegal, type GameState, type PlayerView } from "../../web/src/engine/game";
import { KIND_ORDER, presetById, type PieceKind, type PresetId, type RuleSet } from "../../web/src/engine/rules";
import type {
  CreateRoomResponse,
  ErrorMessage,
  HostSeat,
  JoinedMessage,
  MoveMessage,
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

export async function createRoom(rules: RuleSet | PresetId = "v10", hostSeat?: HostSeat, turnSeconds?: number): Promise<CreateRoomResponse> {
  const body = { rules: typeof rules === "string" ? presetById(rules).rules : rules, hostSeat, turnSeconds };
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

/** 部屋を作り、作成者（先手）と参加者（後手）が join した状態にする。turnSeconds は 1 手の制限時間（省略は制限なし） */
export async function startedRoom(rules: RuleSet | PresetId = "v10", turnSeconds?: number) {
  const created = await createRoom(rules, "first", turnSeconds);
  const host = await Client.join(created.roomId, created.token);
  const guest = await Client.join(created.roomId);
  // 参加者の join で、作成者にも state（相手が参加）が届く
  const hostState = await host.client.expect("state");
  return { roomId: created.roomId, host: host.client, guest: guest.client, hostToken: created.token, guestToken: guest.joined.token, hostState, guestState: guest.state };
}

/** 盤の左上から走査して手番の人の最初に打てる手（自分の王に左右されない決まった手） */
export function firstLegal(view: PlayerView): { r: number; c: number; kind: PieceKind } {
  // isLegal は kings を読まない（手番・盤・持ち駒・ルールだけ）
  const g = view as unknown as GameState;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) for (const kind of KIND_ORDER) if (isLegal(g, r, c, kind)) return { r, c, kind };
  throw new Error("打てる手がない");
}

/** 裏返すルールで毎手 1 枚以上返すので、体力 5（下限）・回復なしなら数手で決着する */
export const quickRules = (): RuleSet => ({ ...presetById("orig").rules, heal: "none", hp: [5, 5] });

/**
 * 両者が firstLegal で終局まで打つ。clients は [先手, 後手] の順。
 * pick を渡すと手番の人の手と王の指定を選べる（own は打つ人の何手目か、1 始まり）
 */
export async function playOut(
  clients: [Client, Client],
  first: [StateMessage, StateMessage],
  pick?: (s: StateMessage, own: number) => Omit<MoveMessage, "type">,
): Promise<[StateMessage, StateMessage]> {
  let last = first;
  const own = [0, 0];
  for (let i = 0; last[0].phase === "playing"; i++) {
    if (i > 200) throw new Error("終わらない");
    const p = last[0].view.turn;
    own[p]++;
    clients[p].send({ type: "move", ...(pick ? pick(last[p], own[p]) : firstLegal(last[p].view)) } satisfies MoveMessage);
    last = await Promise.all([clients[0].expect("state"), clients[1].expect("state")]);
  }
  return last;
}

/** 部屋を作って 2 人が参加し、quickRules（rules を渡せばそれ）で終局まで打った状態にする。host は先手 */
export async function finishedRoom(rules: RuleSet = quickRules(), turnSeconds?: number) {
  const room = await startedRoom(rules, turnSeconds);
  const [hostEnd, guestEnd] = await playOut([room.host, room.guest], [room.hostState, room.guestState]);
  return { ...room, hostEnd, guestEnd };
}
