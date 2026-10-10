// ダメージの段階に応じた画面の演出（文言・盤の揺れ・光の粒・画面の発光・被弾の赤い縁）。
// すべて画面に固定した演出層（#fx、overflow: hidden）か transform / opacity のアニメーションで行い、レイアウトを動かさない。
// Math.random は CPU の乱数と共有なので使わない（粒の向きは番号から決める）。

import { FULL_FLASH_MS, GAIN_TEXT_MS, GROW_MS, ORB_MS, ORB_STAGGER_MS } from "./gauge";
import { TIER_RANK, type Tier } from "./impact";
import { h } from "./dom";
import type { Outcome, OutcomeTone } from "./outcome";
import type { Player } from "../engine/rules";

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

/** 決着の演出の長さ（ミリ秒）。この後に終局画面を出す。動きを減らす設定では文字を読める間だけ */
export const FINALE_MS = 2300;
export const FINALE_REDUCED_MS = 1600;
export const finaleMs = (reduce: boolean) => (reduce ? FINALE_REDUCED_MS : FINALE_MS);
/** 紙吹雪の数（控えめに） */
export const CONFETTI = 28;

export interface FinaleOptions {
  outcome: Outcome;
  reduce: boolean;
  /** 演出をタップ／クリックした（終局画面へ進める） */
  onSkip: () => void;
}

/**
 * 先手・後手の抽選の演出の長さ（ミリ秒）。石が回りながら上がって落ちる（TOSS_LAND_MS）→ 上を向いた色と結果を見せる。
 * 動きを減らす設定では回さず、結果を読める間だけ。サーバーが最初の締め切りに足す TOSS_GRACE_MS（net/protocol.ts）を超えない
 */
export const TOSS_MS = 1900;
export const TOSS_REDUCED_MS = 900;
export const TOSS_LAND_MS = 1100;
export const tossMs = (reduce: boolean) => (reduce ? TOSS_REDUCED_MS : TOSS_MS);
/** 石が回る回数（決まった数。結果の色に半回転を足す） */
export const TOSS_TURNS = 4;
/** 石の最後の角度（X 軸の回転）。表（0 度）が黒 = 先手、裏（180 度）が白 = 後手 */
export const tossAngle = (up: Player) => TOSS_TURNS * 360 + (up === 1 ? 180 : 0);

export interface TossOptions {
  /** 上を向く色（0: 黒 = 先手 / 1: 白 = 後手） */
  up: Player;
  /** 結果の上に添える主語（「あなた」） */
  who: string;
  /** 結果の語（「先手」「後手」） */
  title: string;
  reduce: boolean;
  /** 演出をタップ／クリックした（対局へ進める） */
  onSkip: () => void;
}

/** スキルを使った演出の長さ（カードが表を向いて名前を見せ、消える）。この間は入力・CPU を待たせる */
export const SKILL_CAST_MS = 1100;
export const SKILL_CAST_REDUCED_MS = 700;
export const skillCastMs = (reduce: boolean) => (reduce ? SKILL_CAST_REDUCED_MS : SKILL_CAST_MS);

export interface SkillCastOptions {
  /** カードの面（skillui.ts の tarotCard） */
  card: HTMLElement;
  /** 使った人（名札の短い名前）と石の色 */
  who: string;
  owner: Player;
  /** 使った人の名札が盤の上の側（カードは上から来る） */
  fromTop: boolean;
  reduce: boolean;
}

export interface GaugeFxOptions {
  /** 溜まった人の名札のゲージ（.ps-gauge）と、カードの札（.plate-skill） */
  gauge: HTMLElement;
  chip: HTMLElement;
  /** 演出の後のゲージの割合（0〜1。光の粒と「+N」が向かう先端） */
  to: number;
  /** 「+N」。出さないなら null */
  text: string | null;
  /** 溜めマスの点が入ったマス（光の粒が飛び出す） */
  orbs: HTMLElement[];
  /** バーが伸び始めるまでの遅れ（ミリ秒）。「+N」はここで出る */
  growAt: number;
  /** この手で満タンになった（伸び切ったところで札の周りに光の輪） */
  full: boolean;
}

export class Fx {
  private timers: number[] = [];
  private finaleEl: HTMLElement | null = null;
  private tossEl: HTMLElement | null = null;

  constructor(private readonly layer: HTMLElement) {}

