// 挟将のルール定数（RULES.md v0.4）。UI に依存しない。

export type Player = 0 | 1;
export type PieceKind = "fu" | "kaku" | "gin" | "kin" | "hi";

export interface PieceSpec {
  kind: PieceKind;
  /** 表示名（1 文字） */
  name: string;
  /** 盤上の数値 */
  value: number;
  /** この駒を置いた手の攻撃で「返した駒の最大値」に掛ける倍率（角のみ 2） */
  mult: number;
}

export const PIECES: Record<PieceKind, PieceSpec> = {
  fu: { kind: "fu", name: "歩", value: 1, mult: 1 },
  kaku: { kind: "kaku", name: "角", value: 1, mult: 2 },
  gin: { kind: "gin", name: "銀", value: 2, mult: 1 },
  kin: { kind: "kin", name: "金", value: 3, mult: 1 },
  hi: { kind: "hi", name: "飛", value: 5, mult: 1 },
};

/** 表示・走査の順序 */
export const KIND_ORDER: readonly PieceKind[] = ["fu", "kaku", "gin", "kin", "hi"];

/** 攻撃の枚数ボーナス = 返した枚数 ÷ COUNT_DIV（切り捨て） */
export const COUNT_DIV = 4;
/** 回復 = max(0, min(置いた駒, 端の自駒) − HEAL_MINUS) */
export const HEAL_MINUS = 1;

export type Hand = Record<PieceKind, number>;

export interface Rules {
  /** 追加ルール「角」を使うか */
  kaku: boolean;
  /** 初期の持ち駒（両者共通） */
  hand: Hand;
  /** 初期体力 [先手, 後手] */
  hp: [number, number];
}

export interface RuleOptions {
  kaku: boolean;
}

export function makeRules(opts: RuleOptions): Rules {
  if (opts.kaku) {
    // 歩 2 個を角 2 個に差し替え、後手ボーナスなし
    return { kaku: true, hand: { fu: 12, kaku: 2, gin: 10, kin: 6, hi: 2 }, hp: [65, 65] };
  }
  return { kaku: false, hand: { fu: 14, kaku: 0, gin: 10, kin: 6, hi: 2 }, hp: [65, 66] };
}

export const PLAYER_NAME: Record<Player, string> = { 0: "先手", 1: "後手" };
