// 設定メニュー: プリセット・ルールの各項目・CPU 対戦とオンラインの手番・1 手の制限時間・URL の共有。
// フォームは下書きで、「保存」で次の対局の設定になる（この端末の localStorage に保存。読めなければ標準）。
// フォームの値は検証してから RuleSet にする（範囲外は範囲内に丸める）。

import { DEFAULT_CPU_LEVEL, type CpuLevel } from "../engine/cpu";
import {
  cloneRules,
  defaultRules,
  KIND_ORDER,
  LIMITS,
  matchPreset,
  PIECES,
  PRESETS,
  presetById,
  REACH_MARK,
  type Player,
  type RuleSet,
} from "../engine/rules";
import type { KeyValueStore } from "../net/online";
import type { HostSeat } from "../net/protocol";
import { dirIcon } from "./diricon";
import { byId, h } from "./dom";
import { cpuTurnSeconds, DEFAULT_MULTI_SECONDS, isCpuTime, isMultiTime, type CpuTime, type MultiTime } from "./clock";
import { decodeRules, encodeRules, QUERY_BASE } from "./query";
import { ruleLines, verb, type Sentence } from "./ruletext";

/** cpu: CPU 対戦 / pvp: 同じ端末で 2 人 / online: 招待リンクで遠隔の相手と */
export type Mode = "cpu" | "pvp" | "online";

export interface PlaySettings {
  mode: Mode;
  /** CPU 対戦で人間が持つ手番。オンライン対戦ではサーバーが決めた自分の手番 */
  human: Player;
  rules: RuleSet;
  /** オンライン対戦で部屋を作るときの自分の席の希望 */
  hostSeat?: HostSeat;
  /** CPU 対戦で人間の手番を対局ごとに抽選する（human は対局を始めるときに引き直す。メニューから始め直しても・再戦でも） */
  randomSeat?: boolean;
  /** CPU 対戦の CPU の強さ（省略時はノーマル） */
  level?: CpuLevel;
  /**
   * 1 手ごとの制限時間（秒。0 は制限なし）。CPU 対戦は人間の手番だけに付く。
   * オンライン対戦は部屋を作るときにサーバーへ渡し、参加した側はサーバーの値（RoomInfoResponse.turnSeconds）
   */
  turnSeconds: number;
}

/** 設定メニューで保存する中身（ルール・CPU 対戦の手番・オンラインで部屋を作るときの手番・制限時間） */
export interface Saved {
  rules: RuleSet;
  side: Side;
  host: HostSeat;
  /** CPU 対戦の制限時間（"auto" は強さに合わせる） */
  timeCpu: CpuTime;
  /** マルチ（同じ端末の 2 人・オンラインで部屋を作るとき）の制限時間 */
  timeMulti: MultiTime;
}
/** CPU 対戦の手番の設定（"0" 先手 / "1" 後手 / "random" 対局ごとに抽選） */
export type Side = "0" | "1" | "random";

/** localStorage のキー（中身は JSON。ルールは URL と同じクエリの文字列で、decodeRules で検証して読む） */
export const SETTINGS_KEY = "kyosho:settings";

export const defaultSaved = (): Saved => ({
  rules: defaultRules(),
  side: "random",
  host: "random",
  timeCpu: "auto",
  timeMulti: `${DEFAULT_MULTI_SECONDS}`,
});

const isSide = (v: unknown): v is Side => v === "0" || v === "1" || v === "random";
const isHost = (v: unknown): v is HostSeat => v === "random" || v === "first" || v === "second";

/**
 * 保存した設定を読む。保存がない・壊れている・読めない値がある（ストレージが使えない場合を含む）ときは、
 * その部分を既定（標準・CPU 対戦の手番はランダム・オンラインの席はランダム・強さに合わせる・45 秒）にする。ルールは一部でも読めなければ全体を標準にする
 */
export function loadSaved(store: KeyValueStore): Saved {
  const out = defaultSaved();
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null) return out;
  const o = raw as Record<string, unknown>;
  if (typeof o.rules === "string") {
    const d = decodeRules(`?${o.rules}`);
    if (d.present && d.invalid.length === 0) out.rules = d.rules;
  }
  if (isSide(o.side)) out.side = o.side;
  if (isHost(o.host)) out.host = o.host;
  if (isCpuTime(o.timeCpu)) out.timeCpu = o.timeCpu;
  if (isMultiTime(o.timeMulti)) out.timeMulti = o.timeMulti;
  return out;
}

