// オンライン対戦の通信層（HTTP の部屋の作成・確認と、WebSocket の接続・参加・再接続・トークンの保存）。
// DOM に依存しない（WebSocket・fetch・タイマー・保存先は引数で差し替えられる。Vitest で偽物を渡してテストする）。
// 画面（ui/）はここが出すイベントで描き直し、手は send で送るだけ。手の正しさはサーバーが判定する。
// 仕様は .agent/online-protocol.md

import type { PieceKind } from "../engine/rules";
import {
  API_PATH,
  CLOSE,
  PING_TEXT,
  PONG_TEXT,
  ROOM_ID_PATTERN,
  TOKEN_PATTERN,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type ErrorMessage,
  type HttpErrorBody,
  type HttpErrorCode,
  type JoinedMessage,
  type MoveMessage,
  type RoomInfoResponse,
  type ServerMessage,
  type StateMessage,
  type WsErrorCode,
} from "./protocol";

/** 切断からつなぎ直すまでの待ち時間（回数ごと。最後の値をくり返す） */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
/** 接続の生存確認（ping）の間隔。サーバーは自動応答するので部屋の寿命も課金も増えない */
export const PING_INTERVAL_MS = 25_000;
/** ping を送ってから何も届かなければ切れたとみなす時間 */
export const PONG_TIMEOUT_MS = 10_000;
/** /api/health の待ち時間（GitHub Pages など /api がない公開先で入口を出さない判定） */
export const HEALTH_TIMEOUT_MS = 3000;

// ---- 保存（トークン・この端末で作った部屋） ----

/** 部屋ごとのトークンのキー（sessionStorage）。再読み込みでは残り、別のタブとは共有しない */
export const tokenKey = (roomId: string) => `kyosho:token:${roomId}`;
/** この端末で作った部屋 ID（localStorage。自分の招待リンクを開いたときの注意書き用。秘密ではない） */
export const CREATED_KEY = "kyosho:created";
const CREATED_MAX = 20;

/** Storage の必要な部分（sessionStorage・localStorage、テストでは Map の包み） */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** プライベートモードなどで Storage が使えなくても落ちないように包む */
export function safeStore(get: () => KeyValueStore | null | undefined): KeyValueStore {
  const run = <T>(f: (s: KeyValueStore) => T, fallback: T): T => {
    try {
      const s = get();
      return s ? f(s) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    getItem: (k) => run((s) => s.getItem(k), null),
    setItem: (k, v) => run((s) => s.setItem(k, v), undefined),
    removeItem: (k) => run((s) => s.removeItem(k), undefined),
  };
}

export function loadToken(store: KeyValueStore, roomId: string): string | null {
  const t = store.getItem(tokenKey(roomId));
  return t && TOKEN_PATTERN.test(t) ? t : null;
}

export function saveToken(store: KeyValueStore, roomId: string, token: string) {
  store.setItem(tokenKey(roomId), token);
}

export function dropToken(store: KeyValueStore, roomId: string) {
  store.removeItem(tokenKey(roomId));
}

function createdList(store: KeyValueStore): string[] {
  try {
    const v: unknown = JSON.parse(store.getItem(CREATED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ROOM_ID_PATTERN.test(x)) : [];
  } catch {
    return [];
  }
}

/** この端末で部屋を作ったことを覚える（新しい順に CREATED_MAX 件） */
export function rememberCreated(store: KeyValueStore, roomId: string) {
  const list = [roomId, ...createdList(store).filter((x) => x !== roomId)].slice(0, CREATED_MAX);
  store.setItem(CREATED_KEY, JSON.stringify(list));
}

export function createdHere(store: KeyValueStore, roomId: string): boolean {
  return createdList(store).includes(roomId);
}

// ---- URL ----

/** 招待 URL（例: https://kyosho.rukiharukichi.com/?room=<id>）。今のページの場所から作る */
export function inviteUrl(roomId: string, loc: Pick<Location, "origin" | "pathname">): string {
  return `${loc.origin}${loc.pathname}?room=${roomId}`;
}

/** URL のクエリの部屋 ID。room がなければ undefined、形式が違えば null */
export function roomIdFromSearch(search: string): string | null | undefined {
  const q = new URLSearchParams(search);
  if (!q.has("room")) return undefined;
  const id = q.get("room") ?? "";
  return ROOM_ID_PATTERN.test(id) ? id : null;
}

/** WebSocket の URL（画面と同じオリジンの /api の下） */
export function wsUrl(roomId: string, loc: Pick<Location, "protocol" | "host">): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${API_PATH}/rooms/${roomId}/ws`;
}

// ---- HTTP ----

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** HTTP のエラー。code は応答の本文（読めなければ network / bad_response） */
export class OnlineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: HttpErrorCode | "network" | "bad_response",
    message: string,
  ) {
    super(message);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function request<T>(fetchFn: FetchFn, path: string, init: RequestInit, ok: (body: unknown) => body is T): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${API_PATH}${path}`, init);
  } catch {
    throw new OnlineHttpError(0, "network", "サーバーに接続できません");
  }
  const body = await readJson(res);
  if (res.ok && ok(body)) return body;
  const err = (body as HttpErrorBody | undefined)?.error;
  if (!res.ok && err && typeof err.code === "string") throw new OnlineHttpError(res.status, err.code, String(err.message ?? ""));
  throw new OnlineHttpError(res.status, "bad_response", "サーバーの応答を読めません");
}

