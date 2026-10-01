// 設定からルールの平文を作る（対局画面のルールカード・設定画面・ルール詳細で共用）。
// 強調したい部分は strong に分けて返し、DOM への流し込みは呼び出し側が textContent で行う。

import { KIND_ORDER, PIECES, type RuleSet } from "../engine/rules";

export type Segment = string | { strong: string };
export type Sentence = Segment[];

/** 返す／取る の活用（返した・返せる・返せない ／ 取った・取れる・取れない） */
export function verb(r: RuleSet) {
  return r.action === "flip"
    ? { past: "返した", can: "返せる", cannot: "返せない", passive: "返されうる" }
    : { past: "取った", can: "取れる", cannot: "取れない", passive: "取られうる" };
}

export function hpText(r: RuleSet): string {
  return r.hp[0] === r.hp[1] ? `体力 ${r.hp[0]}` : `体力 先手 ${r.hp[0]}・後手 ${r.hp[1]}`;
}

/** 持ち駒の一覧（例: 「歩1 ×14・銀2 ×10」）。0 個の駒は省く */
export function handText(r: RuleSet): string {
  const parts = KIND_ORDER.filter((k) => r.hand[k] > 0).map((k) => `${PIECES[k].name}${PIECES[k].value} ×${r.hand[k]}`);
  return parts.length > 0 ? parts.join("・") : "なし";
}

/** ルールカードの 3〜5 行（一目で今のルールが分かる短文） */
export function ruleLines(r: RuleSet): Sentence[] {
  const v = verb(r);
  const lines: Sentence[] = [];
  if (r.action === "flip") {
    lines.push(["挟んだ相手の駒を", { strong: "裏返す" }, "（挟めるマスにしか置けない）"]);
  } else {
    lines.push(["空きマスなら", { strong: "どこにでも置け" }, "、挟んだ相手の駒を", { strong: "取って自分の持ち駒にする" }]);
  }
  if (r.gate) lines.push(["置いた駒より", { strong: "数字が大きい駒" }, `を含む列は${v.cannot}`]);
  if (r.damage === "sum") lines.push([`${v.past}駒の`, { strong: "数字の合計" }, "がダメージ"]);
  else lines.push([`${v.past}駒の`, { strong: "最大の数字＋枚数÷4" }, "がダメージ"]);
  if (r.heal === "none") lines.push(["回復なし"]);
  else if (r.heal === "avg") lines.push(["挟んだ両端の駒の", { strong: "平均" }, "だけ回復"]);
  else lines.push(["挟んだ両端の駒の", { strong: "低い方−1" }, "だけ回復"]);
  const limit = r.maxPlies > 0 ? `（${r.maxPlies} 手で終われば体力の多い方が勝ち）` : "";
  lines.push([`${hpText(r)} が `, { strong: "0 で負け" }, limit]);
  return lines;
}

/** ルール詳細ダイアログ用の補足（カードの各行を正確に言い直したもの） */
export function ruleDetails(r: RuleSet): Sentence[] {
  const v = verb(r);
  const out: Sentence[] = [];
  if (r.action === "flip") {
    out.push([
      "持ち駒を 1 つ選んで空きマスに置き、自分の駒との間に一直線（8 方向）に挟んだ相手の駒を",
      { strong: "裏返して自分の駒にする" },
      "（数字はそのまま）。1 枚も返せないマスには置けない",
    ]);
  } else {
    out.push([
      "持ち駒を 1 つ選んで",
      { strong: "空いているマスならどこにでも" },
      "置ける。自分の駒との間に一直線（8 方向）に挟んだ相手の駒は",
      { strong: "盤から取り、数字そのままで自分の持ち駒にする" },
    ]);
    out.push(["挟まれる位置へ自分から置いても取られない（取るのは置いた側だけ）"]);
  }
  if (r.gate) {
    out.push([
      "置いた駒より数字が大きい駒が 1 つでも入っている列は",
      { strong: v.cannot },
      `（他の方向の列は${v.can}）`,
    ]);
  }
  if (r.damage === "sum") out.push([`ダメージ = ${v.past}駒の数字の合計`]);
  else out.push([`ダメージ = ${v.past}駒の数字の最大値 ＋ ${v.past}枚数 ÷ 4（切り捨て）`]);
  if (r.heal === "avg") {
    out.push(["回復 = 挟んだ両端（置いた駒と反対端の自分の駒）の数字の平均（切り捨て）。複数方向なら最も大きい 1 方向分"]);
  } else if (r.heal === "lowMinus1") {
    out.push(["回復 = 挟んだ両端（置いた駒と反対端の自分の駒）の低い方 − 1（0 未満は 0）。複数方向なら最も大きい 1 方向分"]);
  } else {
    out.push(["回復はない"]);
  }
  return out;
}

/** 決着の説明 */
export function endDetails(r: RuleSet): string[] {
  const stall = r.action === "flip" ? "持ち駒切れか置けるマスがなければパス" : "持ち駒が尽きたらパス";
  return [
    "体力が 0 以下になった時点で負け",
    r.maxPlies > 0 ? `総手数 ${r.maxPlies} 手で打ち切り。体力の多い方の勝ち` : "手数の上限なし",
    `${stall}（手数に数えない）。両者とも打てなくなったら終局`,
    "判定は 体力 → 石数 の多い方の勝ち。両方同じなら引き分け",
  ];
}

export const sentenceText = (s: Sentence) => s.map((x) => (typeof x === "string" ? x : x.strong)).join("");
