// 1 手ごとの制限時間の時計（DOM なし）。手番が来るたびに戻し、演出中・メニュー表示中などは止める。
// 時刻は now()（既定は Date.now）の差で数えるので、タブを裏に回した・スリープから戻ったときも経過した分だけ減っている。
// 選択肢と CPU の強さごとの既定はここ（オンラインの部屋の制限時間の選択肢は net/protocol.ts の TURN_SECONDS）。

import type { CpuLevel } from "../engine/cpu";
import { TURN_SECONDS, type TurnSeconds } from "../net/protocol";

/** CPU 対戦の「強さに合わせる」の制限時間（秒。0 は制限なし）。強いほど短い */
export const CPU_TURN_SECONDS: Record<CpuLevel, TurnSeconds> = { easy: 0, normal: 45, hard: 20 };
/** 同じ端末の 2 人対戦・オンライン対戦の既定 */
export const DEFAULT_MULTI_SECONDS: TurnSeconds = 45;

/** 設定メニューの制限時間（CPU 対戦は "auto" = 強さに合わせる、ほかは秒の文字列） */
export type CpuTime = "auto" | `${TurnSeconds}`;
export type MultiTime = `${TurnSeconds}`;

export const isTurnSeconds = (n: unknown): n is TurnSeconds => (TURN_SECONDS as readonly unknown[]).includes(n);
export const isMultiTime = (v: unknown): v is MultiTime => TURN_SECONDS.some((t) => String(t) === v);
export const isCpuTime = (v: unknown): v is CpuTime => v === "auto" || isMultiTime(v);

/** CPU 対戦の制限時間（秒）。"auto" は強さに合わせる */
export function cpuTurnSeconds(time: CpuTime, level: CpuLevel): TurnSeconds {
  return time === "auto" ? CPU_TURN_SECONDS[level] : (Number(time) as TurnSeconds);
}

/** 残りがこの秒数以下で時計の色を変える（琥珀 → 赤） */
export const CLOCK_WARN_SEC = 10;
export const CLOCK_DANGER_SEC = 5;

/** 制限時間の短い表示（例: 「45 秒」「なし」） */
export function turnSecondsText(sec: number): string {
  return sec > 0 ? `${sec} 秒` : "なし";
}

/** 残り時間の表示（秒の切り上げ。例: 45 → "45"、90 → "1:30"） */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : String(s);
}

/** 残り時間の段階（色）。ok: ふつう / warn: 少ない / danger: わずか */
export function clockLevel(ms: number): "ok" | "warn" | "danger" {
  const s = Math.ceil(ms / 1000);
  if (s <= CLOCK_DANGER_SEC) return "danger";
  if (s <= CLOCK_WARN_SEC) return "warn";
  return "ok";
}

/**
 * 手番の時計。key（局面の手数など）が変わったら制限時間から数え直す。
 * 止めている間は残りを持ち、動かすと今から数える（止めていた時間は減らない）
 */
export class TurnClock {
  private key: string | null = null;
  private limit = 0;
  /** 動いているときの締め切り（now() の値）。止めているときは null */
  private deadline: number | null = null;
  /** 止めているときの残り */
  private left = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 手番 key を limitMs で数え始める（止めた状態）。同じ key なら何もしない（残りを保つ） */
  reset(key: string, limitMs: number): void {
    if (this.key === key && this.limit === limitMs) return;
    this.key = key;
    this.limit = limitMs;
    this.deadline = null;
    this.left = limitMs;
  }

  /**
   * サーバーの締め切りに合わせる（オンライン対戦。画面は計るだけで、時間切れの手はサーバーが打つ）。
   * deadline は now() の値。サーバーの締め切りは猶予を足してあるので、残りの表示は limitMs で頭打ちにする
   */
  follow(key: string, limitMs: number, deadline: number): void {
    this.key = key;
    this.limit = limitMs;
    this.deadline = deadline;
    this.left = 0;
  }

  /** 時計を外す（制限なし・対局がない） */
  clear(): void {
    this.key = null;
    this.limit = 0;
    this.deadline = null;
    this.left = 0;
  }

  /** 数えている手番（外していれば null） */
  get current(): string | null {
    return this.key;
  }

  get limitMs(): number {
    return this.limit;
  }

  get running(): boolean {
    return this.deadline !== null;
  }

  /** 動かす・止める（同じ状態なら何もしない） */
  setRunning(on: boolean): void {
    if (this.key === null || on === this.running) return;
    if (on) {
      this.deadline = this.now() + this.left;
    } else {
      this.left = this.remaining();
      this.deadline = null;
    }
  }

  /** 残り（ミリ秒。0 以上・制限時間以下） */
  remaining(): number {
    if (this.key === null) return 0;
    return Math.min(this.limit, Math.max(0, this.deadline === null ? this.left : this.deadline - this.now()));
  }

  /** 時間切れ（数えている手番があり、残りが 0） */
  get expired(): boolean {
    return this.key !== null && this.limit > 0 && this.remaining() <= 0;
  }
}
