// 効果音。音声ファイルは使わず Web Audio API で合成する。
// 自動再生の制限に合わせ、AudioContext は最初のユーザー操作（pointerdown / keydown）の中で作る。それまでの音は鳴らさない。
// 消音の状態は localStorage に保存する（使えない環境では保存せずに動く）。

import type { Tier } from "./impact";

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
}
