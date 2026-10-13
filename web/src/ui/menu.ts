// メニュー画面: CPU対戦（強さを選ぶとそのまま始まる）・マルチ（この端末で 2 人・オンライン）・遊び方（チュートリアル）・
// スキル練習（11 枚のカードの一覧から 1 枚を選んで練習する）・設定・このゲームについて（版・権利・プライバシー）。
// どの対局も設定メニューで保存したルール（変えなければ標準）で始まる。表示と入力だけで、対局は App が始める。

import { CPU_LEVELS, type CpuLevel } from "../engine/cpu";
import type { RuleSet } from "../engine/rules";
import { SKILL_ORDER, SKILLS, type SkillId } from "../engine/skills";
import { byId, h } from "./dom";
import { tarotCard } from "./skillui";

export interface MenuActions {
  cpu: (level: CpuLevel) => void;
  pvp: () => void;
  online: () => void;
  /** 遊び方（チュートリアル）を前回の位置から始める */
  learn: () => void;
  /** スキル練習で id のカードの練習を始める */
  skillLesson: (id: SkillId) => void;
  settings: () => void;
  /** このゲームについて（版・作者・権利・プライバシー） */
  about: () => void;
  rules: () => void;
  /** 対局中に開いたメニューから、その対局へ戻る */
  resume: () => void;
}

export type Panel = "main" | "levels" | "modes" | "skills";

export class Menu {
  private readonly el = {
    root: byId("menu"),
    note: byId("menu-note"),
    resume: byId("menu-resume"),
    online: byId("menu-online"),
    learn: byId("menu-learn"),
    learnState: byId("menu-learn-state"),
    skills: byId("menu-skills"),
    skillsState: byId("menu-skills-state"),
    skillList: byId("skill-lessons"),
    skillCount: byId("menu-skilllist-count"),
    ruleName: byId("menu-rule-name"),
    panels: { main: byId("menu-main"), levels: byId("menu-levels"), modes: byId("menu-modes"), skills: byId("menu-skilllist") } as Record<Panel, HTMLElement>,
  };

  constructor(private readonly act: MenuActions) {
    byId("menu-cpu").addEventListener("click", () => this.panel("levels"));
    byId("menu-multi").addEventListener("click", () => this.panel("modes"));
    this.el.learn.addEventListener("click", () => act.learn());
    this.el.skills.addEventListener("click", () => this.panel("skills"));
    byId("menu-settings").addEventListener("click", () => act.settings());
    byId("menu-about").addEventListener("click", () => act.about());
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

  /** メニューを出す。canResume なら「対局に戻る」を出す。panel は開く段（スキル練習の一覧へ戻るときなど） */
  show(canResume = false, panel: Panel = "main") {
    this.el.resume.hidden = !canResume;
    this.el.root.hidden = false;
    this.panel(panel, panel !== "main");
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

  /**
   * スキル練習の一覧（タロットの札 11 枚）と入口に添える状態。終えたカードに印、まだのカードのうち最初の 1 枚を次に勧める
   * （rules はカードの効果の文に使う標準のルール）
   */
  setSkillLessons(done: readonly SkillId[], label: string, rules: RuleSet) {
    this.el.skillsState.textContent = ` ${label}`;
    this.el.skillCount.textContent = ` ${done.length}/${SKILL_ORDER.length}`;
    const cleared = new Set(done);
    const next = SKILL_ORDER.find((id) => !cleared.has(id));
    this.el.skillList.replaceChildren(
      ...SKILL_ORDER.map((id) => {
        const b = tarotCard(id, rules, { button: true, cls: `mini${cleared.has(id) ? " cleared" : ""}${id === next ? " next" : ""}` });
        b.removeAttribute("aria-pressed");
        b.setAttribute("aria-label", `${SKILLS[id].name}の練習${cleared.has(id) ? "。済み" : ""}`);
        if (cleared.has(id)) b.append(h("span", { class: "tarot-clear", attrs: { "aria-hidden": "true" } }));
        b.addEventListener("click", () => this.act.skillLesson(id));
        return b;
      }),
    );
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
