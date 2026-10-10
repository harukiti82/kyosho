// CPU 対戦と同じ端末の 2 人対戦の通算の戦績（この端末の localStorage）。DOM に依存しない（Vitest で直接テストする）。
// CPU 対戦は強さごとに人間から見た勝ち・負け・引き分け、2 人対戦は人を区別できないので先手から見た勝ち・負け・引き分けを数える。
// オンライン対戦の通算はサーバーが部屋ごとに数える（room.ts）ので、ここでは扱わない。

import { CPU_LEVEL_NAME, type CpuLevel } from "../engine/cpu";
import type { Player } from "../engine/rules";
import type { KeyValueStore } from "../net/online";
import type { MatchRecord } from "../net/protocol";
import { recordText } from "./outcome";

/** localStorage のキー（中身は JSON の LocalRecord） */
export const RECORD_KEY = "kyosho:record";

const LEVELS: readonly CpuLevel[] = ["easy", "normal", "hard"];

export interface LocalRecord {
  /** CPU 対戦: 強さごとに人間から見た通算 */
  cpu: Record<CpuLevel, MatchRecord>;
  /** 同じ端末の 2 人対戦: 先手から見た通算（wins = 先手の勝ち、losses = 後手の勝ち） */
  pvp: MatchRecord;
}

/** 通算を数える対局の種類 */
export type RecordKey = { mode: "cpu"; level: CpuLevel } | { mode: "pvp" };

const zero = (): MatchRecord => ({ wins: 0, losses: 0, draws: 0 });

export const emptyRecord = (): LocalRecord => ({ cpu: { easy: zero(), normal: zero(), hard: zero() }, pvp: zero() });

/** 終えた対局の数 */
export const gamesOf = (r: MatchRecord) => r.wins + r.losses + r.draws;

const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

function readMatch(v: unknown): MatchRecord {
  if (typeof v !== "object" || v === null) return zero();
  const o = v as Record<string, unknown>;
  return { wins: count(o.wins), losses: count(o.losses), draws: count(o.draws) };
}

/**
 * 保存した通算を読む。保存がない・JSON として読めない・ストレージが使えないときは null。
 * 形が崩れた項目（数でない・負・小数）はその項目だけ 0 にする
 */
export function readRecord(store: KeyValueStore): LocalRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(RECORD_KEY) ?? "null");
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const cpu = (typeof o.cpu === "object" && o.cpu !== null ? o.cpu : {}) as Record<string, unknown>;
  const out = emptyRecord();
  for (const l of LEVELS) out.cpu[l] = readMatch(cpu[l]);
  out.pvp = readMatch(o.pvp);
  return out;
}

/** key の通算（CPU 対戦は人間から見た、2 人対戦は先手から見た） */
export const recordFor = (rec: LocalRecord, key: RecordKey): MatchRecord => (key.mode === "cpu" ? rec.cpu[key.level] : rec.pvp);

/** 誰から見た通算か（CPU 対戦は人間の手番、2 人対戦は先手） */
export const recordViewer = (key: RecordKey, human: Player): Player => (key.mode === "cpu" ? human : 0);

/** 決着を 1 局足した通算（元の値は変えない）。winner が null なら引き分け */
export function addResult(rec: LocalRecord, key: RecordKey, viewer: Player, winner: Player | null): LocalRecord {
  const cur = recordFor(rec, key);
  const next: MatchRecord =
    winner === null
      ? { ...cur, draws: cur.draws + 1 }
      : winner === viewer
        ? { ...cur, wins: cur.wins + 1 }
        : { ...cur, losses: cur.losses + 1 };
  return key.mode === "cpu" ? { ...rec, cpu: { ...rec.cpu, [key.level]: next } } : { ...rec, pvp: next };
}

/** 設定メニューに出す通算の一覧（数えた対局がある分だけ。例「ノーマル 3勝2敗」「2人対戦 先手3勝 後手2勝」） */
export function recordSummary(rec: LocalRecord): string[] {
  const out = LEVELS.filter((l) => gamesOf(rec.cpu[l]) > 0).map((l) => `${CPU_LEVEL_NAME[l]} ${recordText(rec.cpu[l])}`);
  const p = rec.pvp;
  if (gamesOf(p) > 0) out.push(`2人対戦 先手${p.wins}勝 後手${p.losses}勝${p.draws > 0 ? ` ${p.draws}分` : ""}`);
  return out;
}

/**
 * 通算の帳簿。保存が読めればそれを正とし（別のタブで数えた分も足す）、ストレージが使えないときはこの画面の間だけ覚える。
 * 壊れた保存は 0 から数え直し、次に数えたときに正しい形で上書きする
 */
export class RecordBook {
  private mem: LocalRecord;

  constructor(private readonly store: KeyValueStore) {
    this.mem = readRecord(store) ?? emptyRecord();
  }

  get(): LocalRecord {
    const saved = readRecord(this.store);
    if (saved) this.mem = saved;
    return this.mem;
  }

  /** 決着した対局を 1 局数える */
  add(key: RecordKey, viewer: Player, winner: Player | null) {
    this.mem = addResult(this.get(), key, viewer, winner);
    this.store.setItem(RECORD_KEY, JSON.stringify(this.mem));
  }

  /** 通算を消す（0 に戻す） */
  clear() {
    this.mem = emptyRecord();
    this.store.setItem(RECORD_KEY, JSON.stringify(this.mem));
  }
}
