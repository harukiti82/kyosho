// エンドレスマッチの通信層（端末の発行・ランキングの HTTP と、WebSocket の接続・つなぎ直し）。DOM に依存しない。
// 端末 ID とトークンは localStorage の kyosho:endless に置く（同じ端末なら別の日に続きから遊べる）。連勝数はサーバーだけが数え、
// ここには持たない（書き換えてもランキングは変わらない）。接続・つなぎ直し・ping はオンライン対戦の OnlineSession を継承する。
// 仕様は .agent/online-protocol.md「エンドレスマッチ」

import { OnlineSession, request, type FetchFn, type KeyValueStore, type SessionDeps, type SessionEvents } from "./online";
import {
  DEVICE_ID_PATTERN,
  ENDLESS_PATH,
  TOKEN_PATTERN,
  type DeviceResponse,
  type EndlessJoinMessage,
  type EndlessStateMessage,
  type RankingResponse,
} from "./protocol";

/** 端末 ID とトークンの保存先（localStorage） */
export const DEVICE_KEY = "kyosho:endless";

/** 保存した端末（形の違う・壊れた保存は null） */
export function loadDevice(store: KeyValueStore): DeviceResponse | null {
  try {
    const v = JSON.parse(store.getItem(DEVICE_KEY) ?? "null") as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { v: ver, device, token } = v as Record<string, unknown>;
    if (ver !== 1 || typeof device !== "string" || typeof token !== "string") return null;
    return DEVICE_ID_PATTERN.test(device) && TOKEN_PATTERN.test(token) ? { device, token } : null;
  } catch {
    return null;
  }
}

export function saveDevice(store: KeyValueStore, dev: DeviceResponse) {
  store.setItem(DEVICE_KEY, JSON.stringify({ v: 1, device: dev.device, token: dev.token }));
}

export function dropDevice(store: KeyValueStore) {
  store.removeItem(DEVICE_KEY);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** 端末を発行してもらう（POST /api/endless/devices） */
export function registerDevice(fetchFn: FetchFn = fetch): Promise<DeviceResponse> {
  return request(
    fetchFn,
    "/endless/devices",
    { method: "POST" },
    (b): b is DeviceResponse => isObj(b) && typeof b.device === "string" && DEVICE_ID_PATTERN.test(b.device) && typeof b.token === "string" && TOKEN_PATTERN.test(b.token),
  );
}

/** ランキング（上位と、device があればその端末の順位） */
export function getRanking(device: string | null, fetchFn: FetchFn = fetch): Promise<RankingResponse> {
  return request(
    fetchFn,
    `/endless/ranking${device ? `?device=${encodeURIComponent(device)}` : ""}`,
    { cache: "no-store" },
    (b): b is RankingResponse => isObj(b) && Array.isArray(b.top) && typeof b.total === "number",
  );
}

/** WebSocket の URL（画面と同じオリジンの /api/endless の下） */
export function endlessWsUrl(device: string, loc: Pick<Location, "protocol" | "host">): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${ENDLESS_PATH}/devices/${device}/ws`;
}

export interface EndlessEvents extends Pick<SessionEvents, "error" | "conn" | "ended"> {
  endless?(m: EndlessStateMessage): void;
}

/**
 * 端末の Durable Object への接続。join（端末のトークンと名前）・状態の受け取り・つなぎ直しは OnlineSession と同じ。
 * 抜けるときに leave は送らない（挑戦は残り、次に開けば続きから）
 */
export class EndlessSession extends OnlineSession {
  protected override readonly leaveOnClose = false;

  constructor(
    private readonly dev: DeviceResponse,
    url: string,
    private readonly handlers: EndlessEvents,
    deps: SessionDeps,
    name = "",
    /** 端末のトークンが合わなかった（invalid_token）。保存した端末を捨てる */
    private readonly forget: () => void = () => {},
  ) {
    super(dev.device, url, handlers, deps, name);
  }

  protected override joinMessage(): object {
    const join: EndlessJoinMessage = { type: "join", token: this.dev.token };
    if (this.name) join.name = this.name;
    return join;
  }

  protected override handle(m: { type: string }) {
    if (m.type !== "endless") return;
    // 最初の状態が届いた = 参加が通った
    if (this.connState !== "open") this.joinedNow();
    this.handlers.endless?.(m as EndlessStateMessage);
  }

  protected override dropCredentials() {
    this.forget();
  }

  /** 新しい挑戦を始める（挑戦がない・負けて終わった後）。test は e2e 用（サーバーの var TEST_ENDLESS のときだけ効く） */
  sendStart(test?: object): boolean {
    return this.sendRaw(test ? { type: "start", test } : { type: "start" });
  }

  /** 勝った・引き分けの後の次の対局（game は終わった対局の番号） */
  sendNext(game: number): boolean {
    return this.sendRaw({ type: "next", game });
  }
}
