// スキルのカード（タロットカード風）の表示: カードの面・絵柄・対局の前に 3 枚から 1 枚を選ぶダイアログ・名札のゲージ。
// タロットは名前と意味の対応だけを借り、絵柄は石・駒・盤の格子で描くゲーム独自のもの。ルールの計算はしない（engine の値を読むだけ）。

import type { Player, RuleSet } from "../engine/rules";
import { gaugeMax, GAUGE_UNIT, SKILLS, type SkillId, type SkillSide } from "../engine/skills";
import { byId, h } from "./dom";
import { skillText } from "./ruletext";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>, children: SVGElement[] = []): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** 駒の形（将棋の駒の五角形）。中心 cx・下端 y・幅 w */
const piece = (cx: number, y: number, w: number, cls: string) => {
  const hh = w * 1.15;
  const pts = [
    [cx, y - hh],
    [cx + w * 0.4, y - hh * 0.75],
    [cx + w * 0.5, y],
    [cx - w * 0.5, y],
    [cx - w * 0.4, y - hh * 0.75],
  ];
  return svg("polygon", { class: cls, points: pts.map((p) => p.join(",")).join(" ") });
};
const stone = (cx: number, cy: number, r: number, cls: string) => svg("circle", { class: cls, cx, cy, r });
const line = (x1: number, y1: number, x2: number, y2: number, cls = "ln") => svg("line", { class: cls, x1, y1, x2, y2 });

/** 8 方向の光線（中心から r1〜r2） */
const rays = (cx: number, cy: number, r1: number, r2: number, n = 8, cls = "ln") =>
  Array.from({ length: n }, (_, i) => {
    const a = (Math.PI * 2 * i) / n;
    return line(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2, cls);
  });

/** カードの絵柄（60×60。背景は盤の格子） */
export function tarotArt(id: SkillId): SVGSVGElement {
  const root = svg("svg", { class: "tarot-art", viewBox: "0 0 60 60", "aria-hidden": "true" }) as SVGSVGElement;
  root.append(svg("path", { class: "grid", d: "M0 20H60M0 40H60M20 0V60M40 0V60" }));
  const art: SVGElement[] = (() => {
    switch (id) {
      case "firstaid":
        // 盤の星（格子の交点の点）と小さな十字
        return [stone(20, 40, 4, "fill-w"), line(38, 14, 38, 26, "ln thick"), line(32, 20, 44, 20, "ln thick")];
      case "bigheal":
        // 大きな白石に紺の十字
        return [stone(30, 31, 17, "fill-w"), line(30, 21, 30, 41, "ln-navy"), line(20, 31, 40, 31, "ln-navy")];
      case "strong":
        // 黒石と打撃の線
        return [...rays(30, 30, 15, 24, 8, "ln thick"), stone(30, 30, 11, "fill-b")];
      case "omni":
        // 白石から 8 方向の線
        return [...rays(30, 30, 9, 26), stone(30, 30, 8, "fill-w")];
      case "refill":
        // 重ねた駒と戻る矢印
        return [
          piece(24, 50, 16, "fill-w"),
          piece(24, 38, 16, "fill-w dim"),
          svg("path", { class: "ln", d: "M44 46 V18 M38 24 L44 17 L50 24" }),
        ];
      case "wall":
        // 黒石と白石を交互に積んだ壁
        return [0, 1, 2].flatMap((i) => [stone(14 + i * 16, 22, 7, i % 2 ? "fill-w" : "fill-b"), stone(14 + i * 16, 38, 7, i % 2 ? "fill-b" : "fill-w")]);
      case "scout":
        // 伏せた駒と、それを見通す輪
        return [piece(26, 48, 20, "fill-w dim"), stone(36, 24, 11, "ring"), line(44, 32, 52, 40, "ln thick")];
      case "kingmove":
        // 元の駒（線だけ）から新しい駒へ
        return [piece(16, 48, 16, "ring"), piece(44, 30, 16, "fill-w"), svg("path", { class: "ln", d: "M20 26 Q28 12 36 18" })];
    }
  })();
  root.append(...art);
  return root;
}

/**
 * カードの面: 番号（ローマ数字）・絵柄・スキルの名前・タロットの名前・効果の一言・ゲージの長さ。
 * button なら選ぶ画面のカード（aria-pressed）、そうでなければ演出・表示用
 */
export function tarotCard(id: SkillId, rules: RuleSet, opts: { button?: boolean; cls?: string } = {}): HTMLElement {
  const s = SKILLS[id];
  const t = skillText(id, rules);
  const children = [
    h("span", { class: "tarot-num", text: s.numeral, attrs: { "aria-hidden": "true" } }),
    tarotArt(id),
    h("span", { class: "tarot-name", text: s.name }),
    h("span", { class: "tarot-arcana", text: s.tarot }),
    h("span", { class: "tarot-effect", text: t.short }),
    // ゲージの長さ（いちばん長い大回復 80 を全幅）
    h("span", { class: "tarot-len", attrs: { "aria-hidden": "true", style: `--len:${s.length / 80}` } }, [h("i"), h("b", { text: String(s.length) })]),
  ];
  const cls = `tarot t-${id}${opts.cls ? ` ${opts.cls}` : ""}`;
  const label = `${s.name}。${t.point}。${t.note}。ゲージ ${s.length}`;
  if (opts.button) {
    return h("button", { class: cls, attrs: { type: "button", "data-skill": id, "aria-pressed": "false", "aria-label": label, title: `${t.point}。${t.note}` } }, children);
  }
  return h("div", { class: cls, attrs: { "data-skill": id, role: "img", "aria-label": label } }, children);
}

