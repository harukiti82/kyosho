// エンドレスマッチ: 1 端末 = 1 Durable Object（端末 ID から idFromName で引く）。端末のトークン・名前・最高の連勝数と、
// 今の挑戦（連勝数・段階・対局の GameState）を storage の "device" に 1 件で持つ。
// 権威サーバー: プレイヤーの手は engine の playMove で検証し、CPU の手もここで打つ（engine/endless.ts の cpuTurn）。
// 画面へは viewFor(対局, プレイヤー) だけを送る（CPU の王・副将の場所を含む GameState は送らない）。連勝数は画面から受け取らない。
// CPU の手は alarm で打つ: プレイヤーの手の後 ENDLESS_CPU_DELAY_MS（考えている演出）で 1 手番ずつ（1 回の呼び出しで 1 手）。
// 1 手の制限時間はプレイヤーの手番で WebSocket がつながっている間だけ数える。切断したら残りを覚えて止め、戻ったら残りから数える
// （中断して時間を稼げない・中断中に時間切れで負けない）。alarm は 1 つなので、CPU の手の時刻と締め切りの早い方に張る。
// 勝つと連勝数を 1 増やし（最高を超えたらランキング ranking.ts に書く）、次の対局は段階を 1 つ上げる。引き分けは同じ段階をもう一度、
// 負けたら挑戦の終わり（記録は残る）。先手と後手は 1 局ごとに入れ替える（1 局目はプレイヤーが先手）。
// 端末の記録は消さない（別の日に続きから遊べる）。e2e 用に var TEST_ENDLESS があるときだけ、start / next の test で体力・CPU を変えられる。

import { DurableObject } from "cloudflare:workers";
import { cpuOf, cpuTurn, newEndlessGame, stageOf, type EndlessStage } from "../../web/src/engine/endless";
import { pickSkill, playMove, playTimeout, rerollSkills, useSkill, viewFor, type GameState } from "../../web/src/engine/game";
import { other, type Player } from "../../web/src/engine/rules";
import {
  CLOSE,
  ENDLESS_CPU_DELAY_MS,
  ENDLESS_TURN_SECONDS,
  PING_TEXT,
  PONG_TEXT,
  TURN_GRACE_MS,
  type EndlessPhase,
  type EndlessRunInfo,
  type EndlessServerMessage,
  type EndlessStateMessage,
  type MoveMessage,
  type PickMessage,
  type RerollMessage,
  type SkillMessage,
  type WsErrorCode,
} from "../../web/src/net/protocol";
import type { Ranking } from "./ranking";
import { closeQuietly, errorMsg, randomInt } from "./util";
import { parseEndlessMessage, type EndlessTest } from "./validate";

const cryptoRng = () => randomInt(2 ** 32) / 2 ** 32;

/** 今の挑戦 */
export interface RunRecord {
  phase: EndlessPhase;
  /** 連勝数（勝った対局を含む） */
  wins: number;
  /** 何局目か（1 始まり） */
  game: number;
  /** CPU の席 */
  cpu: Player;
  /** この対局の段階（始めたときの stageOf。表を変えても対局の途中では変わらない） */
  stage: EndlessStage;
  state: GameState;
  /** 1 手の制限時間（ミリ秒） */
  turnMs: number;
  /** プレイヤーの締め切り（エポックミリ秒）。数えていない（CPU の手番・カードを選ぶ間・切断中・対局中でない）なら null */
  deadline: number | null;
  /** 切断で止めたプレイヤーの手番の残り（ミリ秒）。止めていなければ null（手番が来たら最初から） */
  left: number | null;
  /** CPU の手を打つ時刻（エポックミリ秒）。CPU の手番でなければ null */
  cpuAt: number | null;
  /** e2e 用の上書き（var TEST_ENDLESS のときだけ） */
  test?: EndlessTest;
}

/** storage の "device" */
export interface DeviceRecord {
  device: string;
  token: string;
  createdAt: number;
  /** 最後の join で届いた名前（検証済み。名前なしは null）。ランキングの名前 */
  name: string | null;
  /** 最高の連勝数 */
  best: number;
  run: RunRecord | null;
}

/** 接続ごとに保存する情報（退避しても残る） */
interface Attachment {
  joined: boolean;
  at: number;
}

const attachmentOf = (ws: WebSocket): Attachment => (ws.deserializeAttachment() as Attachment | null) ?? { joined: false, at: 0 };

function sameToken(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** join 前の接続の上限 */
const MAX_PENDING = 4;

const send = (ws: WebSocket, msg: EndlessServerMessage) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // 閉じかけ
  }
};

