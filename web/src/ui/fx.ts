// ダメージの段階に応じた画面の演出（文言・盤の揺れ・光の粒・画面の発光・被弾の赤い縁）。
// すべて画面に固定した演出層（#fx、overflow: hidden）か transform / opacity のアニメーションで行い、レイアウトを動かさない。
// Math.random は CPU の乱数と共有なので使わない（粒の向きは番号から決める）。

import { TIER_RANK, type Tier } from "./impact";
import { h } from "./dom";

/** 演出の長さ（ミリ秒）。step: 返す駒を順にめくる間隔 / burstAt: 文言・粒を出す時刻 / hold: 入力と CPU を待たせる長さ */
export interface FxTiming {
  step: number;
  burstAt: number;
  hold: number;
}

/** 大・特大で入力と CPU を待たせる上限 */
export const MAX_HOLD_MS = 1500;
/** 特大の溜め（返す駒を順にめくる）の上限 */
const BUILD_MS = 700;

/**
 * 段階と返した駒の数から演出の長さを決める。小・中は待たせない（今の CPU の待ち時間に収まる）。
 * 特大は返す駒を順にめくってから弾ける。reduce（動きを減らす設定）では溜めを省き、文言を読める間だけ待たせる
 */
export function fxTiming(tier: Tier, targets: number, reduce: boolean): FxTiming {
  if (tier === "small" || tier === "mid") return { step: 0, burstAt: 0, hold: 0 };
  if (reduce) return { step: 0, burstAt: 0, hold: tier === "huge" ? 900 : 700 };
  if (tier === "big") return { step: 0, burstAt: 0, hold: 950 };
  const step = targets > 1 ? Math.min(110, Math.floor(BUILD_MS / targets)) : 0;
  const burstAt = Math.min(BUILD_MS, step * targets + 150);
  return { step, burstAt, hold: Math.min(MAX_HOLD_MS, burstAt + 750) };
}

export interface BurstOptions {
  tier: Tier;
  /** CPU から受けた（赤系の被弾演出） */
  hurt: boolean;
  text: string | null;
  /** 置いたマス（粒が飛び散る中心） */
  cell: HTMLElement;
  board: HTMLElement;
  /** 受けた側の体力カード */
  victim: HTMLElement;
  /** 弾けるまでの遅れ（特大の溜め） */
  delay: number;
  reduce: boolean;
}

/** 粒の数（低性能の端末でも重くしないよう控えめに） */
const SPARKS: Partial<Record<Tier, number>> = { big: 10, huge: 18 };

export class Fx {
  private timers: number[] = [];

  constructor(private readonly layer: HTMLElement) {}

  /** 演出を打ち切る（新しい対局） */
  clear() {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.layer.replaceChildren();
  }

  burst(o: BurstOptions) {
    if (o.tier === "small") return;
    if (o.delay > 0) this.later(() => this.run(o), o.delay);
    else this.run(o);
  }

  private later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== id);
      fn();
    }, ms);
    this.timers.push(id);
  }

  /** 演出層に要素を出し、ms 後に消す（動きを減らす設定ではアニメーションが止まるので時間で消す） */
  private add(el: HTMLElement, ms: number) {
    this.layer.append(el);
    this.later(() => el.remove(), ms);
  }

  private run(o: BurstOptions) {
    const side = o.hurt ? "hurt" : "attack";
    const rank = TIER_RANK[o.tier];
    if (o.text) {
      // 文言は盤の中央（盤が画面外にあるときは画面内に寄せる）
      const b = o.board.getBoundingClientRect();
      const y = Math.min(Math.max(b.top + b.height / 2, 90), window.innerHeight - 90);
      const banner = h("div", { class: `fx-banner ${side} t-${o.tier}`, text: o.text });
      banner.style.left = `${b.left + b.width / 2}px`;
      banner.style.top = `${y}px`;
      this.add(banner, o.tier === "mid" ? 1000 : 1300);
    }
    if (o.reduce) return;
    restartClass(o.victim, `fx-hurt t-${o.tier}`);
    if (rank >= TIER_RANK.big) {
      restartClass(o.board, `fx-shake t-${o.tier}`);
      this.sparks(o, side);
    }
    if (o.tier === "huge") this.add(h("div", { class: `fx-flash ${side}` }), 900);
    if (o.hurt) this.add(h("div", { class: `fx-vignette t-${o.tier}` }), 1300);
  }

  private sparks(o: BurstOptions, side: string) {
    const n = SPARKS[o.tier] ?? 0;
    const c = o.cell.getBoundingClientRect();
    const reach = Math.max(60, c.width * (o.tier === "huge" ? 3.2 : 2.2));
    for (let i = 0; i < n; i++) {
      // 黄金角で散らし、距離と大きさは番号で揺らす
      const a = i * 2.39996;
      const d = reach * (0.55 + ((i * 7) % 5) / 10);
      const s = h("span", { class: `fx-spark ${side}${i % 3 === 0 ? " big" : ""}` });
      s.style.left = `${c.left + c.width / 2}px`;
      s.style.top = `${c.top + c.height / 2}px`;
      s.style.setProperty("--dx", `${Math.round(Math.cos(a) * d)}px`);
      s.style.setProperty("--dy", `${Math.round(Math.sin(a) * d)}px`);
      s.style.animationDelay = `${(i % 4) * 25}ms`;
      this.add(s, 1000);
    }
  }
}

/** 同じアニメーションをもう一度再生できるよう、クラスを外してから付け直す（段階の付いたクラスは入れ替える） */
function restartClass(el: HTMLElement, cls: string) {
  const [base] = cls.split(" ");
  for (const c of [...el.classList]) if (c === base || c.startsWith("t-")) el.classList.remove(c);
  void el.offsetWidth;
  el.classList.add(...cls.split(" "));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 消音ボタンのスピーカーのアイコン（消音中は × を付ける） */
export function speakerIcon(muted: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = (d: string) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  };
  path("M4 9h4l5-4v14l-5-4H4z");
  if (muted) path("M16 9l5 6M21 9l-5 6");
  else path("M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12");
  return svg;
}