export function storeSaved(store: KeyValueStore, s: Saved) {
  store.setItem(
    SETTINGS_KEY,
    JSON.stringify({ rules: encodeRules(s.rules), side: s.side, host: s.host, timeCpu: s.timeCpu, timeMulti: s.timeMulti }),
  );
}

/** 0 以上 1 未満の乱数。Math.random は CPU の乱数と共有なので使わない（e2e は Math.random を種付きにして CPU の手を再現する） */
export function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** 手番の抽選（半々で先手・後手） */
export function drawSeat(rand: () => number = cryptoRandom): Player {
  return rand() < 0.5 ? 0 : 1;
}

/** 設定画面の「side」の値 → CPU 対戦の手番。"1" は後手、"random" は抽選（human は始めるときに引き直す）、それ以外は先手 */
export function seatChoice(side: FormDataEntryValue | null): { human: Player; randomSeat: boolean } {
  return { human: side === "1" ? 1 : 0, randomSeat: side === "random" };
}

/** 文の配列を <li> にして ol へ入れる（強調部分は <strong>） */
export function fillSentences(list: HTMLElement, lines: Sentence[]) {
  list.replaceChildren(
    ...lines.map((line) =>
      h("li", {}, line.map((seg) => (typeof seg === "string" ? seg : h("strong", { text: seg.strong })))),
    ),
  );
}

/** 0 以上の整数に丸めて範囲内に収める。数でなければ fallback */
function clampInt(raw: string, range: { min: number; max: number }, fallback: number): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

const KEY_LABEL: Record<string, string> = {
  take: "挟んだ駒を", gate: "強さ制限", dmg: "ダメージ", heal: "回復", hp1: "先手の体力", hp2: "後手の体力",
  limit: "手数上限", anc: "端の駒の力", king: "隠し王", kpen: "王の罰", kdmg: "王の罰の体力", kdue: "王の指定期限", dir: "挟める方向",
  ...Object.fromEntries(KIND_ORDER.flatMap((k) => [[k, `${PIECES[k].name}の数`], [`v${k}`, `${PIECES[k].name}の数字`]])),
};

export class SetupDialog {
  /** 保存済みの設定（次の対局で使う） */
  private saved: Saved;
  /** フォームの下書きのルール */
  private rules: RuleSet;
  private readonly el = {
    dialog: byId<HTMLDialogElement>("setup"),
    form: byId<HTMLFormElement>("setup-form"),
    presets: byId("presets"),
    details: byId<HTMLDetailsElement>("rule-details"),
    customTag: byId("custom-tag"),
    pieceTable: byId("piece-table"),
    gateOn: byId("gate-on-label"),
    kingSub: byId("king-sub"),
    kingHp: byId("king-hp-label"),
    kingLose: byId("king-lose-label"),
    kingAmount: byId("king-amount-field"),
    preview: byId("setup-rules4"),
    hostField: byId("host-field"),
    shareStatus: byId("share-status"),
    shareUrl: byId<HTMLInputElement>("share-url"),
  };

  constructor(
    private readonly store: KeyValueStore,
    private readonly onShowRules: (r: RuleSet) => void,
    /** 保存した（メニューのルール名などを更新する） */
    private readonly onSaved: (s: Saved) => void,
    /** URL の設定を読んだ・読めない値があったことの知らせ */
    showNote: (text: string) => void,
  ) {
    this.saved = loadSaved(store);
    // URL のクエリにルールがあればそのルールで遊ぶ（共有された URL。保存はしない）。不正な項目は基準（v1.0）の値に戻して知らせる
    const decoded = decodeRules(window.location.search);
    if (decoded.present) {
      this.saved.rules = decoded.rules;
      if (decoded.invalid.length > 0) {
        showNote(
          `URL の設定に読めない値があったため、${decoded.invalid.map((k) => KEY_LABEL[k] ?? k).join("・")}は${presetById(QUERY_BASE).name}の値にしました。`,
        );
      } else {
        showNote("URL の設定を読み込みました。");
      }
    }
    this.rules = cloneRules(this.saved.rules);
    this.buildPresets();
    this.buildPieceTable();
    this.bind();
  }

  /** 次の対局の設定 */
  get current(): Saved {
    return { ...this.saved, rules: cloneRules(this.saved.rules) };
  }

  /** 次の対局の設定で、mode の対局を始める設定にする */
  playSettings(mode: Mode, level?: CpuLevel): PlaySettings {
    const { rules, side, host, timeCpu, timeMulti } = this.current;
    if (mode === "cpu") return { mode, ...seatChoice(side), rules, level, turnSeconds: cpuTurnSeconds(timeCpu, level ?? DEFAULT_CPU_LEVEL) };
    const turnSeconds = Number(timeMulti);
    if (mode === "online") return { mode, human: 0, rules, hostSeat: host, turnSeconds };
    return { mode, human: 0, rules, turnSeconds };
  }