/** 対局が終わったら挑戦の状態を決める（勝ち: 連勝 +1 / 引き分け: そのまま / 負け: 挑戦の終わり）。純粋な関数 */
export function settle(run: RunRecord): RunRecord {
  const r = run.state.result;
  if (!r || run.phase !== "playing") return run;
  const you = other(run.cpu);
  const phase: EndlessPhase = r.winner === you ? "won" : r.winner === null ? "drawn" : "lost";
  return { ...run, phase, wins: phase === "won" ? run.wins + 1 : run.wins, deadline: null, left: null, cpuAt: null };
}

/** 次の対局（勝った後は段階が上がり、引き分けの後は同じ段階）。先手と後手を入れ替える */
export function nextRun(run: RunRecord, rng: () => number): RunRecord {
  return newRun(run.wins, run.game + 1, run.test, run.turnMs, rng);
}

/** wins 連勝の後の game 局目。奇数局はプレイヤーが先手 */
export function newRun(wins: number, game: number, test: EndlessTest | undefined, turnMs: number, rng: () => number): RunRecord {
  const cpu: Player = game % 2 === 1 ? 1 : 0;
  const base = stageOf(wins);
  const stage: EndlessStage = test?.cpu ? { base: test.cpu, next: test.cpu, mix: 0, hp: base.hp } : base;
  let state = newEndlessGame(cpu, stage, rng);
  if (test?.hp) {
    const hp: [number, number] = [state.hp[0], state.hp[1]];
    hp[other(cpu)] = test.hp[0];
    hp[cpu] = test.hp[1];
    state = { ...state, hp, rules: { ...state.rules, hp: [...hp] } };
  }
  return { phase: "playing", wins, game, cpu, stage, state, turnMs, deadline: null, left: null, cpuAt: null, ...(test ? { test } : {}) };
}

