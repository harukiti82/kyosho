// メニュー画面: CPU対戦（強さを選ぶとそのまま始まる）・マルチ（この端末で 2 人・オンライン）・設定。
// どの対局も設定メニューで保存したルール（変えなければ標準）で始まる。表示と入力だけで、対局は App が始める。

import { CPU_LEVELS, type CpuLevel } from "../engine/cpu";
import { byId, h } from "./dom";

export interface MenuActions {
  cpu: (level: CpuLevel) => void;
  pvp: () => void;
  online: () => void;
  settings: () => void;
  rules: () => void;
  /** 対局中に開いたメニューから、その対局へ戻る */
  resume: () => void;
}

type Panel = "main" | "levels" | "modes";

export class Menu {
  private readonly el = {
    root: byId("menu"),
    note: byId("menu-note"),
    resume: byId("menu-resume"),
    online: byId("menu-online"),
    ruleName: byId("menu-rule-name"),
    panels: { main: byId("menu-main"), levels: byId("menu-levels"), modes: byId("menu-modes") } as Record<Panel, HTMLElement>,
  };

  constructor(act: MenuActions) {
    byId("menu-cpu").addEventListener("click", () => this.panel("levels"));
    byId("menu-multi").addEventListener("click", () => this.panel("modes"));
    byId("menu-settings").addEventListener("click", () => act.settings());
    byId("menu-rule").addEventListener("click", () => act.rules());
    this.el.resume.addEventListener("click", () => act.resume());
    byId("menu-pvp").addEventListener("click", () => act.pvp());
    this.el.online.addEventListener("click", () => act.online());
    for (const b of this.el.root.querySelectorAll<HTMLElement>("[data-level]")) {
      const level = b.dataset.level as CpuLevel;
      if (CPU_LEVELS.includes(level)) b.addEventListener("click", () => act.cpu(level));
    }
    for (const b of this.el.root.querySelectorAll<HTMLElement>(".menu-back")) b.addEventListener("click", () => this.panel("main"));
    // Esc で 1 つ前の段へ戻る（ダイアログが開いていないときだけ）
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.visible || document.querySelector("dialog[open]")) return;
      if (!this.el.panels.main.hidden) return;
      e.preventDefault();
      this.panel("main");
    });
  }

  get visible(): boolean {
    return !this.el.root.hidden;
  }

  /** メニューを出す。canResume なら「対局に戻る」を出す */
  show(canResume = false) {
    this.el.resume.hidden = !canResume;
    this.el.root.hidden = false;
    this.panel("main", false);
  }

  hide() {
    this.el.root.hidden = true;
    this.el.note.hidden = true;
  }

  /** 次の対局のルールの名前 */
  setRuleName(name: string) {
    this.el.ruleName.textContent = name;
  }

  showNote(text: string) {
    this.el.note.textContent = text;
    this.el.note.hidden = false;
  }

  /** CPU の強さのボタンに、その強さで始めたときのあなたの 1 手の制限時間を添える（例: 「45秒」「なし」） */
  setLevelTimes(text: (level: CpuLevel) => string) {
    for (const b of this.el.root.querySelectorAll<HTMLElement>("[data-level]")) {
      const level = b.dataset.level as CpuLevel;
      if (!CPU_LEVELS.includes(level)) continue;
      let el = b.querySelector<HTMLElement>(".menu-time");
      if (!el) {
        el = h("span", { class: "menu-time" });
        b.append(el);
      }
      // 先頭の空白は読み上げで強さの名前と区切るため（表示は改行するので見えない）
      el.textContent = ` ${text(level)}`;
      el.title = "1 手の制限時間";
    }
  }

  /** オンライン対戦の入口を出す（サーバーに届く公開先だけ） */
  enableOnline() {
    this.el.online.hidden = false;
  }

  private panel(p: Panel, focus = true) {
    for (const [k, el] of Object.entries(this.el.panels)) el.hidden = k !== p;
    // 段を切り替えたら、その段の最初のボタンに移る（キーボード操作で迷わないように）
    if (focus) this.el.panels[p].querySelector<HTMLElement>("button:not([hidden])")?.focus();
  }
}