  /** 保存済みの設定をフォームに入れて開く */
  open() {
    this.writeForm(this.saved.rules);
    this.radio("side", this.saved.side);
    this.radio("host", this.saved.host);
    this.radio("timeCpu", this.saved.timeCpu);
    this.radio("timeMulti", this.saved.timeMulti);
    this.openDetailsIfCustom();
    this.el.shareStatus.textContent = "";
    this.el.shareUrl.hidden = true;
    if (!this.el.dialog.open) this.el.dialog.showModal();
  }

  /** プリセットと違う設定なら、細かい項目を開いて見せる */
  private openDetailsIfCustom() {
    this.el.details.open = !matchPreset(this.rules);
  }

  /** オンライン対戦の手番の欄を出す（サーバーに届く公開先だけ） */
  enableOnline() {
    this.el.hostField.hidden = false;
  }

  private buildPresets() {
    for (const p of PRESETS) {
      const b = h(
        "button",
        // 説明は選んだあとのルールの文（#setup-rules4）で読めるので、札には名前だけ（説明は title）
        { class: "preset", attrs: { type: "button", "data-preset": p.id, "aria-pressed": "false", title: p.note } },
        [h("span", { class: "preset-name", text: p.name })],
      );
      b.addEventListener("click", () => this.writeForm(p.rules));
      this.el.presets.append(b);
    }
  }
  /** 駒種ごとの 数・数字 の欄（方向は種類で固定なので表示だけ） */
  private buildPieceTable() {
    const num = (name: string, label: string, range: { min: number; max: number }, aria: string) =>
      h("label", { class: "num" }, [
        h("span", { text: label }),
        h("input", {
          attrs: {
            type: "number", name, inputmode: "numeric", min: String(range.min), max: String(range.max), step: "1", required: "",
            "aria-label": aria,
          },
        }),
      ]);
    for (const k of KIND_ORDER) {
      const { name, reach } = PIECES[k];
      const m = REACH_MARK[reach];
      this.el.pieceTable.append(
        h("div", { class: "piece-row", attrs: { "data-kind": k } }, [
          h("span", { class: "piece-row-name" }, [
            h("span", { class: "mini-stone p0", text: name }),
            h("span", { class: "piece-row-dir", attrs: { title: m.name } }, [dirIcon(reach, "mini-dir"), m.short]),
          ]),
          num(k, "数", LIMITS.pieces, `${name}の数`),
          num(`v${k}`, "数字", LIMITS.value, `${name}の数字`),
        ]),
      );
    }
  }

  private bind() {
    const { dialog, form } = this.el;
    // 数値は入力し終えたとき（change）に範囲内へ直す。入力中（input）は表示だけ更新する
    form.addEventListener("input", () => this.refresh(false));
    form.addEventListener("change", () => this.refresh(true));
    form.addEventListener("submit", () => {
      const f = new FormData(form);
      this.refresh(true);
      const side = f.get("side");
      const host = f.get("host");
      const timeCpu = f.get("timeCpu");
      const timeMulti = f.get("timeMulti");
      const d = defaultSaved();
      this.saved = {
        rules: cloneRules(this.rules),
        side: isSide(side) ? side : d.side,
        host: isHost(host) ? host : d.host,
        timeCpu: isCpuTime(timeCpu) ? timeCpu : d.timeCpu,
        timeMulti: isMultiTime(timeMulti) ? timeMulti : d.timeMulti,
      };
      storeSaved(this.store, this.saved);
      this.onSaved(this.current);
    });
    byId("setup-cancel").addEventListener("click", () => dialog.close());
    byId("setup-rules").addEventListener("click", () => {
      this.refresh(true);
      this.onShowRules(this.rules);
    });
    byId("setup-copy").addEventListener("click", () => void this.copyUrl());
  }

  private input(name: string) {
    return this.el.form.elements.namedItem(name) as HTMLInputElement;
  }

  private radio(name: string, value: string) {
    const r = this.el.form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (r) r.checked = true;
  }

