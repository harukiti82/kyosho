// 遊び方（チュートリアル）のコーチ: ステップの石の列・見出し・目標・ヒント／できたの 1 文・「もう一度」「次へ」。
// 表示と入力だけで、局面と判定は ui/lessons.ts、盤の誘導は ui/app.ts が受け持つ。

import { byId, h } from "./dom";

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
    goal: byId("coach-goal"),
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
  show(i: number, titles: readonly string[], open: number, goal: string) {
    const { el } = this;
    el.root.hidden = false;
    el.num.textContent = `${i + 1}/${titles.length}`;
    el.title.textContent = titles[i];
    el.goal.textContent = goal;
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
    m.textContent = text;
    m.hidden = false;
    m.className = `coach-msg ${kind}`;
    // ヒントは揺らし、できたは浮かせる（同じヒントが続いても揺れるように、アニメーションをかけ直す）
    void m.offsetWidth;
    m.classList.add(kind === "hint" ? "shake" : "pop");
  }
}
