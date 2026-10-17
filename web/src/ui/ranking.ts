// エンドレスマッチのランキングのダイアログ（上位・自分の順位・自分の最高）。名前は外部入力なので textContent でだけ入れる。
// 通信は App が net/endless.ts の getRanking で行い、ここは描くだけ。

import type { RankEntry, RankingResponse } from "../net/protocol";
import { byId, h } from "./dom";

/** 名前なしの人の呼び名 */
export const NAMELESS = "名無し";

export class RankingDialog {
  private readonly dialog = byId<HTMLDialogElement>("ranking");
  private readonly me = byId("ranking-me");
  private readonly list = byId("ranking-list");
  private readonly retry = byId<HTMLButtonElement>("ranking-retry");
  private load: (() => void) | null = null;

  constructor() {
    byId("ranking-close").addEventListener("click", () => this.dialog.close());
    this.retry.addEventListener("click", () => this.load?.());
  }

  get open(): boolean {
    return this.dialog.open;
  }

  /** 読み込み中で開く。load は読み直し（「再試行」） */
  loading(load: () => void) {
    this.load = load;
    this.retry.hidden = true;
    this.me.replaceChildren(h("span", { class: "rank-wait", text: "読み込み中…" }));
    this.list.replaceChildren();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** 読めなかった */
  failed() {
    this.retry.hidden = false;
    this.me.replaceChildren(h("span", { class: "rank-wait", text: "ランキングを読めませんでした" }));
  }

  /** 読めた。best はこの端末の最高（ランキングに載る前の 0 を含む） */
  show(res: RankingResponse, best: number | null) {
    this.retry.hidden = true;
    const mine = res.me;
    this.me.replaceChildren(
      mine
        ? h("span", { class: "rank-me-line" }, [
            h("span", { class: "rank-me-label", text: "あなた" }),
            h("strong", { class: "rank-me-no", text: `${mine.rank}位` }),
            h("span", { class: "rank-me-best", text: `最高 ${mine.best}連勝` }),
          ])
        : h("span", { class: "rank-wait", text: best ? `最高 ${best}連勝` : "1 勝するとランキングに載ります" }),
      h("span", { class: "rank-total", text: `${res.total}人` }),
    );
    this.list.replaceChildren(...(res.top.length > 0 ? res.top.map((e) => row(e)) : [h("li", { class: "rank-empty", text: "まだ誰も載っていません" })]));
  }
}

function row(e: RankEntry): HTMLElement {
  return h("li", { class: `rank-row${e.me ? " me" : ""}`, attrs: e.me ? { "aria-current": "true" } : {} }, [
    h("span", { class: "rank-no", text: String(e.rank) }),
    h("span", { class: `rank-name${e.name ? "" : " nameless"}`, text: e.name ?? NAMELESS, attrs: { title: e.name ?? NAMELESS } }),
    h("span", { class: "rank-best" }, [h("strong", { text: String(e.best) }), h("small", { text: "連勝" })]),
  ]);
}
