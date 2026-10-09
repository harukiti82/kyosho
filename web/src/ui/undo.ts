// 待った（CPU 対戦のイージーだけ）。人間が打つ直前の局面を積んでおき、自分の直前の手とそれに続く CPU の応手をまとめて戻す。
// GameState はイミュータブルなので、局面はそのまま覚えて差し替えるだけ（ルールの計算はしない。DOM なし）。

import type { GameState } from "../engine/game";
import type { Player } from "../engine/rules";

/** 1 局で待ったできる回数 */
export const UNDO_LIMIT = 3;

export class Undo {
  /** 人間が打つ直前の局面（古い順） */
  private stack: GameState[] = [];
  /** 残りの回数 */
  left: number;

  constructor(limit = UNDO_LIMIT) {
    this.left = limit;
  }

  /** 人間 human が打つ直前の局面 before を覚える（人間の手番でなければ覚えない） */
  record(before: GameState, human: Player) {
    if (before.turn === human && !before.result) this.stack.push(before);
  }

  /**
   * 局面 g で待ったできるか: 残りがあり、戻る局面があり、終局前で人間の手番（CPU の手番・終局後は押せない）。
   * CPU が先手の初手は、人間が打つ前の局面に入らないので戻らない
   */
  canUndo(g: GameState, human: Player): boolean {
    return this.left > 0 && this.stack.length > 0 && !g.result && g.turn === human;
  }

  /** 自分の直前の手の前の局面（人間の手番）に戻す。回数を 1 減らす。待ったできなければ null */
  undo(g: GameState, human: Player): GameState | null {
    if (!this.canUndo(g, human)) return null;
    this.left--;
    return this.stack.pop()!;
  }
}
