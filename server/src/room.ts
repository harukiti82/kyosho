// 1 部屋 = 1 Durable Object。対局の状態を持ち、手を engine の playMove で検証して適用する（権威サーバー）。
// WebSocket は Hibernation API で受ける（待っている間は課金されず、オブジェクトが退避されても接続は残る）。
// 部屋の状態は storage の "room" に保存し、退避後はコンストラクタで読み直す。
// 隠し王を守るため、各プレイヤーには viewFor(state, そのプレイヤー) だけを送る（GameState をそのまま送らない）。

import { DurableObject } from "cloudflare:workers";
import { createGame, playMove, viewFor, type GameState } from "../../web/src/engine/game";
import { other, type Player, type RuleSet } from "../../web/src/engine/rules";
import {
  CLOSE,
  FINISHED_TTL_MS,
  PING_TEXT,
  PONG_TEXT,
  ROOM_TTL_MS,
  type CreateRoomResponse,
  type HostSeat,
  type MoveMessage,
  type RoomInfoResponse,
  type RoomPhase,
  type StateMessage,
} from "../../web/src/net/protocol";
import { closeQuietly, errorMsg, randomId, randomInt, rejectSocket, send } from "./util";
import { parseClientMessage } from "./validate";

/** storage に保存する部屋の状態 */
export interface RoomRecord {
  roomId: string;
  createdAt: number;
  /** 席ごとの再接続トークン [先手, 後手]。未参加は null */
  tokens: [string | null, string | null];
  /** 作成者の席 */
  host: Player;
  game: GameState;
}

/** 接続ごとに保存する情報（退避しても残る） */
interface Attachment {
  /** join 済みならその席 */
  player: Player | null;
  /** 接続した時刻（join 前の接続を古い順に閉じる用） */
  at: number;
}

/** join 前の接続の上限。超えたら古いものから閉じる（席が埋まった部屋に接続を溜めさせない） */
const MAX_PENDING = 4;

const attachmentOf = (ws: WebSocket): Attachment => (ws.deserializeAttachment() as Attachment | null) ?? { player: null, at: 0 };

