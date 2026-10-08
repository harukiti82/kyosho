// 決着の演出の中身（勝ち・負け・引き分け、決着の理由の副題、接戦の励まし）。ルール計算はせず、エンジンの結果と棋譜を読むだけ。
// DOM に依存しない（Vitest で直接テストする）。

import { discCount } from "../engine/board";
import type { GameState } from "../engine/game";
import { other, PLAYER_NAME, type Player } from "../engine/rules";

/** 演出の種類。2 人対戦はどちらも人なので lose にならない */
export type OutcomeKind = "win" | "lose" | "draw";

/** 演出の基調の色。warm: CPU 対戦の勝利 / black・white: 2 人対戦で勝った側の駒色 / gloom: 敗北 / calm: 引き分け */
export type OutcomeTone = "warm" | "black" | "white" | "gloom" | "calm";

export interface Outcome {
  kind: OutcomeKind;
  tone: OutcomeTone;
  /** 2 人対戦で勝った側（駒の印を出す）。それ以外は null */
  winner: Player | null;
  /** 大きな文字（「勝利」「敗北」「引き分け」「先手の勝ち」） */
  title: string;
  /** 決着の理由 */
  subtitle: string;
  /** 接戦で負けたときの励まし。それ以外は null */
  cheer: string | null;
  /** 終局画面の「再戦」を強調する（負けたとき） */
  urgeRematch: boolean;
}

/** 誰の目線で演出するか（PlaySettings の mode と human） */
export interface OutcomeView {
  mode: "cpu" | "pvp";
  /** CPU 対戦で人間が持つ手番 */
  human: Player;
}

/** 接戦の目安: 差（体力判定の差・相手の残り体力）が自分の体力上限のこの割合（%）以下 */
export const CLOSE_PERCENT = 10;

/** 差が自分の体力上限の CLOSE_PERCENT% 以下（境界を含む）。小数の誤差を避けて整数で比べる */
export const isClose = (gap: number, myMaxHp: number) => gap * 100 <= myMaxHp * CLOSE_PERCENT;

/** 決着した局面の演出の中身。g.result が null なら null */
export function outcomeOf(g: Pick<GameState, "rules" | "history" | "hp" | "board" | "result">, view: OutcomeView): Outcome | null {
  const r = g.result;
  if (!r) return null;
  const [d0, d1] = discCount(g.board);
  const discs: [number, number] = [d0, d1];

  if (r.winner === null) {
    return {
      kind: "draw",
      tone: "calm",
      winner: null,
      title: "引き分け",
      subtitle: `体力 ${g.hp[0]}・石 ${d0} で並んだ`,
      cheer: null,
      urgeRematch: false,
    };
  }

  const w = r.winner;
  const l = other(w);
  // 決着の一手で王を討った（即負け、または王の罰を含む一手で体力 0）
  const last = g.history[g.history.length - 1];
  const byKing = r.reason === "king" || (r.reason === "ko" && last?.type === "move" && last.player === w && !!last.king);

  if (view.mode === "pvp") {
    const W = PLAYER_NAME[w];
    const L = PLAYER_NAME[l];
    let subtitle: string;
    if (byKing) subtitle = `${W}が${L}の王を討って決着`;
    else if (r.reason === "ko") subtitle = `${L}の体力を 0 にして撃破`;
    else if (r.byDiscs) subtitle = `体力が並び、石数 ${d0} 対 ${d1} で決着`;
    else subtitle = `体力判定 ${g.hp[0]} 対 ${g.hp[1]} で決着`;
    return { kind: "win", tone: w === 0 ? "black" : "white", winner: w, title: `${W}の勝ち`, subtitle, cheer: null, urgeRematch: false };
  }

  const me = view.human;
  const foe = other(me);
  const won = w === me;
  const vs = (a: readonly [number, number]) => `${a[me]} 対 ${a[foe]}`;
  let subtitle: string;
  let cheer: string | null = null;
  if (byKing) {
    subtitle = won ? "王を討って勝利" : "王を討たれて敗北";
  } else if (r.reason === "ko") {
    subtitle = won ? "体力 0 で撃破" : "体力 0 で撃破された";
    // 相手の残り体力が自分の体力上限の 10% 以下なら、あと少しだった
    if (!won && isClose(g.hp[foe], g.rules.hp[me])) cheer = `相手の残り体力 ${g.hp[foe]} の惜敗`;
  } else if (r.byDiscs) {
    subtitle = `体力が並び、石数 ${vs(discs)} で${won ? "勝利" : "敗北"}`;
    if (!won) cheer = `石 ${discs[foe] - discs[me]} 個差の惜敗`;
  } else {
    subtitle = `体力判定 ${vs(g.hp)} で${won ? "勝利" : "敗北"}`;
    const gap = g.hp[foe] - g.hp[me];
    if (!won && isClose(gap, g.rules.hp[me])) cheer = `${gap} 点差の惜敗`;
  }
  return won
    ? { kind: "win", tone: "warm", winner: null, title: "勝利", subtitle, cheer: null, urgeRematch: false }
    : { kind: "lose", tone: "gloom", winner: null, title: "敗北", subtitle, cheer, urgeRematch: true };
}
