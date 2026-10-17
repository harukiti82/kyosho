// エンドレスマッチのランキング（全員分で 1 つの Durable Object。名前 "global" から idFromName で引く）。
// SQLite（ctx.storage.sql）に端末ごとの最高の連勝数を持つ。書くのは端末の Durable Object（endless.ts）だけで、
// 画面からの連勝数は受け付けない（Worker は読むための top だけを呼ぶ）。
// 運営が記録を消すときは管理用の API（index.ts の /api/endless/admin。Secret ENDLESS_ADMIN_TOKEN があるときだけ）から remove を呼ぶ。
// block を付けて消した端末は、その後の記録も載せない。

import { DurableObject } from "cloudflare:workers";
import { RANKING_TOP, type RankEntry, type RankingResponse } from "../../web/src/net/protocol";

/** 管理用の一覧の 1 行（端末 ID を含む。画面には出さない） */
export interface AdminScore {
  device: string;
  name: string | null;
  best: number;
  at: number;
  blocked: boolean;
}

export class Ranking extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // best が大きい順、同じなら先に達した順
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS scores (device TEXT PRIMARY KEY, name TEXT, best INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS scores_order ON scores (best DESC, at ASC);
      CREATE TABLE IF NOT EXISTS blocked (device TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  /** 端末の最高の連勝数を記録する（今より大きいときだけ。名前は毎回最新にする）。block した端末は載せない */
  async report(device: string, name: string | null, best: number, at = Date.now()): Promise<void> {
    if (!Number.isInteger(best) || best < 1 || this.isBlocked(device)) return;
    this.sql.exec(
      `INSERT INTO scores (device, name, best, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (device) DO UPDATE SET
         name = excluded.name,
         at = CASE WHEN excluded.best > scores.best THEN excluded.at ELSE scores.at END,
         best = MAX(scores.best, excluded.best)`,
      device,
      name,
      best,
      at,
    );
  }

  /** 名前を変えた端末の行の名前だけを替える（載っていなければ何もしない） */
  async rename(device: string, name: string | null): Promise<void> {
    this.sql.exec("UPDATE scores SET name = ? WHERE device = ?", name, device);
  }

  /** 上位 limit 件と、device の順位（同じ連勝数は同じ順位） */
  async top(device: string | null, limit = RANKING_TOP): Promise<RankingResponse> {
    const rows = this.sql
      .exec<{ device: string; name: string | null; best: number }>("SELECT device, name, best FROM scores ORDER BY best DESC, at ASC LIMIT ?", limit)
      .toArray();
    const top: RankEntry[] = rows.map((r) => {
      const e: RankEntry = { rank: this.rankOf(r.best), name: r.name, best: r.best };
      if (device !== null && r.device === device) e.me = true;
      return e;
    });
    const total = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scores").one().n;
    const mine = device === null ? [] : this.sql.exec<{ best: number }>("SELECT best FROM scores WHERE device = ?", device).toArray();
    return { top, me: mine.length > 0 ? { rank: this.rankOf(mine[0].best), best: mine[0].best } : null, total };
  }

  /** 管理用: 名前に q を含む行（q が空なら上位）を端末 ID つきで */
  async adminList(q: string, limit = 100): Promise<AdminScore[]> {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return this.sql
      .exec<{ device: string; name: string | null; best: number; at: number; blocked: number }>(
        `SELECT s.device, s.name, s.best, s.at, (b.device IS NOT NULL) AS blocked FROM scores s LEFT JOIN blocked b ON b.device = s.device
         WHERE ? = '' OR s.name LIKE ? ESCAPE '\\' ORDER BY s.best DESC, s.at ASC LIMIT ?`,
        q,
        like,
        limit,
      )
      .toArray()
      .map((r) => ({ ...r, blocked: r.blocked === 1 }));
  }

  /** 管理用: 端末の行を消す。block なら以後の記録も載せない。消した行があれば true */
  async remove(device: string, block = false): Promise<boolean> {
    const n = this.sql.exec("DELETE FROM scores WHERE device = ?", device).rowsWritten;
    if (block) this.sql.exec("INSERT OR IGNORE INTO blocked (device, at) VALUES (?, ?)", device, Date.now());
    return n > 0;
  }

  /** 管理用: block を外す */
  async unblock(device: string): Promise<void> {
    this.sql.exec("DELETE FROM blocked WHERE device = ?", device);
  }

  private isBlocked(device: string): boolean {
    return this.sql.exec("SELECT 1 FROM blocked WHERE device = ?", device).toArray().length > 0;
  }

  /** best の順位（より大きい best の端末の数 + 1） */
  private rankOf(best: number): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scores WHERE best > ?", best).one().n + 1;
  }
}
