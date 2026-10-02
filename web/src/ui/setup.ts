// 対局設定ダイアログ: プリセット・ルールの各項目・対戦相手・URL の共有。
// フォームの値は検証してから RuleSet にする（範囲外は範囲内に丸める）。

import {
  cloneRules,
  KIND_ORDER,
  LIMITS,
  matchPreset,
  PIECES,
  PRESETS,
  REACH_MARK,
  type Player,
  type RuleSet,
} from "../engine/rules";
import { dirIcon } from "./diricon";
import { byId, h } from "./dom";
import { decodeRules, encodeRules } from "./query";
import { ruleLines, verb, type Sentence } from "./ruletext";

export type Mode = "cpu" | "pvp";

export interface PlaySettings {
  mode: Mode;
  /** CPU 対戦で人間が持つ手番 */
  human: Player;
  rules: RuleSet;
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
  limit: "手数上限", king: "隠し王", kpen: "王の罰", kdmg: "王の罰の体力", kdue: "王の指定期限", dir: "挟める方向",
  ...Object.fromEntries(KIND_ORDER.flatMap((k) => [[k, `${PIECES[k].name}の数`], [`v${k}`, `${PIECES[k].name}の数字`]])),
};

export class SetupDialog {
  private rules: RuleSet;
  /** 開いたときの設定（対局中に開いて閉じたら、アドレスバーをこの設定に戻す） */
  private openedWith: RuleSet | null = null;
  private readonly el = {
    dialog: byId<HTMLDialogElement>("setup"),
    form: byId<HTMLFormElement>("setup-form"),
    presets: byId("presets"),
    customTag: byId("custom-tag"),
    pieceTable: byId("piece-table"),
    gateOn: byId("gate-on-label"),
    kingSub: byId("king-sub"),
    kingHp: byId("king-hp-label"),
    kingLose: byId("king-lose-label"),
    kingAmount: byId("king-amount-field"),
    preview: byId("setup-rules4"),
    sideField: byId("side-field"),
    note: byId("setup-note"),
    shareStatus: byId("share-status"),
    shareUrl: byId<HTMLInputElement>("share-url"),
  };

  constructor(
    private readonly onStart: (s: PlaySettings) => void,
    private readonly onShowRules: (r: RuleSet) => void,
    /** 対局が始まっているか（始まる前は設定画面を閉じさせない） */
    private readonly hasGame: () => boolean,
  ) {
    // URL のクエリがあればその設定で始める。不正な項目は既定値に戻して知らせる
    const decoded = decodeRules(window.location.search);
    this.rules = decoded.rules;
    if (decoded.invalid.length > 0) {
      this.showNote(
        `URL の設定に読めない値があったため、${decoded.invalid.map((k) => KEY_LABEL[k] ?? k).join("・")}は既定値にしました。`,
      );
    } else if (decoded.present) {
      this.showNote("URL の設定を読み込みました。");
    }
    this.buildPresets();
    this.buildPieceTable();
    this.bind();
    this.writeForm(this.rules);
  }

  open(rules?: RuleSet) {
    this.openedWith = rules ? cloneRules(rules) : null;
    if (rules) this.writeForm(rules);
    this.el.shareStatus.textContent = "";
    this.el.shareUrl.hidden = true;
    this.syncMode();
    if (!this.el.dialog.open) this.el.dialog.showModal();
  }

  private showNote(text: string) {
    this.el.note.textContent = text;
    this.el.note.hidden = false;
  }

  private buildPresets() {
    for (const p of PRESETS) {
      const b = h(
        "button",
        { class: "preset", attrs: { type: "button", "data-preset": p.id, "aria-pressed": "false" } },
        [h("span", { class: "preset-name", text: p.name }), h("span", { class: "preset-note", text: p.note })],
      );
      b.addEventListener("click", () => {
        this.writeForm(p.rules);
        this.reflectUrl();
      });
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
    dialog.addEventListener("cancel", (e) => {
      if (!this.hasGame()) e.preventDefault();
      else if (this.openedWith) this.reflectUrl(this.openedWith);
    });
    // 数値は入力し終えたとき（change）に範囲内へ直す。入力中（input）は表示だけ更新する
    form.addEventListener("input", () => this.refresh(false));
    form.addEventListener("change", () => {
      this.refresh(true);
      this.reflectUrl();
    });
    form.addEventListener("submit", () => {
      const f = new FormData(form);
      this.refresh(true);
      this.reflectUrl();
      this.onStart({
        mode: f.get("mode") === "pvp" ? "pvp" : "cpu",
        human: f.get("side") === "1" ? 1 : 0,
        rules: cloneRules(this.rules),
      });
    });
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
    this.syncMode();
  }

  private syncMode() {
    this.el.sideField.hidden = new FormData(this.el.form).get("mode") === "pvp";
  }

  shareUrl(r: RuleSet = this.rules): string {
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?${encodeRules(r)}`;
  }

  /** 今の設定をアドレスバーに反映する（再読み込みしても同じ設定になる） */
  reflectUrl(r: RuleSet = this.rules) {
    window.history.replaceState(null, "", `${window.location.pathname}?${encodeRules(r)}`);
  }

  private async copyUrl() {
    this.refresh(true);
    this.reflectUrl();
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
