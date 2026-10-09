// 遊び方（チュートリアル）のコーチ: ステップの石の列・見出し・覚えるルールの要点（大きく）と補足（小さく）・課題・ヒント／できたの 1 文・「もう一度」「次へ」。
// 表示と入力だけで、局面と判定は ui/lessons.ts、盤の誘導は ui/app.ts が受け持つ。

import { KIND_ORDER, PIECES } from "../engine/rules";
import { byId, h } from "./dom";

/** 目で拾ってほしい語: 数字と、駒の名前の付いた数字（例: 「金5」「2」） */
const KEY_WORD = new RegExp(`(?:[${KIND_ORDER.map((k) => PIECES[k].name).join("")}](?=\\d))?\\d+`, "g");

/** 文を地の文と目で拾ってほしい語（key）に分ける（DOM なし） */
export function keyParts(text: string): { text: string; key: boolean }[] {
  const out: { text: string; key: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(KEY_WORD)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), key: false });
    out.push({ text: m[0], key: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), key: false });
  return out;
}

/** 文の数字・駒の名前の付いた数字を太字（<b class="coach-key">）に分けた子要素の列。文は textContent で入れる */
const keyWords = (text: string) => keyParts(text).map((p) => (p.key ? h("b", { class: "coach-key", text: p.text }) : p.text));

export interface CoachActions {
  next: () => void;
  again: () => void;
  /** ステップの石を押して、そのステップへ移る */
  jump: (index: number) => void;
}

export class Coach {
  private readonly el = {
    root: byId("coach"),
    steps: byId("coach-steps"),
    num: byId("coach-num"),
    title: byId("coach-title"),
    point: byId("coach-point"),
    note: byId("coach-note"),
    task: byId("coach-task"),
    msg: byId("coach-msg"),
    actions: byId("coach-actions"),
    again: byId("coach-again"),
    next: byId("coach-next"),
  };

  constructor(private readonly act: CoachActions) {
    this.el.again.addEventListener("click", () => act.again());
    this.el.next.addEventListener("click", () => act.next());
  }

  get visible(): boolean {
    return !this.el.root.hidden;
  }

  /**
   * ステップ i（0 始まり）を出す。titles は全ステップの見出し、open は押して移れる最も先のステップ
   * （それより先の石は押せない）
   */
  show(i: number, titles: readonly string[], open: number, point: string, note: string | undefined, task: string) {
    const { el } = this;
    el.root.hidden = false;
    el.num.textContent = `${i + 1}/${titles.length}`;
    el.title.textContent = titles[i];
    el.point.textContent = point;
    el.note.replaceChildren(...keyWords(note ?? ""));
    el.note.hidden = !note;
    el.task.textContent = task;
    el.steps.replaceChildren(
      ...titles.map((t, j) => {
        const b = h("button", {
          class: `coach-dot${j < i ? " done" : ""}${j === i ? " current" : ""}`,
          attrs: { type: "button", "aria-label": `${j + 1}. ${t}`, title: `${j + 1}. ${t}`, ...(j === i ? { "aria-current": "step" } : {}) },
        });
        b.disabled = j > open || j === i;
        b.addEventListener("click", () => this.act.jump(j));
        return h("li", {}, [b]);
      }),
    );
    this.clearMessage();
  }

  /** 違う手のヒント（揺らして知らせる。盤は変えない） */
  hint(text: string) {
    this.message("hint", text);
  }

  /** できた: 何が起きたかの 1 文と「次へ」（next が null なら最後。「もう一度」も出さない） */
  success(text: string, next: string | null) {
    this.message("ok", text);
    this.el.actions.hidden = next === null;
    if (next !== null) {
      this.el.next.textContent = next;
      this.el.next.focus({ preventScroll: true });
    }
    // スマホはコーチが駒台の下にあり、できたの文と「次へ」が画面の下にはみ出ることがある。はみ出た分だけ寄せる（盤は画面に残る）
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.el.root.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }

  hide() {
    this.el.root.hidden = true;
    this.clearMessage();
  }

  private clearMessage() {
    this.el.msg.hidden = true;
    this.el.msg.textContent = "";
    this.el.msg.className = "coach-msg";
    this.el.actions.hidden = true;
  }

  private message(kind: "hint" | "ok", text: string) {
    const m = this.el.msg;
    // 先頭の印（::before）と文を flex で並べるので、文は 1 つの span にまとめる（太字の語で折り返しが割れないように）
    m.replaceChildren(h("span", {}, keyWords(text)));
    m.hidden = false;
    m.className = `coach-msg ${kind}`;
    // ヒントは揺らし、できたは浮かせる（同じヒントが続いても揺れるように、アニメーションをかけ直す）
    void m.offsetWidth;
    m.classList.add(kind === "hint" ? "shake" : "pop");
  }
}
