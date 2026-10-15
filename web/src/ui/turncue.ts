// 手番の知らせ（「あなたの番」）を出す時を決める。DOM なし。
// 局面を描くたびに see で今の手番を見せ、新しい手番が始まったら知らせを「出す予定」にする。
// 出すのは、操作できる（演出・メニュー・カードを選ぶ画面などで止まっていない）ときに take が true を返した 1 回だけ。

import type { Player } from "../engine/rules";

/** 知らせを出している長さ（ミリ秒）。動きを減らす設定では動かさず、読める間だけ */
export const TURN_CUE_MS = 1200;
export const TURN_CUE_REDUCED_MS = 900;
export const turnCueMs = (reduce: boolean) => (reduce ? TURN_CUE_REDUCED_MS : TURN_CUE_MS);

/** 見ている局面の手番 */
export interface TurnPoint {
  /** 対局の通し番号（App.gameNo。再戦・新しい対局で増える） */
  game: number;
  /** 打った手数（GameState.ply） */
  ply: number;
  turn: Player;
  /** 連続行動の 2 手目（同じ手番の続き） */
  second: boolean;
  /** 終局した */
  over: boolean;
}

/**
 * prev から cur で新しい手番が始まったか。対局が替わった・手番の人が替わった・手数が進んだ（相手のパスで続けて打つ）とき。
 * 連続行動の 2 手目・スキルを使っただけ（手数は同じ）・待ったと巻き戻し（手数が戻る）は同じ手番の続き
 */
export function isNewTurn(prev: TurnPoint | null, cur: TurnPoint): boolean {
  if (!prev || prev.game !== cur.game || prev.turn !== cur.turn) return true;
  return cur.ply > prev.ply && !cur.second;
}

export class TurnWatch {
  private last: TurnPoint | null = null;
  /** 知らせを出す予定 */
  private due = false;
  /** 次に見る局面の手番は知らせない（オンラインの再読み込み・つなぎ直しの直後） */
  private hushed = false;

  /** 新しい対局（前の手番を忘れる） */
  reset() {
    this.last = null;
    this.due = false;
    this.hushed = false;
  }

  /** 次に見る局面で始まっていた手番は知らせない */
  hush() {
    this.hushed = true;
  }

  /**
   * 局面を見る（描くたび）。target はこの手番の人に知らせるか（CPU 対戦・オンラインは自分、2 人対戦は両者、遊び方のステップは知らせない）。
   * 新しい手番なら true（出ている知らせを消す合図）
   */
  see(cur: TurnPoint, target: boolean): boolean {
    const fresh = isNewTurn(this.last, cur);
    if (fresh) this.due = target && !this.hushed;
    if (cur.over) this.due = false;
    this.hushed = false;
    this.last = cur;
    return fresh;
  }

  /** 出す予定で、今出せる（ready）なら true を返して予定を消す */
  take(ready: boolean): boolean {
    if (!this.due || !ready) return false;
    this.due = false;
    return true;
  }
}
