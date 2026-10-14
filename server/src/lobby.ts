// 合言葉の受付。正規化した合言葉ごとに 1 つの Durable Object（Worker が合言葉の SHA-256 から idFromName で引く。合言葉そのものは持たない）。
// 待っている部屋を 1 つだけ覚える。来た人は、その部屋がまだ待っていれば参加へ、なければ新しい部屋を作って待つ。
// 部屋がまだ待っているか（作成者が抜けていない・つながっている・席が空いている）は、来るたびに部屋（room.ts の matchInfo）に聞く。
// そろった部屋・作成者が抜けた部屋・消えた部屋は待っていないので、次に来た人は新しい部屋になる（合言葉が空く）。
// 部屋への問い合わせ・部屋の作成は別の Durable Object への呼び出しで、その間は次の要求が割り込めるので、
// 要求を 1 件ずつ順に処理する（ほぼ同時に来た 2 人が別々の部屋を作らない）。

import { DurableObject } from "cloudflare:workers";
import type { RuleSet } from "../../web/src/engine/rules";
import { ROOM_TTL_MS, type HostSeat, type MatchResponse } from "../../web/src/net/protocol";
import { randomId, roomStub } from "./util";

/** 新しい部屋を作るときの設定（来た人の設定） */
export interface MatchOptions {
  rules: RuleSet;
  hostSeat: HostSeat;
  turnSeconds: number;
}

export class Lobby extends DurableObject<Env> {
  /** 処理中の要求（次の要求はこれの後に回す） */
  private queue: Promise<unknown> = Promise.resolve();

  /** 1 件ずつ順に処理する（前の要求が失敗しても次は動かす） */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f);
    this.queue = run.catch(() => {});
    return run;
  }

  /** 待っている部屋があれば参加の案内、なければ新しい部屋を作って作成者として返す */
  match(opts: MatchOptions): Promise<MatchResponse> {
    return this.serial(async () => {
      const waiting = await this.ctx.storage.get<string>("room");
      if (waiting) {
        const info = await roomStub(this.env, waiting).matchInfo();
        // RPC の戻り値の型はタプルを配列に崩すので、RuleSet に戻す（中身は部屋が持つ検証済みのルール）
        if (info) return { status: "join", roomId: waiting, rules: info.rules as RuleSet, turnSeconds: info.turnSeconds };
      }
      // 部屋 ID は 128 ビットの乱数なので衝突はまず起きないが、起きたら作り直す
      for (let i = 0; i < 3; i++) {
        const roomId = randomId(16);
        const res = await roomStub(this.env, roomId).create(roomId, opts.rules, opts.hostSeat, opts.turnSeconds, true);
        if (!res) continue;
        await this.ctx.storage.put("room", roomId);
        // 部屋は待機のまま 24 時間で消えるので、受付の記録も同じ頃に消す
        await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
        return { status: "wait", ...res };
      }
      throw new Error("部屋を作れませんでした");
    });
  }

  async alarm(): Promise<void> {
    await this.serial(() => this.ctx.storage.deleteAll());
  }
}