  private writeForm(r: RuleSet) {
    this.radio("action", r.action);
    this.radio("gate", r.gate ? "1" : "0");
    this.radio("dirs", r.dirs);
    this.radio("damage", r.damage);
    this.radio("anchor", r.anchor);
    this.radio("heal", r.heal);
    this.input("hp0").value = String(r.hp[0]);
    this.input("hp1").value = String(r.hp[1]);
    for (const k of KIND_ORDER) {
      this.input(k).value = String(r.hand[k]);
      this.input(`v${k}`).value = String(r.values[k]);
    }
    this.input("maxPlies").value = String(r.maxPlies);
    this.radio("king", r.king.on ? "1" : "0");
    this.radio("kingPenalty", r.king.penalty);
    this.input("kingAmount").value = String(r.king.amount);
    this.input("kingDeadline").value = String(r.king.deadline);
    this.refresh(true);
  }

  /** フォームから設定を読む。fix なら範囲外・空の数値欄を直して書き戻す */
  private readForm(fix: boolean): RuleSet {
    const f = new FormData(this.el.form);
    const prev = this.rules;
    const num = (name: string, range: { min: number; max: number }, fallback: number) => {
      const el = this.input(name);
      const v = clampInt(el.value, range, fallback);
      if (fix && el.value !== String(v)) el.value = String(v);
      return v;
    };
    const hand = { ...prev.hand };
    const values = { ...prev.values };
    for (const k of KIND_ORDER) {
      hand[k] = num(k, LIMITS.pieces, prev.hand[k]);
      values[k] = num(`v${k}`, LIMITS.value, prev.values[k]);
    }
    return {
      action: f.get("action") === "flip" ? "flip" : "capture",
      gate: f.get("gate") === "1",
      dirs: f.get("dirs") === "piece" ? "piece" : "all",
      damage: f.get("damage") === "maxCount" ? "maxCount" : "sum",
      anchor: f.get("anchor") === "attack" ? "attack" : "none",
      heal: f.get("heal") === "avg" ? "avg" : f.get("heal") === "lowMinus1" ? "lowMinus1" : "none",
      hp: [num("hp0", LIMITS.hp, prev.hp[0]), num("hp1", LIMITS.hp, prev.hp[1])],
      hand,
      values,
      maxPlies: num("maxPlies", LIMITS.maxPlies, prev.maxPlies),
      king: {
        on: f.get("king") === "1",
        penalty: f.get("kingPenalty") === "lose" ? "lose" : "hp",
        amount: num("kingAmount", LIMITS.kingAmount, prev.king.amount),
        deadline: num("kingDeadline", LIMITS.kingDeadline, prev.king.deadline),
      },
    };
  }

  /** フォームの値に合わせてプリセットの選択・ルールの文・URL を更新する */
  private refresh(fix: boolean) {
    this.rules = this.readForm(fix);
    const match = matchPreset(this.rules);
    for (const b of this.el.presets.querySelectorAll<HTMLElement>(".preset")) {
      b.setAttribute("aria-pressed", String(b.dataset.preset === match?.id));
    }
    this.el.customTag.textContent = match ? `— ${match.name}` : "— カスタム（どのプリセットとも違う）";
    const v = verb(this.rules);
    this.el.gateOn.textContent = `置いた駒より強い駒は${v.cannot}`;
    // 方向は「駒ごと」のときだけ効くので、全方向では薄く表示する
    this.el.pieceTable.classList.toggle("dirs-all", this.rules.dirs === "all");
    // 隠し王の追加設定は「あり」のときだけ見せる。減る体力の欄は罰が体力のときだけ
    this.el.kingSub.hidden = !this.rules.king.on;
    this.el.kingAmount.hidden = this.rules.king.penalty !== "hp";
    this.el.kingHp.textContent = `${v.hitIf}体力が減る`;
    this.el.kingLose.textContent = `${v.hitIf}即負け`;
    fillSentences(this.el.preview, ruleLines(this.rules));
  }

  shareUrl(r: RuleSet = this.rules): string {
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?${encodeRules(r)}`;
  }

  /** 設定をアドレスバーに反映する（再読み込みしても同じ設定になる） */
  reflectUrl(r: RuleSet = this.rules) {
    window.history.replaceState(null, "", `${window.location.pathname}?${encodeRules(r)}`);
  }

  private async copyUrl() {
    this.refresh(true);
    const url = this.shareUrl();
    const { shareStatus, shareUrl } = this.el;
    shareUrl.value = url;
    try {
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = "コピーしました";
      shareUrl.hidden = false;
    } catch {
      // クリップボードが使えない環境では URL を表示して選択状態にする
      shareStatus.textContent = "自動でコピーできませんでした。下の URL をコピーしてください";
      shareUrl.hidden = false;
      shareUrl.select();
    }
  }
}
