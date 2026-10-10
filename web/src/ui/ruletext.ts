// 設定からルールの平文を作る（対局画面のルールカード・設定画面・ルール詳細で共用）。
// 各行を要点と補足に分けて返し、DOM への流し込みは呼び出し側（ui/setup.ts の fillSentences）が textContent で行う。

import { kindsByValue, kindsInRules, KIND_ORDER, PIECES, REACH_MARK, type PieceKind, type RuleSet } from "../engine/rules";

/**
 * ルールの 1 行: 要点の一言（大きく太く。1 行に 1 か所だけ）と、その下に小さく添える補足（括弧で囲まず、薄い字）。
 * 要点だけで何のルールか分かるように書き、細かい条件・数字の内訳は補足に回す
 */
export interface Sentence {
  point: string;
  note?: string;
}

/** 返す／取る の活用（返した・返せる・返せない ／ 取った・取れる・取れない） */
export function verb(r: RuleSet) {
  return r.action === "flip"
    ? { past: "返した", can: "返せる", cannot: "返せない", passive: "返されうる", hit: "返された", hitIf: "返されたら" }
    : { past: "取った", can: "取れる", cannot: "取れない", passive: "取られうる", hit: "取られた", hitIf: "取られたら" };
}

export function hpText(r: RuleSet): string {
  return r.hp[0] === r.hp[1] ? `体力 ${r.hp[0]}` : `体力 先手 ${r.hp[0]}・後手 ${r.hp[1]}`;
}

/** 駒の方向のマーク（挟める方向が「駒ごと」のときだけ。全方向なら空文字） */
export const dirMark = (r: RuleSet, k: PieceKind) => (r.dirs === "piece" ? REACH_MARK[PIECES[k].reach].mark : "");

/** 駒の名前と数字（例: 「歩1」） */
export const pieceLabel = (r: RuleSet, k: PieceKind) => `${PIECES[k].name}${r.values[k]}`;

/** 持ち駒の一覧（例: 「歩1 ×14・銀2 ×10」、駒ごとの方向なら「歩1↕ ×8」）。0 個の駒は省く */
export function handText(r: RuleSet): string {
  const parts = kindsByValue(r, KIND_ORDER.filter((k) => r.hand[k] > 0)).map((k) => `${pieceLabel(r, k)}${dirMark(r, k)} ×${r.hand[k]}`);
  return parts.length > 0 ? parts.join("・") : "なし";
}

/** 挟める方向が「駒ごと」のときのルールカードの 1 行（例: 駒ごとに挟める向きが違う 矢印の方向だけ挟める 歩↕ 横↔ 角✕ 飛✚ 金✱） */
export function dirLine(r: RuleSet): Sentence {
  const marks = kindsInRules(r).map((k) => `${PIECES[k].name}${dirMark(r, k)}`).join(" ");
  return { point: "駒ごとに挟める向きが違う", note: `矢印の方向だけ挟める ${marks}` };
}

/** 王を返された（取られた）ときの罰（例: 「体力−20」「即負け」） */
export const kingPenaltyText = (r: RuleSet) => (r.king.penalty === "lose" ? "即負け" : `体力−${r.king.amount}`);

/** 隠し王のルールカードの 1 行（例: 王を返されたら体力−20 最初の5手のうち1つを王にする。相手に見えない） */
export function kingLine(r: RuleSet): Sentence {
  const pick = r.king.deadline === 1 ? "最初に置く駒が王" : `最初の${r.king.deadline}手のうち1つを王にする`;
  return { point: `王を${verb(r).hitIf}${kingPenaltyText(r)}`, note: `${pick}。相手に見えない` };
}

/** 反対側の駒の力（攻撃に上乗せ）のルールカードの 1 行。遊び方と同じく「反対側」と言う */
export const anchorLine = (): Sentence => ({ point: "反対側の自分の駒もダメージに足す", note: "挟んだ列の、置いた駒と反対側にある自分の駒の数字" });

/** 始めの体力（例: 「先手 129・後手 130 から」「どちらも 20 から」） */
const hpStart = (r: RuleSet) => (r.hp[0] === r.hp[1] ? `どちらも ${r.hp[0]} から` : `先手 ${r.hp[0]}・後手 ${r.hp[1]} から`);

/** ルールカードの 3〜8 行（一目で今のルールが分かる短文） */
export function ruleLines(r: RuleSet): Sentence[] {
  const v = verb(r);
  const lines: Sentence[] = [];
  if (r.action === "flip") lines.push({ point: "挟んだ相手の駒を裏返す", note: "挟めるマスにだけ置ける" });
  else lines.push({ point: "挟んだ相手の駒を取って持ち駒にする", note: "空きマスならどこにでも置ける" });
  if (r.dirs === "piece") lines.push(dirLine(r));
  if (r.gate) lines.push({ point: `強い駒を含む列は${v.cannot}`, note: "置いた駒より数字が大きい駒を含む列" });
  if (r.damage === "sum") lines.push({ point: "数字の合計がダメージ", note: `${v.past}駒の数字を足す` });
  else lines.push({ point: "最大の数字＋枚数÷4がダメージ", note: `${v.past}駒の数字と枚数で数える` });
  if (r.anchor === "attack") lines.push(anchorLine());
  if (r.heal === "none") lines.push({ point: "回復なし" });
  else lines.push({ point: "挟むと体力を回復", note: `挟んだ両端の駒の${r.heal === "avg" ? "平均" : "低い方−1"}だけ` });
  if (r.king.on) lines.push(kingLine(r));
  const limit = r.maxPlies > 0 ? `。${r.maxPlies} 手で終われば体力の多い方が勝ち` : "";
  lines.push({ point: "体力が 0 で負け", note: `${hpStart(r)}${limit}` });
  return lines;
}