/**
 * オンライン対戦のサーバーに届くか。/api のない公開先（GitHub Pages・vite preview）では、
 * 404 や画面の HTML が返るので false（入口を出さない）
 */
export async function checkHealth(fetchFn: FetchFn = fetch, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetchFn(`${API_PATH}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!res.ok) return false;
    const body = (await readJson(res)) as { ok?: unknown } | undefined;
    return body?.ok === true;
  } catch {
    return false;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

export function createRoom(req: CreateRoomRequest, fetchFn: FetchFn = fetch): Promise<CreateRoomResponse> {
  return request(
    fetchFn,
    "/rooms",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) },
    (b): b is CreateRoomResponse =>
      isObj(b) && typeof b.roomId === "string" && ROOM_ID_PATTERN.test(b.roomId) && typeof b.token === "string" && (b.you === 0 || b.you === 1),
  );
}

export function getRoomInfo(roomId: string, fetchFn: FetchFn = fetch): Promise<RoomInfoResponse> {
  return request(
    fetchFn,
    `/rooms/${roomId}`,
    { cache: "no-store" },
    (b): b is RoomInfoResponse => isObj(b) && b.roomId === roomId && typeof b.open === "boolean" && isObj(b.rules),
  );
}

// ---- WebSocket ----

/** connecting: 最初の接続中 / open: 参加済み / reconnecting: 切れてつなぎ直し待ち・中 / closed: 終わった（つなぎ直さない） */
export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * つなぎ直さない終わり方。replaced: 同じ席が別のタブで開かれた / room_not_found・expired: 部屋がない・期限切れ /
 * room_full: 満員 / invalid_token: トークンが合わない（保存したトークンは消す） / rejected: その他の参加の失敗
 */
export type EndReason = "replaced" | "room_not_found" | "expired" | "room_full" | "invalid_token" | "rejected";

export interface SessionEvents {
  joined?(m: JoinedMessage): void;
  state?(m: StateMessage): void;
  /** 拒否された（接続は残る。illegal_move・not_your_turn など） */
  error?(m: ErrorMessage): void;
  /** 接続の状態が変わった。attempt は reconnecting のときのつなぎ直しの回数（1 始まり） */
  conn?(state: ConnState, attempt: number): void;
  /** つなぎ直さずに終わった */
  ended?(reason: EndReason, message: string): void;
}

/** WebSocket の必要な部分（ブラウザの WebSocket と、テストの偽物） */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SessionDeps {
  /** WebSocket を作る（既定はブラウザの WebSocket） */
  connect: (url: string) => SocketLike;
  /** トークンの保存先（既定は sessionStorage） */
  store: KeyValueStore;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const OPEN = 1;
const FATAL_CODES: readonly WsErrorCode[] = ["room_not_found", "room_full", "invalid_token", "not_joined"];

/**
 * 1 つの部屋への接続。参加（トークンがあれば復帰）・トークンの保存・切断からの自動のつなぎ直し・ping を受け持つ。
 * close() を呼ぶまで、つなぎ直さない終わり方（EndReason）以外ではつなぎ直し続ける
 */
export class OnlineSession {
  private ws: SocketLike | null = null;
  private state: ConnState = "connecting";
  /** 失敗が続いた回数（参加が通ったら 0） */
  private attempt = 0;
  private retryTimer: unknown;
  private pingTimer: unknown;
  private pongTimer: unknown;
  /** 閉じる前に届いた参加の失敗（close code 4003 の理由） */
  private fatal: ErrorMessage | null = null;
  /** 参加して受け取った自分の手番 */
  you: 0 | 1 | null = null;

  constructor(
    readonly roomId: string,
    private readonly url: string,
    private readonly events: SessionEvents,
    private readonly deps: SessionDeps,
  ) {}

  /** 接続を始める */
  start() {
    this.open();
  }

  get connState(): ConnState {
    return this.state;
  }

  /** 参加済みでつながっている */
  get ready(): boolean {
    return this.state === "open" && this.ws?.readyState === OPEN;
  }

  /**
   * 手を送る。つながっていなければ false。
   * seq は手を考えた局面の棋譜の長さ（制限時間切れの自動の手と入れ違ったら、サーバーが stale_move で拒否する）
   */
  sendMove(r: number, c: number, kind: PieceKind, king = false, seq?: number): boolean {
    if (!this.ready) return false;
    const msg: MoveMessage = king ? { type: "move", r, c, kind, king: true } : { type: "move", r, c, kind };
    if (seq !== undefined) msg.seq = seq;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  /** つなぎ直しの待ち時間を飛ばして今すぐつなぐ（画面に戻った・ネットにつながったとき） */
  wake() {
    if (this.state !== "reconnecting" || (this.ws && this.ws.readyState <= OPEN)) return;
    this.deps.clearTimeout(this.retryTimer);
    this.open();
  }

  /** 終わった接続（replaced など）をもう一度つなぐ（「このタブで続ける」） */
  resume() {
    if (this.state !== "closed") return;
    this.attempt = 0;
    this.setState("connecting");
    this.open();
  }

  /** 自分から抜ける（つなぎ直さない。部屋と席はサーバーに残る） */
  close() {
    this.stopTimers();
    this.state = "closed";
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      if (ws.readyState <= OPEN) ws.close(1000, "leave");
    }
  }

  private setState(s: ConnState) {
    if (this.state === s && s !== "reconnecting") return;
    this.state = s;
    this.events.conn?.(s, this.attempt);
  }

  private open() {
    this.fatal = null;
    let ws: SocketLike;
    try {
      ws = this.deps.connect(this.url);
    } catch {
      this.dropped();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const token = loadToken(this.deps.store, this.roomId);
      ws.send(JSON.stringify(token ? { type: "join", token } : { type: "join" }));
      this.schedulePing();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.onMessage(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(e.code);
    };
    // error のあとには必ず close が来るので、ここでは何もしない
    ws.onerror = () => {};
  }

  private onMessage(data: unknown) {
    if (typeof data !== "string") return;
    // 何か届いた = 生きている
    this.deps.clearTimeout(this.pongTimer);
    if (data === PONG_TEXT) return;
    let m: ServerMessage;
    try {
      m = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (m.type) {
      case "joined":
        if (m.roomId !== this.roomId) return;
        saveToken(this.deps.store, this.roomId, m.token);
        this.you = m.you;
        this.attempt = 0;
        this.setState("open");
        this.events.joined?.(m);
        return;
      case "state":
        if (m.roomId === this.roomId) this.events.state?.(m);
        return;
      case "error":
        if (FATAL_CODES.includes(m.code)) this.fatal = m;
        else this.events.error?.(m);
        return;
    }
  }

  private onClose(code: number) {
    this.stopTimers();
    const end = (reason: EndReason, message: string) => {
      this.state = "closed";
      this.events.conn?.("closed", this.attempt);
      this.events.ended?.(reason, message);
    };
    const fatal = this.fatal;
    if (code === CLOSE.replaced) return end("replaced", "別のタブ・端末でこの対局が開かれました");
    if (code === CLOSE.notFound) return end("room_not_found", fatal?.message ?? "部屋が見つかりません");
    if (code === CLOSE.expired) return end("expired", "部屋の期限が切れました");
    if (code === CLOSE.rejected || fatal) {
      const why = fatal?.code;
      if (why === "invalid_token") dropToken(this.deps.store, this.roomId);
      const reason: EndReason =
        why === "room_full" ? "room_full" : why === "invalid_token" ? "invalid_token" : why === "room_not_found" ? "room_not_found" : "rejected";
      return end(reason, fatal?.message ?? "参加できませんでした");
    }
    this.dropped();
  }

  /** 通信が切れた: 少し待ってつなぎ直す */
  private dropped() {
    this.stopTimers();
    if (this.state === "closed") return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.setState("reconnecting");
    this.retryTimer = this.deps.setTimeout(() => this.open(), delay);
  }

  private schedulePing() {
    this.deps.clearTimeout(this.pingTimer);
    this.pingTimer = this.deps.setTimeout(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) return;
      ws.send(PING_TEXT);
      // 応答がなければ、閉じたことにしてつなぎ直す（モバイル回線の切断は close が来ないことがある）
      this.pongTimer = this.deps.setTimeout(() => {
        if (this.ws !== ws) return;
        this.ws = null;
        detach(ws);
        try {
          ws.close(4000, "ping timeout");
        } catch {
          // 閉じられなくても捨てる
        }
        this.dropped();
      }, PONG_TIMEOUT_MS);
      this.schedulePing();
    }, PING_INTERVAL_MS);
  }

  private stopTimers() {
    this.deps.clearTimeout(this.retryTimer);
    this.deps.clearTimeout(this.pingTimer);
    this.deps.clearTimeout(this.pongTimer);
  }
}

function detach(ws: SocketLike) {
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
}

/** ブラウザで使う既定の依存（WebSocket・sessionStorage・window のタイマー） */
export function browserDeps(): SessionDeps {
  return {
    connect: (url) => new WebSocket(url) as unknown as SocketLike,
    store: safeStore(() => window.sessionStorage),
    setTimeout: (f, ms) => window.setTimeout(f, ms),
    clearTimeout: (id) => window.clearTimeout(id as number | undefined),
  };
}
