// 着手の手応え（ダメージの段階）と終局の成績。ルール計算はせず、エンジンの棋譜（MoveEvent）を読むだけ。
// DOM に依存しない（Vitest で直接テストする）。

import type { GameState, MoveEvent } from "../engine/game";
import { other, type RuleSet } from "../engine/rules";

/** 演出の段階。small は現状どおり（数字だけ） */
export type Tier = "small" | "mid" | "big" | "huge";

/**
 * 段階の閾値（その手のダメージ合計 ÷ 受けた側の体力上限）。この値「以上」でその段階になる。
 * 体力はプリセットで 20〜130 と違うので、割合で決めてどのプリセットでも同じ感覚にする
 */
export const TIER_THRESHOLDS = { mid: 0.05, big: 0.1, huge: 0.2 } as const;

/** 段階の順序（「会心」以上の判定などに使う） */
export const TIER_RANK: Record<Tier, number> = { small: 0, mid: 1, big: 2, huge: 3 };

/** その手のダメージの内訳 */
export interface HitBreakdown {
  /** 合計（返した駒 ＋ 端の駒の上乗せ ＋ 隠し王の罰） */
  total: number;
  /** 返した（取った）駒の分 */
  base: number;
  /** 端の駒の上乗せ */
  anchor: number;
  /** 隠し王の罰（体力が減る分。即負けなら 0） */
  penalty: number;
}

/** 手のダメージの内訳。上乗せは端の駒の数字（対局中は変わらない）、返した駒の分は残り */
export function hitOf(rules: RuleSet, m: MoveEvent): HitBreakdown {
  const anchor = (m.anchors ?? []).reduce((n, a) => n + rules.values[a.kind], 0);
  const penalty = m.king?.penalty ?? 0;
  return { total: m.damage + penalty, base: m.damage - anchor, anchor, penalty };
}

/**
 * 画面に出す体力。エンジンの体力は決着の一手で 0 を下回ることがある（残りを超えるダメージ・王の罰をそのまま引く。
 * sim と同じ値で、棋譜の再生テストが突き合わせる）ので、表示だけ 0 で止める
 */
export const shownHp = (hp: number) => Math.max(0, hp);

/** 手の段階。王を返した手は特大。それ以外は合計 ÷ 受けた側の体力上限（RuleSet.hp）で決める */
export function tierOf(rules: RuleSet, m: MoveEvent): Tier {
  if (m.king) return "huge";
  const { total } = hitOf(rules, m);
  if (total <= 0) return "small";
  const ratio = total / rules.hp[other(m.player)];
  if (ratio >= TIER_THRESHOLDS.huge) return "huge";
  if (ratio >= TIER_THRESHOLDS.big) return "big";
  if (ratio >= TIER_THRESHOLDS.mid) return "mid";
  return "small";
}

/**
 * 段階の文言。attack は攻めた側（自分・2 人対戦の手番の人）、hurt は CPU から受けたとき。
 * 王を返した手は専用の文言
 */
export const TIER_TEXT: Record<"attack" | "hurt", Record<Exclude<Tier, "small">, string> & { king: string }> = {
  attack: { mid: "ナイス！", big: "会心！", huge: "痛恨！", king: "王を討った！" },
  hurt: { mid: "被弾！", big: "大ダメージ！", huge: "痛恨の一撃！", king: "王を討たれた！" },
};

/** 演出の文言（small はなし） */
export function tierText(tier: Tier, m: MoveEvent, side: "attack" | "hurt"): string | null {
  if (tier === "small") return null;
  return m.king ? TIER_TEXT[side].king : TIER_TEXT[side][tier];
}

/** プレイヤー 1 人分の成績 */
export interface PlayerStats {
  /** 最大ダメージの手（同じなら早い手）。ダメージを与えていなければ null */
  best: { move: MoveEvent; hit: HitBreakdown } | null;
  /** 「会心」（big）以上の手の数 */
  bigHits: number;
  /** 端の駒の上乗せの合計 */
  anchorTotal: number;
  /** 相手の王を返した（取った） */
  kingHit: boolean;
}

/** 棋譜から両者の成績を集計する [先手, 後手] */
export function statsOf(g: Pick<GameState, "rules" | "history">): [PlayerStats, PlayerStats] {
  const empty = (): PlayerStats => ({ best: null, bigHits: 0, anchorTotal: 0, kingHit: false });
  const out: [PlayerStats, PlayerStats] = [empty(), empty()];
  for (const e of g.history) {
    if (e.type !== "move") continue;
    const s = out[e.player];
    const hit = hitOf(g.rules, e);
    if (hit.total > 0 && (!s.best || hit.total > s.best.hit.total)) s.best = { move: e, hit };
    if (TIER_RANK[tierOf(g.rules, e)] >= TIER_RANK.big) s.bigHits++;
    s.anchorTotal += hit.anchor;
    if (e.king) s.kingHit = true;
  }
  return out;
}