export interface PickView {
  /** 選ぶ人の呼び方（「あなた」「先手」など） */
  who: string;
  /** 選ぶ人の石（2 人対戦は先手・後手を石で示す）。出さないなら null */
  stone: Player | null;
  offer: SkillId[];
  rules: RuleSet;
  /** もう選んだカード（オンラインで相手を待っている間） */
  chosen: SkillId | null;
  onPick: (id: SkillId) => void;
  onMenu: () => void;
}

/** 対局の前に、配られた 3 枚から 1 枚を選ぶダイアログ（#skill-pick） */
export class SkillPick {
  private readonly dialog = byId<HTMLDialogElement>("skill-pick");
  private readonly body = byId("skill-pick-body");
  private readonly actions = byId("skill-pick-actions");
  private key = "";
  private sel: SkillId | null = null;
  private view: PickView | null = null;

  constructor() {
    // Esc では閉じない（選ばないと始まらない。メニューへは「メニュー」）
    this.dialog.addEventListener("cancel", (e) => e.preventDefault());
  }

  get open() {
    return this.dialog.open;
  }

  /** 選ぶ画面を出す（同じ中身なら描き直さない） */
  show(v: PickView) {
    const key = [v.who, v.offer.join(","), v.chosen ?? ""].join("|");
    this.view = v;
    if (key !== this.key) {
      this.key = key;
      this.sel = null;
      this.draw();
    }
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    this.key = "";
    this.view = null;
    if (this.dialog.open) this.dialog.close();
  }

  private draw() {
    const v = this.view!;
    const waiting = v.chosen !== null;
    const head = h("p", { class: "pick-who" }, [
      v.stone !== null ? h("i", { class: `seg-stone p${v.stone}`, attrs: { "aria-hidden": "true" } }) : null,
      waiting ? "相手が選んでいます" : `${v.who}のカード`,
    ]);
    const cards = (waiting ? [v.chosen!] : v.offer).map((id) => {
      const card = tarotCard(id, v.rules, { button: !waiting, cls: waiting ? "chosen" : "" });
      if (!waiting) card.addEventListener("click", () => this.select(id));
      return card;
    });
    const detail = h("div", { class: "pick-detail", attrs: { id: "skill-pick-detail", "aria-live": "polite" } });
    this.body.replaceChildren(head, h("div", { class: `tarot-row${waiting ? " one" : ""}` }, cards), detail);
    const menu = h("button", { class: "btn ghost", text: "メニュー", attrs: { type: "button", id: "skill-pick-menu" } });
    menu.addEventListener("click", () => v.onMenu());
    if (waiting) {
      this.showDetail(v.chosen!);
      this.actions.replaceChildren(menu);
      return;
    }
    const ok = h("button", { class: "btn primary", text: "このカードにする", attrs: { type: "button", id: "skill-pick-ok" } }) as HTMLButtonElement;
    ok.disabled = true;
    ok.addEventListener("click", () => {
      if (this.sel) v.onPick(this.sel);
    });
    this.actions.replaceChildren(menu, ok);
    this.showDetail(null);
  }

  private select(id: SkillId) {
    this.sel = id;
    for (const b of this.body.querySelectorAll<HTMLElement>(".tarot")) b.setAttribute("aria-pressed", String(b.dataset.skill === id));
    const ok = this.actions.querySelector<HTMLButtonElement>("#skill-pick-ok");
    if (ok) ok.disabled = false;
    this.showDetail(id);
  }

  /** 選んだカードの効果（要点と補足）。選ぶ前は案内の一言 */
  private showDetail(id: SkillId | null) {
    const box = this.body.querySelector("#skill-pick-detail")!;
    const v = this.view!;
    if (!id) {
      box.replaceChildren(h("p", { class: "rule-note", text: "1 枚選ぶ。ゲージが満タンになるたびに使える" }));
      return;
    }
    const t = skillText(id, v.rules);
    box.replaceChildren(h("p", { class: "rule-point", text: t.point }), h("p", { class: "rule-note", text: t.note }));
  }
}

/** ゲージの割合（0〜1） */
export const gaugeRatio = (side: SkillSide) => (side.card ? Math.min(1, side.gauge / gaugeMax(side.card)) : 0);

/** ゲージの残り（満タンまでの点。小数は切り上げ） */
export const gaugeLeft = (side: SkillSide) => (side.card ? Math.ceil((gaugeMax(side.card) - side.gauge) / GAUGE_UNIT) : 0);
