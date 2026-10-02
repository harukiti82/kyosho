// 駒が挟める方向のアイコン（盤上の駒・持ち駒・設定画面）。
// 文字の ↕ ↔ ✕ ✚ ✱ はフォントによって大きさが揃わないため、SVG の線で描く（innerHTML は使わない）。

import { REACH_MARK, type Reach } from "../engine/rules";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 線（24×24 の座標で [x1, y1, x2, y2]）。縦・横は矢じり付き（1 本線だけだと方向に見えにくい） */
const RAYS: Record<Reach, [number, number, number, number][]> = {
  vertical: [[12, 2, 12, 22], [12, 2, 7, 7], [12, 2, 17, 7], [12, 22, 7, 17], [12, 22, 17, 17]],
  horizontal: [[2, 12, 22, 12], [2, 12, 7, 7], [2, 12, 7, 17], [22, 12, 17, 7], [22, 12, 17, 17]],
  diagonal: [[4, 4, 20, 20], [20, 4, 4, 20]],
  orthogonal: [[12, 2, 12, 22], [2, 12, 22, 12]],
  all: [[12, 2, 12, 22], [2, 12, 22, 12], [5, 5, 19, 19], [19, 5, 5, 19]],
};

/** 方向のアイコン（装飾。読み上げは aria-label 側の文で行う）。data-mark に対応する文字を持つ */
export function dirIcon(reach: Reach, cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `${cls} d-${reach}`);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.mark = REACH_MARK[reach].mark;
  for (const [x1, y1, x2, y2] of RAYS[reach]) {
    const line = document.createElementNS(SVG_NS, "line");
    for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(k, String(v));
    svg.append(line);
  }
  return svg;
}