  /** 演出を打ち切る（新しい対局） */
  clear() {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.finaleEl = null;
    this.tossEl = null;
    this.layer.replaceChildren();
  }

  /**
   * 先手・後手の抽選の演出。盤の石（表が黒・裏が白）をコインのように投げ、回りながら落ちて上を向いた色と結果の語を出す。
   * 画面全体を覆ってタップ／クリックを受け、対局へ進める。動きを減らす設定では回さず、上を向いた石と結果だけ
   */
  toss(o: TossOptions) {
    this.clear();
    const root = h("div", { class: `fx-toss${o.reduce ? " reduce" : ""}`, attrs: { "data-up": String(o.up) } });
    root.style.setProperty("--toss-end", `${tossAngle(o.up)}deg`);
    root.style.setProperty("--toss-ms", `${TOSS_MS}ms`);
    root.style.setProperty("--toss-land", `${TOSS_LAND_MS}ms`);
    root.append(
      h("div", { class: "toss-stage" }, [
        h("div", { class: "toss-shadow" }),
        h("div", { class: "toss-ring" }),
        h("div", { class: "toss-flight" }, [
          h("div", { class: "toss-coin" }, [h("span", { class: "toss-face p0" }), h("span", { class: "toss-face p1" })]),
        ]),
      ]),
      h("div", { class: "toss-card" }, [h("p", { class: "toss-who", text: o.who }), h("p", { class: "toss-title", text: o.title })]),
    );
    // Enter・Esc・スペースでも飛ばせる（App.endToss）。画面の文は出さず、キーは title に置く
    root.title = "クリック・Enter で飛ばす";
    root.addEventListener("click", () => o.onSkip());
    this.layer.append(root);
    this.tossEl = root;
  }

  /**
   * スキルを使った演出: 使った人の側から裏向きのカードが現れて表を向き、名前と効果を見せて消える（タップは盤に通す）。
   * 動きを減らす設定では回さず、表のカードを出して消すだけ
   */
  skillCast(o: SkillCastOptions) {
    const ms = skillCastMs(o.reduce);
    const root = h("div", { class: `fx-skill p${o.owner}${o.fromTop ? " from-top" : ""}${o.reduce ? " reduce" : ""}`, attrs: { "data-skill": o.card.dataset.skill ?? "" } });
    root.style.setProperty("--cast-ms", `${ms}ms`);
    root.append(
      h("div", { class: "cast-flip" }, [h("div", { class: "cast-back" }), o.card]),
      h("p", { class: "cast-who" }, [h("span", { class: `fin-stone p${o.owner}`, attrs: { "aria-hidden": "true" } }), o.who]),
    );
    this.add(root, ms);
  }

  /**
   * スキルのゲージが溜まった演出（名札のバーが伸びるのは App 側の CSS）: 溜めマスから光の粒がゲージの先端へ飛び、
   * 伸び始めに「+N」が先端から浮かび、満タンになったら札の周りに光の輪が広がる。入力は止めない（fxLock とは無関係）。
   * 動きを減らす設定では呼ばない
   */
  gaugeGain(o: GaugeFxOptions) {
    const g = o.gauge.getBoundingClientRect();
    const tipX = g.left + g.width * Math.min(1, Math.max(0, o.to));
    const tipY = g.top + g.height / 2;
    o.orbs.forEach((cell, i) => {
      const c = cell.getBoundingClientRect();
      const x = c.left + c.width / 2;
      const y = c.top + c.height / 2;
      const orb = h("span", { class: "fx-gauge-orb" });
      orb.style.left = `${x}px`;
      orb.style.top = `${y}px`;
      orb.style.setProperty("--dx", `${Math.round(tipX - x)}px`);
      orb.style.setProperty("--dy", `${Math.round(tipY - y)}px`);
      orb.style.setProperty("--orb-ms", `${ORB_MS}ms`);
      orb.style.animationDelay = `${i * ORB_STAGGER_MS}ms`;
      this.add(orb, ORB_MS + i * ORB_STAGGER_MS + 100);
      // 粒が出るマスも一瞬光らせる（溜まる場所だと分かるように）
      const ring = h("span", { class: "fx-zone-ring" });
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.style.width = ring.style.height = `${Math.round(c.width * 0.9)}px`;
      ring.style.animationDelay = `${i * ORB_STAGGER_MS}ms`;
      this.add(ring, 600 + i * ORB_STAGGER_MS);
    });
    if (o.text) {
      const gain = h("span", { class: "fx-gauge-gain", text: o.text });
      // 画面の端で切れないよう寄せる
      gain.style.left = `${Math.min(Math.max(tipX, 24), window.innerWidth - 24)}px`;
      gain.style.top = `${g.top}px`;
      gain.style.setProperty("--gain-ms", `${GAIN_TEXT_MS}ms`);
      gain.style.animationDelay = `${o.growAt}ms`;
      this.add(gain, o.growAt + GAIN_TEXT_MS + 100);
    }
    if (o.full) {
      const r = o.chip.getBoundingClientRect();
      const flare = h("span", { class: "fx-gauge-flare" });
      flare.style.left = `${r.left}px`;
      flare.style.top = `${r.top}px`;
      flare.style.width = `${r.width}px`;
      flare.style.height = `${r.height}px`;
      flare.style.setProperty("--flare-ms", `${FULL_FLASH_MS}ms`);
      flare.style.animationDelay = `${o.growAt + GROW_MS}ms`;
      this.add(flare, o.growAt + GROW_MS + FULL_FLASH_MS + 100);
    }
  }

