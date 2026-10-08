// 1 部屋 = 1 Durable Object。対局の状態を持ち、手を engine の playMove で検証して適用する（権威サーバー）。
// WebSocket は Hibernation API で受ける（待っている間は課金されず、オブジェクトが退避されても接続は残る）。
// 部屋の状態は storage の "room" に保存し、退避後はコンストラクタで読み直す。
// 隠し王を守るため、各プレイヤーには viewFor(state, そのプレイヤー) だけを送る（GameState をそのまま送らない）。
// 1 手ごとの制限時間はここで計る。締め切りに alarm を張り、切れたら置ける手から 1 手を自動で打つ（相手が切断中でも進む）。
// alarm は 1 つしか張れないので、制限時間のある対局中は締め切り、それ以外は放置で消す時刻に張る。
// 終局後は同じ部屋で再戦できる。両者が申し込む（片方の申し込みをもう一方が受ける）と、席のトークンを入れ替えて
// （先手と後手を交代して）同じルール・同じ制限時間の新しい対局を始める。前の対局の GameState（王を含む）は捨てる。

import { DurableObject } from "cloudflare:workers";
import { createGame, playMove, playTimeout, viewFor, type GameState } from "../../web/src/engine/game";
import { other, type Player, type RuleSet } from "../../web/src/engine/rules";
import {
  CLOSE,
  FINISHED_TTL_MS,
  PING_TEXT,
  PONG_TEXT,
  ROOM_TTL_MS,
  TURN_GRACE_MS,
  type CreateRoomResponse,
  type HostSeat,
  type MoveMessage,
  type RematchMessage,
  type RematchStatus,
  type RoomInfoResponse,
  type RoomPhase,
  type StateMessage,
  type TurnClockInfo,
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
  /** 1 手ごとの制限時間（ミリ秒。0 は制限なし）。制限時間の入る前に作った部屋にはない（= 0） */
  turnMs?: number;
  /** 手番の人の締め切り（エポックミリ秒。制限時間 + 猶予）。制限なし・対局中でないなら null（ないのも同じ） */
  deadline?: number | null;
  /** 何局目か（1 始まり）。再戦の入る前に作った部屋にはない（= 1） */
  gameNo?: number;
  /** 席ごとの再戦の申し込み [先手, 後手]。終局後だけ意味を持ち、次の対局が始まると消す。ないのは両方 none */
  rematch?: [RematchStatus, RematchStatus];
  /** 席ごとに leave で抜けたか。同じトークンで戻ると false。ないのは両方 false */
  left?: [boolean, boolean];
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
  async create(roomId: string, rules: RuleSet, hostSeat: HostSeat, turnSeconds = 0): Promise<CreateRoomResponse | null> {
    if (this.room) return null;
    const host: Player = hostSeat === "first" ? 0 : hostSeat === "second" ? 1 : (randomInt(2) as Player);
    const token = randomId(32);
    const tokens: [string | null, string | null] = [null, null];
    tokens[host] = token;
    this.room = { roomId, createdAt: Date.now(), tokens, host, game: createGame(rules), turnMs: turnSeconds * 1000, deadline: null };
    await this.save();
    return { roomId, token, you: host };
  }

  async info(): Promise<RoomInfoResponse | null> {
    if (!this.room) return null;
    const { roomId, game, tokens, turnMs } = this.room;
    return { roomId, phase: this.phase(), rules: game.rules, turnSeconds: (turnMs ?? 0) / 1000, open: tokens.includes(null) };
  }

  /** WebSocket の受け口（Worker が /api/rooms/:id/ws をそのまま渡す。Upgrade の確認は Worker 側で済んでいる） */
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
    if (msg.type === "rematch") return this.rematch(ws, att.player, room, msg);
    if (msg.type === "leave") return this.leave(att.player, room);
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

  /**
   * 制限時間のある対局中なら手番の締め切り: 切れていれば自動で 1 手打つ。
   * それ以外は最後の操作から TTL が経った（alarm は操作のたびに張り直すので、ここに来たら放置されている）。接続を閉じて部屋を消す
   */
  async alarm(): Promise<void> {
    const deadline = this.room?.deadline;
    if (deadline != null && this.phase() === "playing") {
      // 締め切りの前に起きた（張り直しの入れ違いなど）なら張り直すだけ
      if (Date.now() >= deadline) await this.timeout();
      else await this.touch();
      return;
    }
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
    const deadline = this.room?.deadline;
    if (deadline != null && this.phase() === "playing") {
      await this.ctx.storage.setAlarm(deadline);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + (this.phase() === "finished" ? FINISHED_TTL_MS : ROOM_TTL_MS));
  }

  /** 手番が変わった（対局が始まった・手が打たれた）。制限時間があり対局中なら締め切りを今から数え直す */
  private restartClock(): void {
    const room = this.room!;
    const turnMs = room.turnMs ?? 0;
    room.deadline = turnMs > 0 && this.phase() === "playing" ? Date.now() + turnMs + TURN_GRACE_MS : null;
  }

  /** 締め切りを過ぎた手番の人の手を、置ける手から自動で 1 手打つ（棋譜に timeout の印） */
  private async timeout(): Promise<void> {
    const room = this.room!;
    room.game = playTimeout(room.game, () => randomInt(2 ** 32) / 2 ** 32);
    this.restartClock();
    await this.save();
    this.broadcast();
  }

  /** 手番の人の残り時間（制限なし・対局中でなければ null） */
  private clockInfo(): TurnClockInfo | null {
    const room = this.room!;
    if (room.deadline == null || this.phase() !== "playing") return null;
    return { limitMs: room.turnMs ?? 0, remainingMs: Math.max(0, room.deadline - Date.now()) };
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
      // 2 人目が入って対局が始まった。先手の時計を動かす
      this.restartClock();
    }
    // 同じ席の古い接続（再読み込み前のタブなど）は閉じる
    for (const old of this.ctx.getWebSockets()) {
      if (old !== ws && attachmentOf(old).player === player) closeQuietly(old, CLOSE.replaced, "replaced");
    }
    ws.serializeAttachment({ ...att, player } satisfies Attachment);
    // 抜けた人が同じトークンで戻った
    const returned = room.left?.[player] === true;
    if (returned) room.left![player] = false;
    // 新しい参加・抜けた人の復帰なら保存する。復帰でも放置の期限は延ばす
    if (token === undefined || returned) await this.save();
    else await this.touch();
    send(ws, { type: "joined", roomId: room.roomId, you: player, token: mine });
    this.broadcast();
  }

  private async move(ws: WebSocket, player: Player, room: RoomRecord, msg: MoveMessage): Promise<void> {
    const phase = this.phase();
    if (phase === "waiting") return send(ws, errorMsg("waiting_opponent", "相手の参加を待っています"));
    if (phase === "finished") return send(ws, errorMsg("game_over", "対局は終了しています"));
    // 締め切りを過ぎていれば（alarm より先に手が届いた）、送られた手より先に自動の手を打つ
    if (room.deadline != null && Date.now() >= room.deadline) {
      await this.timeout();
      return send(ws, errorMsg("stale_move", "制限時間が切れたため、自動で手を打ちました"));
    }
    if (room.game.turn !== player) return send(ws, errorMsg("not_your_turn", "相手の手番です"));
    if (msg.seq !== undefined && msg.seq !== room.game.history.length) {
      return send(ws, errorMsg("stale_move", "局面が進んでいます（制限時間切れの自動の手と入れ違いになりました）"));
    }
    let next: GameState;
    try {
      next = playMove(room.game, msg.r, msg.c, msg.kind, { king: msg.king });
    } catch (e) {
      // engine が拒否した手。状態は変えない
      return send(ws, errorMsg("illegal_move", e instanceof Error ? e.message : "その手は打てません"));
    }
    room.game = next;
    this.restartClock();
    await this.save();
    this.broadcast();
  }

  /**
   * 再戦の申し込み・取り消し・断り（終局後だけ）。同じ操作の二重押しは何もしない。
   * 相手が申し込み済みのところへ申し込む（受ける・同時に申し込んだ）と、次の対局を始める
   */
  private async rematch(ws: WebSocket, player: Player, room: RoomRecord, msg: RematchMessage): Promise<void> {
    if (this.phase() !== "finished" || msg.gameNo !== (room.gameNo ?? 1)) {
      return send(ws, errorMsg("stale_rematch", "再戦を申し込める対局ではありません（次の対局が始まっています）"));
    }
    const opp = other(player);
    const r: [RematchStatus, RematchStatus] = room.rematch ?? ["none", "none"];
    switch (msg.action) {
      case "request":
        if (room.left?.[opp]) return send(ws, errorMsg("opponent_left", "相手は部屋を抜けました"));
        if (r[opp] === "requested") return this.nextGame();
        if (r[player] === "requested") return;
        r[player] = "requested";
        // 断った相手にもう一度申し込んだ。相手の「断った」は消す
        if (r[opp] === "declined") r[opp] = "none";
        break;
      case "cancel":
        if (r[player] !== "requested") return;
        r[player] = "none";
        break;
      case "decline":
        if (r[opp] !== "requested") return;
        r[opp] = "none";
        r[player] = "declined";
        break;
    }
    room.rematch = r;
    await this.save();
    this.broadcast();
  }

  /**
   * 再戦が成立した。同じルール・同じ制限時間で新しい対局を作り、先手と後手を入れ替える。
   * 席はトークンの添字なので、トークンと接続ごとの席（attachment）を入れ替える（トークンは変わらず、再接続もそのまま通る）
   */
  private async nextGame(): Promise<void> {
    const room = this.room!;
    room.game = createGame(room.game.rules);
    room.tokens = [room.tokens[1], room.tokens[0]];
    room.host = other(room.host);
    room.gameNo = (room.gameNo ?? 1) + 1;
    room.rematch = ["none", "none"];
    room.left = [false, false];
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att.player !== null) ws.serializeAttachment({ ...att, player: other(att.player) } satisfies Attachment);
    }
    this.restartClock();
    await this.save();
    this.broadcast();
  }

  /** 部屋を抜けた（接続はこの後クライアントが閉じる）。再戦の申し込みを取り下げ、相手に退室を知らせる */
  private async leave(player: Player, room: RoomRecord): Promise<void> {
    if (room.left?.[player]) return;
    room.left = room.left ?? [false, false];
    room.left[player] = true;
    if (room.rematch) room.rematch = ["none", "none"];
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
    const clock = this.clockInfo();
    for (const ws of sockets) {
      const you = attachmentOf(ws).player;
      if (you === null) continue;
      const opp = other(you);
      const msg: StateMessage = {
        type: "state",
        roomId: room.roomId,
        phase,
        gameNo: room.gameNo ?? 1,
        you,
        view: viewFor(room.game, you),
        opponent: { joined: room.tokens[opp] !== null, online: online[opp], left: room.left?.[opp] ?? false },
        rematch: phase === "finished" ? { you: room.rematch?.[you] ?? "none", opponent: room.rematch?.[opp] ?? "none" } : null,
        clock,
      };
      send(ws, msg);
    }
  }
}