/** ルール詳細ダイアログ用の補足（カードの各行を正確に言い直したもの） */
export function ruleDetails(r: RuleSet): Sentence[] {
  const v = verb(r);
  const out: Sentence[] = [];
  const piece = r.dirs === "piece";
  const line = piece ? "置いた駒の矢印の方向の一直線" : "8 方向の一直線";
  const keep = piece ? "種類と数字はそのまま" : "数字はそのまま";
  if (r.action === "flip") {
    out.push({
      point: "挟んだ相手の駒を裏返して自分の駒にする",
      note: `持ち駒を 1 つ選んで空きマスに置き、自分の駒との間に${line}に挟む。${keep}。${piece ? "その駒の方向で " : ""}1 枚も返せないマスには置けない`,
    });
  } else {
    out.push({ point: "空いているマスならどこにでも置ける", note: "持ち駒を 1 つ選んで置く" });
    out.push({
      point: "挟んだ相手の駒は取って自分の持ち駒にする",
      note: `自分の駒との間に${line}に挟んだ駒を盤から取る。${keep}`,
    });
    out.push({ point: "挟まれる位置へ自分から置いても取られない", note: "取るのは置いた側だけ" });
  }
  if (piece) {
    const each = kindsInRules(r).map((k) => {
      const m = REACH_MARK[PIECES[k].reach];
      return `${PIECES[k].name}${m.mark} ${m.name}`;
    });
    out.push({
      point: "挟める方向は駒ごとに違う",
      note: `${each.join("・")}。置いた駒の方向に挟んだ列だけ${v.can}。他の方向に挟んでいても${v.cannot}。縦・横は盤の向きで、先手・後手で同じ`,
    });
    out.push({ point: "方向は置く駒だけで決まる", note: "挟まれる側の駒・反対側の自分の駒の矢印は関係ない" });
  }
  if (r.gate) {
    out.push({ point: `置いた駒より数字が大きい駒を含む列は${v.cannot}`, note: `1 つでも入っていれば${v.cannot}。他の方向の列は${v.can}` });
  }
  if (r.damage === "sum") out.push({ point: `ダメージ = ${v.past}駒の数字の合計` });
  else out.push({ point: `ダメージ = ${v.past}駒の数字の最大値 ＋ ${v.past}枚数 ÷ 4`, note: "割り算は切り捨て" });
  if (r.anchor === "attack") {
    out.push({
      point: "反対側の自分の駒もダメージに足す",
      note: `${v.past}列ごとに、もともと盤上にあって挟むのに使った駒の数字を足す。2 列${v.past}ら両方の列の反対側を足す。${v.cannot}列の反対側は足さない。置いた駒の数字は足さない`,
    });
    out.push({
      point: "強い駒は何度もダメージを上乗せできる拠点になる",
      note: r.action === "flip" ? "逆に返されると相手の拠点になる" : "逆に取られると相手の持ち駒になる",
    });
  }
  const ends = "両端は置いた駒と反対側の自分の駒";
  if (r.heal === "avg") {
    out.push({ point: "回復 = 挟んだ両端の数字の平均", note: `${ends}。切り捨て。複数方向なら最も大きい 1 方向分` });
  } else if (r.heal === "lowMinus1") {
    out.push({ point: "回復 = 挟んだ両端の低い方 − 1", note: `${ends}。0 未満は 0。複数方向なら最も大きい 1 方向分` });
  } else {
    out.push({ point: "回復はない" });
  }
  if (r.king.on) {
    const n = r.king.deadline;
    out.push(
      n === 1
        ? { point: "隠し王: 最初に置く駒が王になる", note: "相手には見えない" }
        : {
            point: `隠し王: 最初の ${n} 手のうち 1 手で、置く駒を王にする`,
            note: `置く前に「この駒を王にする」を選ぶ。1 人 1 回で、相手には見えない。盤上にある駒を後から王にはできない。${n} 手目までに選ばなかったら、${n} 手目に置いた駒が自動で王になる`,
          },
    );
    out.push(
      r.king.penalty === "lose"
        ? { point: `王を${v.hitIf}その時点で負け` }
        : {
            point: `王を${v.hitIf}体力 −${r.king.amount}`,
            note: "通常のダメージに加えて減る。王は公開され、以後はふつうの駒。選び直しはない",
          },
    );
    out.push({ point: "予測のダメージに相手の王の罰は含めない", note: "どれが王かは分からない" });
  }
  return out;
}

/** 決着の説明 */
export function endDetails(r: RuleSet): Sentence[] {
  const stall = r.action === "flip" ? "持ち駒切れか置けるマスがなければパス" : "持ち駒が尽きたらパス";
  return [
    { point: r.king.on && r.king.penalty === "lose" ? `体力が 0 以下になるか、王を${verb(r).hitIf}その時点で負け` : "体力が 0 以下になった時点で負け" },
    r.maxPlies > 0 ? { point: `総手数 ${r.maxPlies} 手で打ち切り`, note: "体力の多い方の勝ち" } : { point: "手数の上限なし" },
    { point: stall, note: "パスは手数に数えない。両者とも打てなくなったら終局" },
    { point: "判定は体力、次に石数の多い方の勝ち", note: "両方同じなら引き分け" },
  ];
}

/** 平文にする（補足は空白で区切る。画面の textContent と同じ） */
export const sentenceText = (s: Sentence) => (s.note ? `${s.point} ${s.note}` : s.point);
