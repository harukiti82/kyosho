// メニュー画面: CPU対戦（強さを選ぶとそのまま始まる）・マルチ（この端末で 2 人・オンラインの招待リンクと合言葉）・遊び方（チュートリアル）・
// スキル練習（11 枚のカードの一覧から 1 枚を選んで練習する）・設定・このゲームについて（版・権利・プライバシー）。
// 上には自分の名前の名札（押すとその場で変える。ui/namedialog.ts）。
// どの対局も設定メニューで保存したルール（変えなければ標準）で始まる。表示と入力だけで、対局は App が始める。
// 初めての人が遊び方を終えるまでは、CPU対戦・マルチの鍵に錠を添え、押すと act.locked（ui/intro.ts）。

import { CPU_LEVELS, type CpuLevel } from "../engine/cpu";
import type { RuleSet } from "../engine/rules";
import { SKILL_ORDER, SKILLS, type SkillId } from "../engine/skills";
import { byId, h } from "./dom";
import { tarotCard } from "./skillui";

export interface MenuActions {
  cpu: (level: CpuLevel) => void;
  pvp: () => void;
  online: () => void;
  /** オンライン対戦を合言葉で（入力のダイアログを出す） */
  phrase: () => void;
  /** 遊び方（チュートリアル）を前回の位置から始める */
  learn: () => void;
  /** スキル練習で id のカードの練習を始める */
  skillLesson: (id: SkillId) => void;
  settings: () => void;
  /** 自分の名前を変える（名札の鍵） */
  name: () => void;
  /** このゲームについて（版・作者・権利・プライバシー） */
  about: () => void;
  rules: () => void;
  /** 対局中に開いたメニューから、その対局へ戻る */
  resume: () => void;
  /** 錠の付いた鍵（遊び方を終えるまで遊べない入口）を押した */
  locked: () => void;
}

/** 遊び方を終えるまで閉じる入口。phrase は合言葉の入口を開けておく（初めての人の最初のオンライン対戦） */
export interface MenuGate {
  phrase: boolean;
}

/** 錠の付いた鍵の title */
export const LOCKED_TITLE = "遊び方を終えると遊べます";

export type Panel = "main" | "levels" | "modes" | "skills";

export class Menu {
  private readonly el = {
    root: byId("menu"),
    cpu: byId("menu-cpu"),
    multi: byId("menu-multi"),
    pvp: byId("menu-pvp"),
    note: byId("menu-note"),
    resume: byId("menu-resume"),
    online: byId("menu-online"),
    phrase: byId("menu-phrase"),
    learn: byId("menu-learn"),
    learnState: byId("menu-learn-state"),
    skills: byId("menu-skills"),
    skillsState: byId("menu-skills-state"),
    skillList: byId("skill-lessons"),
    skillCount: byId("menu-skilllist-count"),
    ruleName: byId("menu-rule-name"),
    name: byId("menu-name"),
    nameLabel: byId("menu-name-label"),
    nameText: byId("menu-name-text"),
    panels: { main: byId("menu-main"), levels: byId("menu-levels"), modes: byId("menu-modes"), skills: byId("menu-skilllist") } as Record<Panel, HTMLElement>,
  };

  /** 遊び方を終えるまで閉じる入口（null は閉じない） */
  private gate: MenuGate | null = null;

  constructor(private readonly act: MenuActions) {
    // 錠の付いた鍵は、押しても入口の代わりに act.locked
    const open = (b: HTMLElement, f: () => void) => b.addEventListener("click", () => (b.classList.contains("locked") ? act.locked() : f()));
    open(this.el.cpu, () => this.panel("levels"));
    open(this.el.multi, () => this.panel("modes"));
    this.el.learn.addEventListener("click", () => act.learn());
    this.el.skills.addEventListener("click", () => this.panel("skills"));
    byId("menu-settings").addEventListener("click", () => act.settings());
    this.el.name.addEventListener("click", () => act.name());
    byId("menu-about").addEventListener("click", () => act.about());
    byId("menu-rule").addEventListener("click", () => act.rules());
    this.el.resume.addEventListener("click", () => act.resume());
    open(this.el.pvp, () => act.pvp());
    open(this.el.online, () => act.online());
    open(this.el.phrase, () => act.phrase());
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

  /** 自分の名前（空は名前なし: 「名前を決める」と誘う）。名前は外部入力にもなるので textContent でだけ入れる */
  setName(name: string) {
    this.el.nameLabel.hidden = !name;
    this.el.nameText.textContent = name || "名前を決める";
    this.el.name.classList.toggle("unset", !name);
    this.el.name.title = name ? "名前を変える" : "名前を決める";
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

  /** オンライン対戦の入口（招待リンク・合言葉）を出す（サーバーに届く公開先だけ） */
  enableOnline() {
    this.el.online.hidden = false;
    this.el.phrase.hidden = false;
    this.setGate(this.gate);
  }

  /**
   * 遊び方を終えるまで閉じる入口（null で全部開ける）。閉じた鍵に錠（読み上げは LOCKED_TITLE）を添え、遊び方を主な項目にする。
   * マルチは中に開いている入口（合言葉）があれば開ける
   */
  setGate(gate: MenuGate | null) {
    this.gate = gate;
    const phrase = !!gate?.phrase && !this.el.phrase.hidden;
    this.lock(this.el.cpu, !!gate);
    this.lock(this.el.pvp, !!gate);
    this.lock(this.el.online, !!gate);
    this.lock(this.el.phrase, !!gate && !phrase);
    this.lock(this.el.multi, !!gate && !phrase);
    this.el.cpu.classList.toggle("primary", !gate);
    this.el.learn.classList.toggle("primary", !!gate);
  }

  private lock(b: HTMLElement, on: boolean) {
    // 押せば知らせるので aria-disabled にはしない（錠の読み上げで閉じていると分かる）
    b.classList.toggle("locked", on);
    b.querySelector(".menu-lock")?.remove();
    if (on) b.append(h("span", { class: "menu-lock", attrs: { title: LOCKED_TITLE, "aria-label": LOCKED_TITLE, role: "img" } }));
  }

  private panel(p: Panel, focus = true) {
    for (const [k, el] of Object.entries(this.el.panels)) el.hidden = k !== p;
    // スキル練習の一覧（11 枚の札）は背が高いので、名前の名札をしまって 1 画面に収める
    this.el.name.hidden = p === "skills";
    // 段を切り替えたら、その段の最初のボタンに移る（キーボード操作で迷わないように）
    if (focus) this.el.panels[p].querySelector<HTMLElement>("button:not([hidden])")?.focus();
  }
}