export class Endless extends DurableObject<Env> {
  private dev: DeviceRecord | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    ctx.blockConcurrencyWhile(async () => {
      this.dev = (await ctx.storage.get<DeviceRecord>("device")) ?? null;
    });
  }

  // ---- Worker から呼ぶ RPC ----

  /** 端末を登録する。同じ ID がもうあれば false（Worker が別の ID で作り直す） */
  async register(device: string, token: string): Promise<boolean> {
    if (this.dev) return false;
    this.dev = { device, token, createdAt: Date.now(), name: null, best: 0, run: null };
    await this.ctx.storage.put("device", this.dev);
    return true;
  }

  async fetch(_request: Request): Promise<Response> {
    const pending = this.ctx
      .getWebSockets()
      .filter((ws) => !attachmentOf(ws).joined)
      .sort((a, b) => attachmentOf(a).at - attachmentOf(b).at);
    while (pending.length >= MAX_PENDING) {
      const ws = pending.shift()!;
      send(ws, errorMsg("not_joined", "join せずに待っている接続が多すぎるため閉じます"));
      closeQuietly(ws, CLOSE.rejected, "not_joined");
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joined: false, at: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket ----

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = attachmentOf(ws);
    const parsed = parseEndlessMessage(data, this.testOn());
    const reject = (code: WsErrorCode, message: string) => {
      send(ws, errorMsg(code, message));
      if (!att.joined) closeQuietly(ws, CLOSE.rejected, code);
    };
    if (!parsed.ok) return reject(parsed.code, parsed.message);
    const msg = parsed.msg;
    if (msg.type === "join") return this.join(ws, att, msg.token, msg.name);
    if (!att.joined || !this.dev) return reject("not_joined", "先に join を送ってください");
    switch (msg.type) {
      case "start":
        return this.start(ws, parsed.test);
      case "next":
        return this.next(ws, msg.game);
      case "move":
      case "skill":
      case "pick":
      case "reroll":
        return this.play(ws, msg);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    closeQuietly(ws, 1000, "closed");
    await this.disconnected(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnected(ws);
  }

  /** CPU の手の時刻か、プレイヤーの締め切り */
  async alarm(): Promise<void> {
    const run = this.dev?.run;
    if (!run || run.phase !== "playing") return;
    const now = Date.now();
    if (run.cpuAt !== null && now >= run.cpuAt) await this.cpuMove(run);
    else if (run.deadline !== null && now >= run.deadline) await this.timeout(run);
    else await this.schedule();
  }

  // ---- 内部 ----

  private testOn(): boolean {
    return (this.env as unknown as { TEST_ENDLESS?: string }).TEST_ENDLESS === "1";
  }

  /** プレイヤーが今つながっているか（gone は切れかけの接続） */
  private online(gone?: WebSocket): boolean {
    return this.ctx.getWebSockets().some((ws) => ws !== gone && ws.readyState === WebSocket.OPEN && attachmentOf(ws).joined);
  }

  private async join(ws: WebSocket, att: Attachment, token: string, name: string | undefined): Promise<void> {
    if (att.joined) return send(ws, errorMsg("already_joined", "すでに参加しています"));
    const dev = this.dev;
    // 端末がない・トークンが違うは同じ答え（端末があるかを漏らさない）
    if (!dev || !sameToken(dev.token, token)) {
      send(ws, errorMsg("invalid_token", "端末のトークンが合いません"));
      return closeQuietly(ws, CLOSE.rejected, "invalid_token");
    }
    for (const old of this.ctx.getWebSockets()) {
      if (old !== ws && attachmentOf(old).joined) closeQuietly(old, CLOSE.replaced, "replaced");
    }
    ws.serializeAttachment({ ...att, joined: true } satisfies Attachment);
    const named = name ?? null;
    if (named !== dev.name) {
      dev.name = named;
      if (dev.best > 0) await this.toRanking((r) => r.rename(dev.device, named));
    }
    // 切断で止めていた手番の時計を、残りから動かす
    const run = dev.run;
    if (run) this.resumeClock(run);
    await this.save();
    this.push();
  }

  private async start(ws: WebSocket, test: EndlessTest | undefined): Promise<void> {
    const dev = this.dev!;
    if (dev.run && dev.run.phase !== "lost") return send(ws, errorMsg("run_active", "挑戦の途中です"));
    const turnMs = (test?.turnSeconds ?? ENDLESS_TURN_SECONDS) * 1000;
    dev.run = newRun(0, 1, test, turnMs, cryptoRng);
    this.afterChange(dev.run);
    await this.save();
    this.push();
  }

  private async next(ws: WebSocket, game: number): Promise<void> {
    const dev = this.dev!;
    const run = dev.run;
    if (!run || (run.phase !== "won" && run.phase !== "drawn") || run.game !== game) {
      return send(ws, errorMsg("stale_next", "次の対局を始められません"));
    }
    dev.run = nextRun(run, cryptoRng);
    this.afterChange(dev.run);
    await this.save();
    this.push();
  }

  /** プレイヤーの手・スキル・カードの選択・配り直し */
  private async play(ws: WebSocket, msg: MoveMessage | SkillMessage | PickMessage | RerollMessage): Promise<void> {
    const run = this.dev!.run;
    if (!run || run.phase !== "playing") return send(ws, errorMsg("no_game", "対局中ではありません"));
    const you = other(run.cpu);
    const s = run.state;
    if (msg.type === "pick" || msg.type === "reroll") {
      try {
        run.state = msg.type === "pick" ? pickSkill(s, you, msg.card) : rerollSkills(s, you, cryptoRng);
      } catch (e) {
        return send(ws, errorMsg("illegal_skill", e instanceof Error ? e.message : "そのカードは選べません"));
      }
    } else {
      if (run.deadline !== null && Date.now() >= run.deadline) {
        await this.timeout(run);
        return send(ws, errorMsg("stale_move", "制限時間が切れたため、自動で手を打ちました"));
      }
      if (s.turn !== you || run.cpuAt !== null) return send(ws, errorMsg("not_your_turn", "CPU の手番です"));
      if (msg.seq !== undefined && msg.seq !== s.history.length) return send(ws, errorMsg("stale_move", "局面が進んでいます"));
      try {
        run.state =
          msg.type === "move"
            ? playMove(s, msg.r, msg.c, msg.kind, { king: msg.king, vice: msg.vice })
            : useSkill(s, { id: msg.id, kind: msg.kind, to: msg.to }, cryptoRng);
      } catch (e) {
        return send(ws, errorMsg(msg.type === "move" ? "illegal_move" : "illegal_skill", e instanceof Error ? e.message : "その手は打てません"));
      }
    }
    await this.changed(run, msg.type === "move");
  }

  /** CPU の手番を 1 つ打つ（段階の CPU。読みが例外になったら置ける手から 1 つ） */
  private async cpuMove(run: RunRecord): Promise<void> {
    if (run.state.turn !== run.cpu || run.state.result) {
      run.cpuAt = null;
      return this.changed(run, true);
    }
    try {
      run.state = cpuTurn(run.state, run.cpu, cpuOf(run.stage, cryptoRng), cryptoRng);
    } catch (e) {
      console.error(e);
      run.state = playTimeout(run.state, cryptoRng);
    }
    run.cpuAt = null;
    await this.changed(run, true);
  }

  /** プレイヤーの締め切りを過ぎた。置ける手から 1 つを自動で打つ */
  private async timeout(run: RunRecord): Promise<void> {
    run.state = playTimeout(run.state, cryptoRng);
    run.deadline = null;
    run.left = null;
    await this.changed(run, true);
  }

  /** 局面が変わった後の保存と配信。turned は手番が進んだ（プレイヤーの手番なら時計を最初から） */
  private async changed(run: RunRecord, turned: boolean): Promise<void> {
    const dev = this.dev!;
    const before = run.phase;
    const after = settle(run);
    dev.run = after;
    if (before === "playing" && after.phase === "won" && after.wins > dev.best) {
      dev.best = after.wins;
      await this.toRanking((r) => r.report(dev.device, dev.name, dev.best));
    }
    if (turned) {
      after.deadline = null;
      after.left = null;
    }
    this.afterChange(after);
    await this.save();
    this.push();
  }

  /** 対局中なら、次が CPU の手番なら CPU の手の時刻を、プレイヤーの手番なら時計を決める */
  private afterChange(run: RunRecord): void {
    if (run.phase !== "playing") {
      run.cpuAt = null;
      run.deadline = null;
      run.left = null;
      return;
    }
    const s = run.state;
    const picking = !!s.skills && !s.skills.ready;
    if (picking) return;
    if (s.turn === run.cpu) {
      run.deadline = null;
      run.left = null;
      if (run.cpuAt === null) run.cpuAt = Date.now() + ENDLESS_CPU_DELAY_MS;
      return;
    }
    run.cpuAt = null;
    this.resumeClock(run);
  }

  /** プレイヤーの手番で、つながっていて時計が止まっていれば動かす（止めた残りがあれば残りから） */
  private resumeClock(run: RunRecord): void {
    const s = run.state;
    if (run.phase !== "playing" || s.turn === run.cpu || (s.skills && !s.skills.ready) || run.deadline !== null) return;
    if (!this.online()) return;
    run.deadline = Date.now() + (run.left ?? run.turnMs + TURN_GRACE_MS);
    run.left = null;
  }

  /** 接続が切れた。ほかにつながっていなければプレイヤーの時計を止めて残りを覚える */
  private async disconnected(ws: WebSocket): Promise<void> {
    const run = this.dev?.run;
    if (!run || !attachmentOf(ws).joined || this.online(ws) || run.deadline === null) return;
    run.left = Math.max(0, run.deadline - Date.now());
    run.deadline = null;
    await this.save();
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("device", this.dev);
    await this.schedule();
  }

  /** alarm を CPU の手の時刻と締め切りの早い方に張る（どちらもなければ消す） */
  private async schedule(): Promise<void> {
    const run = this.dev?.run;
    const times = run && run.phase === "playing" ? [run.cpuAt, run.deadline].filter((t): t is number => t !== null) : [];
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  /** ランキングに書く。失敗しても対局は止めない（端末の最高は残るので、次に最高を超えたときに書き直す） */
  private async toRanking(f: (r: DurableObjectStub<Ranking>) => Promise<void>): Promise<void> {
    const ns = this.env.RANKING as DurableObjectNamespace<Ranking>;
    try {
      await f(ns.get(ns.idFromName("global")));
    } catch (e) {
      console.error(e);
    }
  }

  /** つながっている接続に今の状態を送る */
  private push(): void {
    const msg = this.stateMessage();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN && attachmentOf(ws).joined) send(ws, msg);
    }
  }

  private stateMessage(): EndlessStateMessage {
    const dev = this.dev!;
    const run = dev.run;
    let info: EndlessRunInfo | null = null;
    if (run) {
      const you = other(run.cpu);
      const st = run.stage;
      info = {
        phase: run.phase,
        wins: run.wins,
        game: run.game,
        you,
        stage: { no: run.wins + (run.phase === "won" ? 0 : 1), base: st.base, next: st.next, mix: st.mix, hp: st.hp },
        view: viewFor(run.state, you),
        clock: run.deadline !== null ? { limitMs: run.turnMs, remainingMs: Math.max(0, run.deadline - Date.now()) } : null,
        thinking: run.phase === "playing" && run.cpuAt !== null,
      };
    }
    return { type: "endless", run: info, best: dev.best, name: dev.name };
  }
}
