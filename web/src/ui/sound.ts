// 効果音。音声ファイルは使わず Web Audio API で合成する。
// 自動再生の制限に合わせ、AudioContext は最初のユーザー操作（pointerdown / keydown）の中で作る。それまでの音は鳴らさない。
// 消音の状態は localStorage に保存する（使えない環境では保存せずに動く）。

import type { Tier } from "./impact";
import type { OutcomeKind } from "./outcome";

const MUTE_KEY = "kyosho.muted";

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(on: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, on ? "1" : "0");
  } catch {
    // 保存できない環境（プライベートモードなど）では、この画面の間だけ有効
  }
}

/** 音の形（周波数は開始 → 終了へ指数的に変える） */
interface Tone {
  freq: number;
  to?: number;
  type?: OscillatorType;
  /** 開始の遅れ・長さ（秒） */
  at?: number;
  dur: number;
  gain: number;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private gestured = false;
  /** 最後にカードに合わせた音を鳴らした時刻（AudioContext の秒） */
  private lastHover = -1;
  muted = readMuted();

  constructor() {
    const unlock = () => {
      this.gestured = true;
      this.ensure();
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
  }

  setMuted(on: boolean) {
    this.muted = on;
    writeMuted(on);
    if (!on) this.ensure();
  }

  /** ユーザー操作の後で、消音でなければ AudioContext を用意する */
  private ensure(): AudioContext | null {
    if (!this.gestured || this.muted) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      // 音を重ねても割れないよう、全体をコンプレッサーに通す
      const comp = this.ctx.createDynamicsCompressor();
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(comp);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private tone(t: Tone, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const start = ctx.currentTime + delay + (t.at ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = t.type ?? "sine";
    osc.frequency.setValueAtTime(t.freq, start);
    if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(t.gain, start + Math.min(0.015, t.dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
    osc.connect(g).connect(this.master);
    osc.start(start);
    osc.stop(start + t.dur + 0.05);
  }

  /** ノイズ（打撃・きらめきの成分）。freq は帯域通過フィルタの中心 */
  private noise(dur: number, gain: number, freq: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (!this.noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 1.5);
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      // Math.random は CPU の乱数と共有なので使わない（e2e は Math.random を種付きにして CPU の手を再現する）
      let x = 0x2545f491;
      for (let i = 0; i < len; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        d[i] = (x >>> 0) / 2147483648 - 1;
      }
    }
    const start = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(start);
    src.stop(start + dur + 0.05);
  }

  /** 駒を置く音（短い木の音） */
  place() {
    if (this.muted) return;
    this.tone({ freq: 320, to: 140, type: "triangle", dur: 0.09, gain: 0.35 });
    this.noise(0.04, 0.15, 1800);
  }

  /** 返す（取る）音。駒ごとに少しずつ高くし、step 秒ずつずらす */
  flip(count: number, step = 0.06) {
    if (this.muted) return;
    for (let i = 0; i < Math.min(count, 12); i++) {
      this.tone({ freq: 700 + i * 60, to: 900 + i * 60, type: "sine", dur: 0.06, gain: 0.12 }, 0.05 + i * step);
    }
  }

  /** ダメージの音。段階が上がるほど厚く・高く・長く。hurt は受けた側（下がる音） */
  hit(tier: Tier, hurt: boolean, delay = 0) {
    if (this.muted) return;
    if (hurt) return this.hurt(tier, delay);
    const chords: Record<Tier, number[]> = {
      small: [660],
      mid: [523, 784],
      big: [523, 659, 784, 1047],
      huge: [659, 880, 1175, 1568, 1976],
    };
    const notes = chords[tier];
    const step = { small: 0, mid: 0.07, big: 0.06, huge: 0.07 }[tier];
    const dur = { small: 0.12, mid: 0.25, big: 0.45, huge: 0.8 }[tier];
    notes.forEach((f, i) => {
      this.tone({ freq: f, type: tier === "small" ? "sine" : "triangle", at: i * step, dur, gain: 0.22 }, delay);
      // 大以上は 1 オクターブ上を薄く重ねてきらめかせる
      if (tier === "big" || tier === "huge") this.tone({ freq: f * 2, type: "sine", at: i * step, dur: dur * 0.8, gain: 0.06 }, delay);
    });
    if (tier === "big" || tier === "huge") this.noise(tier === "huge" ? 0.5 : 0.25, 0.25, 3500, delay);
    // 特大は低い衝撃音を足す
    if (tier === "huge") this.tone({ freq: 140, to: 40, type: "sine", dur: 0.7, gain: 0.6 }, delay);
  }

  private hurt(tier: Tier, delay: number) {
    const depth = { small: 1, mid: 2, big: 3, huge: 4 }[tier];
    const dur = { small: 0.14, mid: 0.25, big: 0.4, huge: 0.7 }[tier];
    for (let i = 0; i < depth; i++) {
      this.tone({ freq: 330 - i * 40, to: 110 - i * 15, type: "sawtooth", at: i * 0.04, dur, gain: 0.08 }, delay);
    }
    this.noise(dur * 0.8, 0.12 + depth * 0.06, 400, delay);
    if (tier === "huge") this.tone({ freq: 90, to: 35, type: "sine", dur: 0.8, gain: 0.6 }, delay);
  }

  /**
   * 先手・後手の抽選の音。石を弾く高い音 → 回る風切り → landAt 秒後に盤に落ちる木の音（小さく 1 回跳ねる）→ 結果の 1 音。
   * 動きを減らす設定（landAt 0）では落ちる音と結果の音だけ
   */
  toss(landAt: number) {
    if (this.muted) return;
    if (landAt > 0) {
      this.tone({ freq: 1400, to: 2100, type: "triangle", dur: 0.05, gain: 0.16 });
      this.noise(0.04, 0.12, 4200);
      this.noise(landAt * 0.8, 0.05, 900, 0.05);
    }
    this.tone({ freq: 320, to: 140, type: "triangle", dur: 0.1, gain: 0.35 }, landAt);
    this.noise(0.05, 0.16, 1800, landAt);
    if (landAt > 0) this.tone({ freq: 300, to: 150, type: "triangle", dur: 0.06, gain: 0.14 }, landAt + 0.09);
    this.tone({ freq: 784, type: "sine", dur: 0.4, gain: 0.12 }, landAt + 0.12);
  }

  /** スキルを使った音。カードをめくる擦れ → 上がる 3 音のきらめき */
  skill() {
    if (this.muted) return;
    this.noise(0.12, 0.1, 2600);
    [587, 880, 1319].forEach((f, i) => {
      this.tone({ freq: f, type: "triangle", at: 0.1 + i * 0.08, dur: 0.35, gain: 0.14 });
      this.tone({ freq: f * 2, type: "sine", at: 0.1 + i * 0.08, dur: 0.3, gain: 0.04 });
    });
  }

  /** カードを 1 枚配る音（delay 秒後）。紙が滑る擦れと小さな打音 */
  deal(delay = 0) {
    if (this.muted) return;
    this.noise(0.07, 0.07, 3200, delay);
    this.tone({ freq: 659, to: 523, type: "triangle", at: 0.03, dur: 0.08, gain: 0.07 }, delay);
  }

  /** カードに合わせた音（ホバー・フォーカス）。続けて動かしてもうるさくならないよう 90 ミリ秒の間は鳴らさない */
  hover() {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || ctx.currentTime - this.lastHover < 0.09) return;
    this.lastHover = ctx.currentTime;
    this.tone({ freq: 1319, type: "sine", dur: 0.05, gain: 0.035 });
  }

  /** カードを選んだ音（決める前） */
  select() {
    if (this.muted) return;
    this.tone({ freq: 988, type: "triangle", dur: 0.09, gain: 0.08 });
    this.tone({ freq: 1976, type: "sine", dur: 0.07, gain: 0.02 });
  }

  /** カードを決めた音。上がる 2 音 */
  decide() {
    if (this.muted) return;
    [784, 1175].forEach((f, i) => {
      this.tone({ freq: f, type: "triangle", at: i * 0.07, dur: 0.22, gain: 0.1 });
      this.tone({ freq: f * 2, type: "sine", at: i * 0.07, dur: 0.18, gain: 0.025 });
    });
  }

  /** オンラインで相手が選び終えた知らせ。柔らかい 2 音 */
  opponentReady() {
    if (this.muted) return;
    [1047, 1397].forEach((f, i) => this.tone({ freq: f, type: "sine", at: i * 0.1, dur: 0.25, gain: 0.06 }));
  }

  /** スキルのゲージが満タンになった音。控えめに上がる高い 2 音（delay 秒後） */
  gaugeFull(delay = 0) {
    if (this.muted) return;
    [1175, 1760].forEach((f, i) => this.tone({ freq: f, type: "sine", at: i * 0.08, dur: 0.3, gain: 0.07 }, delay));
  }

  /** 決着の音。win: 短いファンファーレ / lose: 低く短い下降音 / draw: 落ち着いた 2 音 */
  finale(kind: OutcomeKind) {
    if (this.muted) return;
    if (kind === "win") {
      // ド・ミ・ソと駆け上がり、上のドを足した和音で伸ばす
      [523, 659, 784].forEach((f, i) => this.tone({ freq: f, type: "triangle", at: i * 0.11, dur: 0.14, gain: 0.22 }));
      for (const f of [523, 659, 784, 1047]) {
        this.tone({ freq: f, type: "triangle", at: 0.36, dur: 1.0, gain: 0.15 });
        this.tone({ freq: f * 2, type: "sine", at: 0.36, dur: 0.8, gain: 0.04 });
      }
      this.noise(0.6, 0.12, 5000, 0.36);
      return;
    }
    if (kind === "lose") {
      // ソ・ミ♭・ドと低く下がる（短調）
      [196, 156, 131].forEach((f, i) => this.tone({ freq: f, type: "triangle", at: i * 0.24, dur: i === 2 ? 0.8 : 0.3, gain: 0.2 }));
      this.tone({ freq: 65, to: 45, type: "sine", at: 0.48, dur: 0.8, gain: 0.3 });
      return;
    }
    // ラ・レの穏やかな 4 度
    this.tone({ freq: 440, type: "sine", dur: 0.45, gain: 0.16 });
    this.tone({ freq: 587, type: "sine", at: 0.2, dur: 0.7, gain: 0.14 });
  }
}