  /** 抽選の演出を消す */
  endToss() {
    this.tossEl?.remove();
    this.tossEl = null;
  }

  /**
   * 決着の演出。勝利は紙吹雪と暖色（2 人対戦は勝った側の駒色）の発光、敗北は彩度を落として静かに沈む、引き分けは穏やかな幕。
   * 画面全体を覆ってタップ／クリックを受け、終局画面へ進める（盤や見出しのボタンには届かない）。
   * 動きを減らす設定では文字と副題だけ
   */
  finale(o: FinaleOptions) {
    // 最後の一手の演出の残り（動きを減らす設定で時間で消す文言など）を片付けてから出す
    this.clear();
    const oc = o.outcome;
    const root = h("div", {
      class: `fx-finale ${oc.kind} tone-${oc.tone}${o.reduce ? " reduce" : ""}`,
      attrs: { "data-kind": oc.kind },
    });
    if (!o.reduce) {
      if (oc.kind === "win") root.append(h("div", { class: "fx-glow" }), confetti(oc.tone));
      else if (oc.kind === "lose") root.append(h("div", { class: "fx-sink" }));
      else root.append(h("div", { class: "fx-calm" }));
    }
    root.append(
      h("div", { class: "fin-card" }, [
        oc.winner !== null ? h("span", { class: `fin-stone p${oc.winner}`, attrs: { "aria-hidden": "true" } }) : null,
        h("p", { class: "fin-title", text: oc.title }),
        h("p", { class: "fin-sub", text: oc.subtitle }),
        oc.cheer ? h("p", { class: "fin-cheer", text: oc.cheer }) : null,
        h("p", { class: "fin-skip", text: "タップで結果へ" }),
      ]),
    );
    // Enter・Esc・スペースでも飛ばせる（App.playFinale）。画面の文は短くし、キーは title に置く
    root.title = "クリック・Enter で結果へ";
    root.addEventListener("click", () => o.onSkip());
    this.layer.append(root);
    this.finaleEl = root;
  }

  /** 決着の演出を消す */
  endFinale() {
    this.finaleEl?.remove();
    this.finaleEl = null;
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

/** 紙吹雪。位置・揺れ・回転・速さは番号から決める（Math.random を使わない）。色は基調（tone）ごとに CSS で決める */
function confetti(tone: OutcomeTone): HTMLElement {
  const box = h("div", { class: `fx-confetti tone-${tone}` });
  for (let i = 0; i < CONFETTI; i++) {
    const p = h("span", { class: `fx-confetto c${i % 5}` });
    // 黄金比で横に散らす
    p.style.left = `${(((i * 0.618034) % 1) * 96 + 2).toFixed(1)}%`;
    p.style.setProperty("--drift", `${((i * 37) % 9) * 12 - 48}px`);
    p.style.setProperty("--spin", `${(i % 2 ? 1 : -1) * (360 + ((i * 53) % 360))}deg`);
    p.style.animationDuration = `${1500 + ((i * 7) % 5) * 130}ms`;
    p.style.animationDelay = `${(i % 7) * 60}ms`;
    box.append(p);
  }
  return box;
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
