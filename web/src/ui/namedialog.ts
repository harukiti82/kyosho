// 自分の名前をメニューから決めるダイアログ（#name-dialog）と、名前のないままオンライン対戦を始めるときの案内（この端末で 1 回だけ）。
// 検証は net/name.ts の normalizeName、保存は設定メニューの欄と同じ Saved.name（ui/setup.ts の SetupDialog.saveName。呼ぶのは app.ts）。
// 名前の欄（nameField）は招待リンクの参加の確認（ui/online.ts の join）でも使う。名前は textContent / value でだけ入れる

import type { KeyValueStore } from "../net/online";
import { NAME_PROBLEM_TEXT, normalizeName } from "../net/name";
import { byId, h } from "./dom";

/** オンライン対戦の前に名前の案内を出した印（localStorage。中身は JSON の { v: 1 }。印があれば案内しない） */
export const NAME_ASK_KEY = "kyosho:name-ask";

/** 名前の案内を出したか（読めない・壊れている保存も「出した」とみなす = 何度も案内しない） */
export const nameAsked = (store: KeyValueStore): boolean => store.getItem(NAME_ASK_KEY) !== null;

export function markNameAsked(store: KeyValueStore) {
  store.setItem(NAME_ASK_KEY, JSON.stringify({ v: 1 }));
}

/** 名前の欄。check は通れば正規化した名前（空は名前なし）、通らなければ欄の下に理由を出して null */
export interface NameField {
  box: HTMLElement;
  input: HTMLInputElement;
  check: () => string | null;
}

/** 名前の欄（設定メニューの欄と同じ見た目・検証）。onEnter は日本語の変換を確定する Enter では呼ばない */
export function nameField(o: { id: string; value: string; onEnter?: () => void }): NameField {
  const errorId = `${o.id}-error`;
  const input = h("input", {
    class: "name-input",
    attrs: {
      type: "text",
      id: o.id,
      "aria-label": "名前",
      "aria-describedby": errorId,
      placeholder: "あなた",
      autocomplete: "nickname",
      enterkeyhint: "done",
      spellcheck: "false",
    },
  });
  input.value = o.value;
  const error = h("span", { class: "name-error", attrs: { id: errorId, role: "alert", hidden: "" } });
  const check = () => {
    const n = normalizeName(input.value);
    error.textContent = n.ok ? "" : NAME_PROBLEM_TEXT[n.problem];
    error.hidden = n.ok;
    input.setAttribute("aria-invalid", String(!n.ok));
    return n.ok ? n.name : null;
  };
  input.addEventListener("input", check);
  if (o.onEnter) {
    const enter = o.onEnter;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        enter();
      }
    });
  }
  return { box: h("div", { class: "name-box" }, [input, error]), input, check };
}

/**
 * ask: オンライン対戦の前の案内（もう一方の鍵は「名前なし」で、その名前のまま進む）。そうでなければメニューから変える（「やめる」）。
 * save は決めた名前（空は名前なし）、skip は「名前なし」、cancel は「やめる」・Esc
 */
export interface NameRequest {
  ask: boolean;
  value: string;
  save: (name: string) => void;
  skip?: () => void;
  cancel?: () => void;
}

export class NameDialog {
  private readonly el = {
    dialog: byId<HTMLDialogElement>("name-dialog"),
    form: byId<HTMLFormElement>("name-dialog-form"),
    lead: byId("name-dialog-lead"),
    slot: byId("name-dialog-field"),
    other: byId<HTMLButtonElement>("name-dialog-other"),
  };
  private req: NameRequest | null = null;
  private field: NameField | null = null;

  constructor() {
    this.el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = this.field?.check();
      if (name === null || name === undefined) {
        this.field?.input.focus();
        return;
      }
      this.finish()?.save(name);
    });
    this.el.other.addEventListener("click", () => {
      const req = this.finish();
      if (req?.ask) req.skip?.();
      else req?.cancel?.();
    });
    // Esc は「やめる」（案内のときも、オンライン対戦を始めずにメニューへ戻る）
    this.el.dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.finish()?.cancel?.();
    });
  }

  get isOpen() {
    return this.el.dialog.open;
  }

  open(req: NameRequest) {
    this.req = req;
    this.el.dialog.dataset.mode = req.ask ? "ask" : "edit";
    this.el.lead.textContent = req.ask ? "対戦相手の画面に出る名前" : "オンライン対戦では相手の画面にも出ます";
    this.el.other.textContent = req.ask ? "名前なし" : "やめる";
    this.field = nameField({ id: "name-dialog-input", value: req.value });
    this.el.slot.replaceChildren(this.field.box);
    if (!this.el.dialog.open) this.el.dialog.showModal();
    this.field.input.focus();
    this.field.input.select();
  }

  /** 閉じて、開いていたときの依頼を返す（二度押しで 2 回呼ばない） */
  private finish(): NameRequest | null {
    const req = this.req;
    this.req = null;
    if (this.el.dialog.open) this.el.dialog.close();
    return req;
  }
}
