// メニュー画面: CPU対戦（強さを選ぶとそのまま始まる）・マルチ（この端末で 2 人・オンライン）・遊び方（章を選ぶとチュートリアル）・設定。
// どの対局も設定メニューで保存したルール（変えなければ標準）で始まる。表示と入力だけで、対局は App が始める。

import { CPU_LEVELS, type CpuLevel } from "../engine/cpu";
import { byId, h } from "./dom";
import type { ChapterId } from "./lessons";

export interface MenuActions {
  cpu: (level: CpuLevel) => void;
  pvp: () => void;
  online: () => void;
  /** 遊び方（チュートリアル）の章を前回の位置から始める */
  learn: (chapter: ChapterId) => void;
  settings: () => void;
  rules: () => void;
  /** 対局中に開いたメニューから、その対局へ戻る */
  resume: () => void;
}

type Panel = "main" | "levels" | "modes" | "learn";

export class Menu {
  private readonly el = {
    root: byId("menu"),
    note: byId("menu-note"),
    resume: byId("menu-resume"),
    online: byId("menu-online"),
    learn: byId("menu-learn"),
    learnState: byId("menu-learn-state"),
    ruleName: byId("menu-rule-name"),
    panels: { main: byId("menu-main"), levels: byId("menu-levels"), modes: byId("menu-modes"), learn: byId("menu-learns") } as Record<Panel, HTMLElement>,
  };

  constructor(act: MenuActions) {
    byId("menu-cpu").addEventListener("click", () => this.panel("levels"));
    byId("menu-multi").addEventListener("click", () => this.panel("modes"));
    this.el.learn.addEventListener("click", () => this.panel("learn"));
    for (const b of this.el.root.querySelectorAll<HTMLElement>("[data-chapter]")) {
      const chapter = b.dataset.chapter as ChapterId;
      b.addEventListener("click", () => act.learn(chapter));
    }
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

  /** 「遊び方」に添える進み具合（例: 「はじめての方に」「つづき 4/10」）。fresh（まだ始めていない）なら目立たせる */
  setLearnState(text: string, fresh: boolean) {
    // 先頭の空白は読み上げで「遊び方」と区切るため（表示は改行するので見えない）
    this.el.learnState.textContent = ` ${text}`;
    this.el.learn.classList.toggle("fresh", fresh);
  }

  /** 遊び方の章の項目に添える進み具合（例: 「おすすめ」「つづき 2/7」「クリア済み」。空なら添えない）。fresh なら目立たせる */
  setChapterState(chapter: ChapterId, text: string, fresh: boolean) {
    const b = this.el.root.querySelector<HTMLElement>(`[data-chapter="${chapter}"]`);
    const sub = b?.querySelector<HTMLElement>(".menu-sub");
    if (!b || !sub) return;
    sub.textContent = text ? ` ${text}` : "";
    b.classList.toggle("fresh", fresh);
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
