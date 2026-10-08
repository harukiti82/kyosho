// オンライン対戦の案内ダイアログ（部屋の作成中・招待リンクと相手の待機・招待されたときの参加の確認・エラー）。
// 表示だけを受け持ち、通信と対局の進行は app.ts（通信層は net/online.ts）が行う。

import { PLAYER_NAME, type Player, type RuleSet } from "../engine/rules";
import { turnSecondsText } from "./clock";
import { byId, h } from "./dom";
import { ruleLines } from "./ruletext";
import { fillSentences } from "./setup";

export interface DialogAction {
  label: string;
  primary?: boolean;
  id?: string;
  onClick: () => void;
}

/** この部屋のルール（見出し「ルール 名前」を押すと開く） */
function roomRules(rules: RuleSet, name: string, open = false) {
  const list = h("ol", { class: "rules4-list" });
  fillSentences(list, ruleLines(rules));
  const box = h("details", { class: "online-rules" }, [h("summary", {}, ["ルール ", h("span", { class: "tab-sub", text: name })]), list]);
  box.open = open;
  return box;
}

/** この部屋の 1 手の制限時間（切れたときの動きは title） */
function roomTime(turnSeconds: number) {
  const text = turnSeconds > 0 ? `1 手 ${turnSecondsText(turnSeconds)}` : "時間制限なし";
  const title = turnSeconds > 0 ? "切れたら置ける手から自動で 1 手" : "1 手の制限時間なし";
  return h("p", { class: "online-time", attrs: { id: "room-time", title }, text });
}

export class OnlineDialog {
  private readonly el = {
    dialog: byId<HTMLDialogElement>("online"),
    title: byId("online-title"),
    content: byId("online-content"),
    actions: byId("online-actions"),
  };
  /** 今出している画面の種類（e2e と表示の切り替えの確認用に data-view にも入れる） */
  view: "busy" | "invite" | "join" | "error" | null = null;

  constructor() {
    // Esc で閉じない（閉じると何も操作できない画面になるため、ボタンで抜ける）
    this.el.dialog.addEventListener("cancel", (e) => e.preventDefault());
  }

  get isOpen() {
    return this.el.dialog.open;
  }

  /** 待ち（部屋を作っている・接続している） */
  busy(title: string, note?: string) {
    this.show("busy", title, [h("p", { class: "online-wait" }, [h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }), note ?? "少しお待ちください"])], []);
  }

  /** 招待リンクと相手の待機（作成者） */
  invite(o: { url: string; rules: RuleSet; ruleName: string; turnSeconds: number; you: Player; onLeave: () => void }) {
    const input = h("input", { class: "share-url invite-url", attrs: { type: "text", readonly: "", id: "invite-url", "aria-label": "招待リンク" } });
    input.value = o.url;
    input.addEventListener("focus", () => input.select());
    const status = h("span", { class: "share-status", attrs: { role: "status", id: "invite-status" } });
    const copy = h("button", { class: "btn primary", text: "リンクをコピー", attrs: { type: "button", id: "invite-copy" } });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(o.url);
        status.textContent = "コピーしました";
      } catch {
        status.textContent = "コピーできませんでした。リンクを選んでコピーしてください";
        input.focus();
        input.select();
      }
    });
    const buttons: HTMLElement[] = [copy];
    if (typeof navigator.share === "function") {
      const share = h("button", { class: "btn ghost", text: "共有", attrs: { type: "button", id: "invite-share" } });
      share.addEventListener("click", () => {
        navigator.share({ title: "挟将で対戦しよう", text: `挟将（${o.ruleName}）で対戦しよう`, url: o.url }).catch(() => {});
      });
      buttons.push(share);
    }
    this.show(
      "invite",
      "対戦相手を招待",
      [
        // 対局アプリの対戦待ちのように、自分の席と空いている相手の席を並べる
        h("div", { class: "lobby" }, [
          h("div", { class: "lobby-seat" }, [
            h("span", { class: `avatar p${o.you}`, attrs: { "aria-hidden": "true" } }),
            h("span", { class: "lobby-name", text: "あなた" }),
            h("span", { class: "online-seat", text: PLAYER_NAME[o.you] }),
          ]),
          h("span", { class: "lobby-vs", text: "VS", attrs: { "aria-hidden": "true" } }),
          h("div", { class: "lobby-seat waiting", attrs: { id: "invite-waiting" } }, [
            h("span", { class: "avatar empty", attrs: { "aria-hidden": "true" } }),
            h("span", { class: "lobby-name", text: "相手" }),
            h("span", { class: "online-wait" }, [h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }), "参加待ち"]),
          ]),
        ]),
        h("p", { class: "online-lead", text: "相手がこのリンクから参加すると始まります" }),
        input,
        h("div", { class: "share invite-actions" }, [...buttons, status]),
        roomTime(o.turnSeconds),
        roomRules(o.rules, o.ruleName),
      ],
      [{ label: "やめる", id: "invite-leave", onClick: o.onLeave }],
    );
  }

  /** 招待リンクから開いたときの参加の確認 */
  join(o: { rules: RuleSet; ruleName: string; turnSeconds: number; createdHere: boolean; onJoin: () => void; onCancel: () => void }) {
    this.show(
      "join",
      "対戦の招待",
      [
        h("div", { class: "lobby" }, [
          h("div", { class: "lobby-seat" }, [
            // 先手・後手はまだ分からないので、白黒半分の石
            h("span", { class: "avatar half", attrs: { "aria-hidden": "true" } }),
            h("span", { class: "lobby-name", text: "招いた人" }),
          ]),
          h("span", { class: "lobby-vs", text: "VS", attrs: { "aria-hidden": "true" } }),
          h("div", { class: "lobby-seat" }, [
            h("span", { class: "avatar half", attrs: { "aria-hidden": "true" } }),
            h("span", { class: "lobby-name", text: "あなた" }),
          ]),
        ]),
        h("p", { class: "online-lead", text: "先手・後手は部屋を作った人が決めます" }),
        o.createdHere
          ? h("p", {
              class: "setup-note",
              attrs: { id: "join-own", title: "相手と遊ぶなら、参加せずにリンクを相手に送ってください" },
              text: "このブラウザで作った部屋なので、参加すると自分が相手の席に座ります。",
            })
          : null,
        roomTime(o.turnSeconds),
        roomRules(o.rules, o.ruleName, true),
      ],
      [
        { label: "参加しない", onClick: o.onCancel },
        { label: "参加する", primary: true, id: "join-room", onClick: o.onJoin },
      ],
    );
  }

  error(title: string, message: string, actions: DialogAction[]) {
    this.show("error", title, [h("p", { class: "online-error", attrs: { role: "alert" }, text: message })], actions);
  }

  close() {
    this.view = null;
    if (this.el.dialog.open) this.el.dialog.close();
  }

  private show(view: NonNullable<OnlineDialog["view"]>, title: string, content: (HTMLElement | null)[], actions: DialogAction[]) {
    this.view = view;
    this.el.dialog.dataset.view = view;
    this.el.title.textContent = title;
    this.el.content.replaceChildren(...content.filter((x): x is HTMLElement => x !== null));
    this.el.actions.replaceChildren(
      ...actions.map((a) => {
        const b = h("button", { class: `btn ${a.primary ? "primary" : "ghost"}`, text: a.label, attrs: { type: "button", ...(a.id ? { id: a.id } : {}) } });
        b.addEventListener("click", a.onClick);
        return b;
      }),
    );
    if (!this.el.dialog.open) this.el.dialog.showModal();
    // 読み上げとキーボードの起点をタイトルに置く
    this.el.title.focus();
  }
}