/** トークンの比較（長さが違えば不一致。同じ長さなら比較時間が一定） */
function sameToken(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export class Room extends DurableObject<Env> {
  private room: RoomRecord | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ping はオブジェクトを起こさずに返す
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomRecord>("room")) ?? null;
    });
  }

  // ---- Worker から呼ぶ RPC ----

  /** 部屋を作る。同じ ID の部屋がすでにあれば null（ID の衝突。Worker が別の ID で作り直す） */
  async create(roomId: string, rules: RuleSet, hostSeat: HostSeat): Promise<CreateRoomResponse | null> {
    if (this.room) return null;
    const host: Player = hostSeat === "first" ? 0 : hostSeat === "second" ? 1 : (randomInt(2) as Player);
    const token = randomId(32);
    const tokens: [string | null, string | null] = [null, null];
    tokens[host] = token;
    this.room = { roomId, createdAt: Date.now(), tokens, host, game: createGame(rules) };
    await this.save();
    return { roomId, token, you: host };
  }

  async info(): Promise<RoomInfoResponse | null> {
    if (!this.room) return null;
    return { roomId: this.room.roomId, phase: this.phase(), rules: this.room.game.rules, open: this.room.tokens.includes(null) };
  }

  /** WebSocket の受け口（Worker が /rooms/:id/ws をそのまま渡す。Upgrade の確認は Worker 側で済んでいる） */
  async fetch(_request: Request): Promise<Response> {
    if (!this.room) return rejectSocket("room_not_found", "部屋がありません", CLOSE.notFound);
    const pending = this.ctx
      .getWebSockets()
      .filter((ws) => attachmentOf(ws).player === null)
      .sort((a, b) => attachmentOf(a).at - attachmentOf(b).at);
    while (pending.length >= MAX_PENDING) {
      const ws = pending.shift()!;
      send(ws, errorMsg("not_joined", "join せずに待っている接続が多すぎるため閉じます"));
      closeQuietly(ws, CLOSE.rejected, "not_joined");
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ player: null, at: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket（Hibernation API のハンドラ） ----

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = attachmentOf(ws);
    const room = this.room;
    if (!room) {
      send(ws, errorMsg("room_not_found", "部屋がありません"));
      closeQuietly(ws, CLOSE.notFound, "room_not_found");
      return;
    }
    const parsed = parseClientMessage(data);
    // join 前の接続は、失敗したら閉じる（席が取れない接続を残さない）
    const reject = (code: Parameters<typeof errorMsg>[0], message: string) => {
      send(ws, errorMsg(code, message));
      if (att.player === null) closeQuietly(ws, CLOSE.rejected, code);
    };
    if (!parsed.ok) return reject(parsed.code, parsed.message);
    const msg = parsed.msg;
    if (msg.type === "join") return this.join(ws, att, room, msg.token);
    if (att.player === null) return reject("not_joined", "先に join を送ってください");
    return this.move(ws, att.player, room, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    closeQuietly(ws, 1000, "closed");
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  // ---- 後片付け ----

  /** 最後の操作から TTL が経った（alarm は操作のたびに張り直すので、ここに来たら放置されている）。接続を閉じて部屋を消す */
  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) closeQuietly(ws, CLOSE.expired, "room_expired");
    this.room = null;
    await this.ctx.storage.deleteAll();
  }

  // ---- 内部 ----

  private phase(): RoomPhase {
    const room = this.room!;
    if (room.tokens.includes(null)) return "waiting";
    return room.game.result ? "finished" : "playing";
  }

  /** 部屋を保存し、放置で消す alarm を張り直す */
  private async save(): Promise<void> {
    await this.ctx.storage.put("room", this.room);
    await this.touch();
  }

  private async touch(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + (this.phase() === "finished" ? FINISHED_TTL_MS : ROOM_TTL_MS));
  }

  private async join(ws: WebSocket, att: Attachment, room: RoomRecord, token: string | undefined): Promise<void> {
    if (att.player !== null) return send(ws, errorMsg("already_joined", "すでに参加しています"));
    let player: Player;
    let mine: string;
    if (token !== undefined) {
      const seat = room.tokens.findIndex((t) => t !== null && sameToken(t, token));
      if (seat < 0) {
        send(ws, errorMsg("invalid_token", "トークンがこの部屋の席と合いません"));
        return closeQuietly(ws, CLOSE.rejected, "invalid_token");
      }
      player = seat as Player;
      mine = token;
    } else {
      const seat = room.tokens.indexOf(null);
      if (seat < 0) {
        send(ws, errorMsg("room_full", "この部屋は満員です"));
        return closeQuietly(ws, CLOSE.rejected, "room_full");
      }
      player = seat as Player;
      mine = randomId(32);
      room.tokens[player] = mine;
    }
    // 同じ席の古い接続（再読み込み前のタブなど）は閉じる
    for (const old of this.ctx.getWebSockets()) {
      if (old !== ws && attachmentOf(old).player === player) closeQuietly(old, CLOSE.replaced, "replaced");
    }
    ws.serializeAttachment({ ...att, player } satisfies Attachment);
    // 新しい参加なら席を保存する。復帰でも放置の期限は延ばす
    if (token === undefined) await this.save();
    else await this.touch();
    send(ws, { type: "joined", roomId: room.roomId, you: player, token: mine });
    this.broadcast();
  }

  private async move(ws: WebSocket, player: Player, room: RoomRecord, msg: MoveMessage): Promise<void> {
    const phase = this.phase();
    if (phase === "waiting") return send(ws, errorMsg("waiting_opponent", "相手の参加を待っています"));
    if (phase === "finished") return send(ws, errorMsg("game_over", "対局は終了しています"));
    if (room.game.turn !== player) return send(ws, errorMsg("not_your_turn", "相手の手番です"));
    let next: GameState;
    try {
      next = playMove(room.game, msg.r, msg.c, msg.kind, { king: msg.king });
    } catch (e) {
      // engine が拒否した手。状態は変えない
      return send(ws, errorMsg("illegal_move", e instanceof Error ? e.message : "その手は打てません"));
    }
    room.game = next;
    await this.save();
    this.broadcast();
  }

  /** 接続が切れた。相手に「切断中」を知らせる */
  private async left(ws: WebSocket): Promise<void> {
    if (this.room && attachmentOf(ws).player !== null) this.broadcast(ws);
  }

  /** join 済みの全接続に、それぞれの席から見た状態を送る。gone は切れかけの接続（送らず、接続中とも数えない） */
  private broadcast(gone?: WebSocket): void {
    const room = this.room;
    if (!room) return;
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== gone && ws.readyState === WebSocket.OPEN);
    const online: [boolean, boolean] = [false, false];
    for (const ws of sockets) {
      const p = attachmentOf(ws).player;
      if (p !== null) online[p] = true;
    }
    const phase = this.phase();
    for (const ws of sockets) {
      const you = attachmentOf(ws).player;
      if (you === null) continue;
      const opp = other(you);
      const msg: StateMessage = {
        type: "state",
        roomId: room.roomId,
        phase,
        you,
        view: viewFor(room.game, you),
        opponent: { joined: room.tokens[opp] !== null, online: online[opp] },
      };
      send(ws, msg);
    }
  }
}
