// 端の駒の力（攻撃に上乗せ）のテスト: 列ごとの上乗せ・返せない列・取るモード・設定なし・隠し王・即終局・CPU・URL・ルール文

import { describe, expect, it } from "vitest";
import { SIZE, type Board } from "../src/engine/board";
import { chooseLookahead, lookaheadCandidates } from "../src/engine/cpu";
import { bestReply, createGame, isLegal, kingInfo, lastMoveOf, playMove, previewMove, viewFor, type GameState } from "../src/engine/game";
import { matchPreset, presetById, sameRules, type PieceKind, type Player, type RuleSet } from "../src/engine/rules";
import { decodeRules, encodeRules } from "../src/ui/query";
import { ruleDetails, ruleLines, sentenceText } from "../src/ui/ruletext";
import { at, rulesOf, stateOf } from "./helpers";

/** stones: { "d4": [持ち主, 駒種], ... } から盤面を作る */
function boardOfKinds(stones: Record<string, readonly [Player, PieceKind]>): Board {
  const b: Board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const [name, [owner, kind]] of Object.entries(stones)) {
    const [r, c] = at(name);
    b[r][c] = { owner, kind };
  }
  return b;
}

const ANCHOR = rulesOf("anchor");
/** 拠点プリセットから隠し王を外したもの（歩1 横1 角3 飛3 金5・駒ごとの方向） */
const BASE = rulesOf("anchor", { king: { ...ANCHOR.king, on: false } });
const NONE: RuleSet = { ...BASE, anchor: "none" };
const names = (cells: readonly { r: number; c: number }[]) => cells.map(({ r, c }) => `${"abcdefgh"[c]}${r + 1}`);

function play(s: GameState, name: string, kind: PieceKind, opts: { king?: boolean } = {}) {
  const [r, c] = at(name);
  return playMove(s, r, c, kind, opts);
}

describe("1 列: 返した駒の数字 ＋ 端の自分の駒の数字", () => {
  // 先手が a1 に歩を置き、端の金5（a4）とで a2・a3 の歩1 を縦に挟む
  const board = boardOfKinds({ a2: [1, "fu"], a3: [1, "fu"], a4: [0, "kin"], h8: [1, "fu"] });
  const s = stateOf(board, { rules: BASE, hands: [{ fu: 1 }, { fu: 1 }] });
  it("予測: 1 + 1 + 5 = 7。内訳は 返した駒 2・端の金（a4）", () => {
    const pv = previewMove(s, 0, 0, "fu")!;
    expect([pv.damage, pv.base]).toEqual([7, 2]);
    expect(pv.anchors).toEqual([{ r: 3, c: 0, kind: "kin" }]);
  });
  it("着手: 体力が 7 減り、棋譜に端の駒が残る。端の駒は盤上にそのまま", () => {
    const n = play(s, "a1", "fu");
    const m = lastMoveOf(n)!;
    expect([m.damage, n.hp[1]]).toEqual([7, BASE.hp[1] - 7]);
    expect(m.anchors).toEqual([{ r: 3, c: 0, kind: "kin" }]);
    expect(n.board[3][0]).toEqual({ owner: 0, kind: "kin" });
  });
  it("端の駒が隅でも同じ（a1 が端）", () => {
    const b = boardOfKinds({ a1: [0, "kin"], a2: [1, "fu"], h8: [1, "fu"] });
    const pv = previewMove(stateOf(b, { rules: BASE, hands: [{ fu: 1 }, { fu: 1 }] }), 2, 0, "fu")!;
    expect([pv.damage, pv.anchors]).toEqual([1 + 5, [{ r: 0, c: 0, kind: "kin" }]]);
  });
  it("最大値＋枚数÷4 のダメージ方式でも、その値に端の駒を足す", () => {
    const pv = previewMove(stateOf(board, { rules: { ...BASE, damage: "maxCount" }, hands: [{ fu: 1 }, { fu: 1 }] }), 0, 0, "fu")!;
    expect([pv.base, pv.damage]).toEqual([1, 1 + 5]);
  });
});

describe("2 列以上: 列ごとに別の端の駒を両方足す", () => {
  // 先手が d4 に金（全方向）を置く。縦に d3 を挟む端は d2 の飛3、横に e4 を挟む端は f4 の角3、斜めに c5 を挟む端は b6 の金5
  const board = boardOfKinds({
    d3: [1, "fu"], d2: [0, "hi"],
    e4: [1, "yoko"], f4: [0, "kaku"],
    c5: [1, "fu"], b6: [0, "kin"],
    h8: [1, "fu"],
  });
  const s = stateOf(board, { rules: BASE, hands: [{ kin: 1, fu: 1 }, { fu: 1 }] });
  it("金: 3 列とも返し、3 つの端（飛3・角3・金5）を足す", () => {
    const pv = previewMove(s, 3, 3, "kin")!;
    expect(pv.base).toBe(1 + 1 + 1);
    expect(pv.damage).toBe(3 + 3 + 3 + 5);
    expect(names(pv.anchors).sort()).toEqual(["b6", "d2", "f4"]);
    // 列は方向ごとに 1 本なので、端の駒が重なることはない
    expect(new Set(names(pv.anchors)).size).toBe(pv.anchors.length);
    const m = lastMoveOf(play(s, "d4", "kin"))!;
    expect([m.damage, names(m.anchors!).sort()]).toEqual([14, ["b6", "d2", "f4"]]);
  });
  it("方向で返せない列の端は足さない（歩は縦の d3 だけ返し、端は d2 の飛3 だけ）", () => {
    const pv = previewMove(s, 3, 3, "fu")!;
    expect([pv.base, pv.damage, names(pv.anchors)]).toEqual([1, 1 + 3, ["d2"]]);
  });
  it("強さ制限で返せない列の端も足さない", () => {
    // d4 に横（数字1）を全方向で置く。c4 の金5 を含む列（端 b4 の金5）は返せず、d3 の歩1 の列（端 d2 の飛3）だけ
    const b = boardOfKinds({ c4: [1, "kin"], b4: [0, "kin"], d3: [1, "fu"], d2: [0, "hi"], h8: [1, "fu"] });
    const gate = stateOf(b, { rules: { ...BASE, gate: true, dirs: "all" }, hands: [{ yoko: 1 }, { fu: 1 }] });
    const pv = previewMove(gate, 3, 3, "yoko")!;
    expect([pv.base, pv.damage, names(pv.anchors)]).toEqual([1, 1 + 3, ["d2"]]);
    // 強さ制限なしなら両方の列を返し、両方の端を足す
    const free = previewMove({ ...gate, rules: { ...gate.rules, gate: false } }, 3, 3, "yoko")!;
    expect([free.base, free.damage, names(free.anchors).sort()]).toEqual([5 + 1, 5 + 1 + 5 + 3, ["b4", "d2"]]);
  });
});

describe("取るモード・設定なし", () => {
  const board = boardOfKinds({ a2: [1, "kaku"], a3: [1, "fu"], a4: [0, "kin"], h8: [1, "fu"] });
  it("取るモードでも取った列の端の自分の駒を足す。取った駒は持ち駒に入り、端の駒は盤に残る", () => {
    const s = stateOf(board, { rules: { ...BASE, action: "capture" }, hands: [{ fu: 1 }, { fu: 1 }] });
    const n = play(s, "a1", "fu");
    const m = lastMoveOf(n)!;
    expect([m.damage, names(m.anchors!)]).toEqual([3 + 1 + 5, ["a4"]]);
    expect(n.hands[0]).toMatchObject({ fu: 1, kaku: 1 });
    expect([n.board[1][0], n.board[2][0], n.board[3][0]]).toEqual([null, null, { owner: 0, kind: "kin" }]);
  });
  it("取るモードで何も取らない手は上乗せなし（棋譜に端の駒のキーがない）", () => {
    const s = stateOf(board, { rules: { ...BASE, action: "capture" }, hands: [{ fu: 1 }, { fu: 1 }] });
    const m = lastMoveOf(play(s, "f6", "fu"))!;
    expect(m.damage).toBe(0);
    expect("anchors" in m).toBe(false);
  });
  it("端の駒の力が「なし」なら従来どおり（返した駒の数字だけ・端の駒は記録しない）", () => {
    const s = stateOf(board, { rules: NONE, hands: [{ fu: 1 }, { fu: 1 }] });
    const pv = previewMove(s, 0, 0, "fu")!;
    expect([pv.damage, pv.base, pv.anchors]).toEqual([3 + 1, 3 + 1, []]);
    const m = lastMoveOf(play(s, "a1", "fu"))!;
    expect(m.damage).toBe(4);
    expect("anchors" in m).toBe(false);
  });
});

describe("隠し王と組み合わせる", () => {
  it("相手の王を返したら 返した駒 ＋ 端の駒 ＋ 罰 の合計だけ体力が減る", () => {
    // a2 の歩が後手の隠れた王である局面を直接作る
    const board = boardOfKinds({ a2: [1, "fu"], a3: [1, "fu"], a4: [0, "kin"], h8: [1, "fu"] });
    const s0 = stateOf(board, { rules: ANCHOR, hands: [{ fu: 2 }, { fu: 2 }] });
    const s: GameState = { ...s0, kings: [s0.kings[0], { cell: [1, 0], auto: false, revealed: false }] };
    const n = play(s, "a1", "fu");
    const m = lastMoveOf(n)!;
    expect(m.damage).toBe(1 + 1 + 5);
    expect(m.king).toMatchObject({ r: 1, c: 0, penalty: 20 });
    expect(n.hp[1]).toBe(ANCHOR.hp[1] - (7 + 20));
  });
  it("端の駒が自分の王でも上乗せはふつうに足し、王は公開されない", () => {
    // 先手が e1 に金を王として置き（d1 を挟む端は c1 の飛）、その王（金5）を端にして e2・e3 を縦に挟む
    const board = boardOfKinds({ d1: [1, "fu"], c1: [0, "hi"], e2: [1, "fu"], e3: [1, "fu"], h8: [1, "fu"], g8: [0, "fu"] });
    let s = stateOf(board, { rules: ANCHOR, hands: [{ kin: 1, fu: 1 }, { yoko: 1 }] });
    s = play(s, "e1", "kin", { king: true });
    expect(lastMoveOf(s)!.damage).toBe(1 + 3);
    expect(kingInfo(s, 0)).toMatchObject({ status: "hidden", cell: [0, 4] });
    // 後手の手は省いて先手の手番に戻す
    s = { ...s, turn: 0 };
    const pv = previewMove(s, 3, 4, "fu")!;
    expect([pv.base, pv.damage, names(pv.anchors)]).toEqual([2, 2 + 5, ["e1"]]);
    const n = play(s, "e4", "fu");
    expect(lastMoveOf(n)!.anchors).toEqual([{ r: 0, c: 4, kind: "kin" }]);
    expect(kingInfo(n, 0)).toMatchObject({ status: "hidden", cell: [0, 4] });
    expect(lastMoveOf(n)!.king).toBeUndefined();
  });
});

describe("上乗せで体力 0", () => {
  const board = boardOfKinds({ a2: [1, "fu"], a3: [1, "fu"], a4: [0, "kin"], h8: [1, "fu"] });
  it("返した駒だけでは足りないが、上乗せで 0 になれば即終局（予測の警告も出さない）", () => {
    const s = stateOf(board, { rules: BASE, hp: [60, 7], hands: [{ fu: 1 }, { fu: 1, yoko: 1 }] });
    const pv = previewMove(s, 0, 0, "fu")!;
    expect([pv.damage, pv.exposed, pv.exposedDamage]).toEqual([7, [], 0]);
    const n = play(s, "a1", "fu");
    expect(n.hp[1]).toBe(0);
    expect(n.result).toEqual({ winner: 0, reason: "ko", byDiscs: false });
    // 上乗せなしなら 2 ダメージで体力は残る
    const plain = play(stateOf(board, { rules: NONE, hp: [60, 7], hands: [{ fu: 1 }, { fu: 1 }] }), "a1", "fu");
    expect([plain.hp[1], plain.result?.reason]).toEqual([5, "stalled"]);
  });
});

describe("CPU・相手の最善応手・警告は上乗せ込みのダメージで評価する", () => {
  // 先手の選択肢: h1 に横を置き g1 の銀2 を返す（端 f1 の歩1 → 3） / a1 に歩を置き a2 の歩1 を返す（端 a3 の金5 → 6）
  const board = boardOfKinds({ g1: [1, "gin"], f1: [0, "fu"], a2: [1, "fu"], a3: [0, "kin"], d8: [1, "fu"] });
  const hands = [{ fu: 1, yoko: 1 }, {}] as [Partial<Record<PieceKind, number>>, Partial<Record<PieceKind, number>>];
  it("上乗せなしなら銀を返す手、上乗せありなら金を端にする手が最善", () => {
    const pick = (r: RuleSet) => lookaheadCandidates(viewFor(stateOf(board, { rules: r, hands }), 0));
    expect(pick(NONE)).toEqual({ best: 2, cands: [{ r: 0, c: 7, kind: "yoko" }] });
    expect(pick(BASE)).toEqual({ best: 6, cands: [{ r: 0, c: 0, kind: "fu" }] });
  });
  it("bestReply（相手の最善応手）と予測の「相手が次に与えられる最大ダメージ」も上乗せ込み", () => {
    expect(bestReply(BASE, board, { fu: 1, yoko: 1, gin: 0, kaku: 0, kin: 0, hi: 0 }, 0).damage).toBe(6);
    expect(bestReply(NONE, board, { fu: 1, yoko: 1, gin: 0, kaku: 0, kin: 0, hi: 0 }, 0).damage).toBe(2);
    // 先手が e1 に横を置いて f1 を返すと、1 行目は c1（後手の金）・d1〜g1（先手）。後手は h1 に横を置けば d1〜g1 を挟める（端 c1 の金5）
    const b = boardOfKinds({ c1: [1, "kin"], d1: [0, "fu"], f1: [1, "fu"], g1: [0, "fu"], h8: [1, "fu"] });
    const pv = (r: RuleSet) => previewMove(stateOf(b, { rules: r, hands: [{ yoko: 1 }, { yoko: 1 }] }), 0, 4, "yoko")!;
    expect(pv(NONE).exposedDamage).toBe(4);
    expect(pv(BASE).exposedDamage).toBe(4 + 5);
  });
  it("拠点プリセットを 2 手読み同士で終局まで: 全手が合法、ダメージ = 返した駒 ＋ 端の駒、端の駒は手番の人の別々の駒", () => {
    for (const seed of [1, 2, 3]) {
      let x = seed;
      const rand = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      let s = createGame(ANCHOR);
      let bonusMoves = 0;
      while (!s.result) {
        const ch = chooseLookahead(viewFor(s, s.turn), rand)!;
        expect(isLegal(s, ch.r, ch.c, ch.kind)).toBe(true);
        const before = s;
        const pv = previewMove(before, ch.r, ch.c, ch.kind)!;
        s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
        const m = lastMoveOf(s)!;
        const anchors = m.anchors ?? [];
        expect(anchors).toEqual(pv.anchors);
        expect(m.damage).toBe(pv.base + anchors.reduce((n, a) => n + ANCHOR.values[a.kind], 0));
        expect(new Set(names(anchors)).size).toBe(anchors.length);
        for (const a of anchors) expect(before.board[a.r][a.c]).toEqual({ owner: m.player, kind: a.kind });
        // 返した駒が 1 つ以上なら端の駒も 1 つ以上
        expect(anchors.length > 0).toBe(m.targets.length > 0);
        if (anchors.length > 0) bonusMoves++;
      }
      expect(bonusMoves).toBeGreaterThan(5);
    }
  });
});

describe("URL・設定・ルール文", () => {
  it("拠点プリセットの URL は方向駒の URL の末尾に anc=atk を足したもの。往復できる", () => {
    const dir = encodeRules(presetById("dir").rules);
    expect(dir).not.toContain("anc");
    const q = encodeRules(ANCHOR);
    expect(q).toBe(`${dir.replace(/hp1=\d+&hp2=\d+/, `hp1=${ANCHOR.hp[0]}&hp2=${ANCHOR.hp[1]}`)}&anc=atk`);
    expect(decodeRules(q)).toEqual({ rules: ANCHOR, present: true, invalid: [] });
    expect(matchPreset(decodeRules(q).rules)?.id).toBe("anchor");
  });
  it("端の駒の力だけ違えば別の設定（カスタム）。項目がない URL は「なし」", () => {
    expect(matchPreset({ ...ANCHOR, anchor: "none" })?.id).not.toBe("anchor");
    const dir = presetById("dir").rules;
    expect(sameRules(dir, { ...dir, anchor: "attack" })).toBe(false);
    expect(decodeRules("?take=flip&dir=piece").rules.anchor).toBe("none");
    const custom = { ...presetById("orig").rules, anchor: "attack" as const };
    expect(decodeRules(encodeRules(custom)).rules).toEqual(custom);
  });
  it("不正な値は既定値（なし）に戻し、どの項目かを返す", () => {
    for (const bad of ["attack", "1", "", "__proto__", "toString", "ATK"]) {
      const d = decodeRules(`?anc=${bad}`);
      expect([d.rules.anchor, d.invalid]).toEqual(["none", ["anc"]]);
    }
    expect(decodeRules("?anc=none")).toMatchObject({ invalid: [], present: true });
  });
  it("ルールカード: ダメージの次の行に「挟んだ端の自分の駒の数字もダメージに足す」。なしなら出さない", () => {
    expect(ruleLines(ANCHOR).map(sentenceText)).toEqual([
      "挟めるマスに置き、相手の駒を裏返す",
      "駒の矢印の方向だけ挟める 歩↕ 横↔ 角✕ 飛✚ 金✱",
      "返した駒の数字の合計がダメージ",
      "挟んだ端の自分の駒の数字もダメージに足す",
      "回復なし",
      "最初の5手のうち1つを王にする。相手に見えず、返されたら体力−20",
      `体力 先手 ${ANCHOR.hp[0]}・後手 ${ANCHOR.hp[1]} が 0 で負け`,
    ]);
    expect(ruleLines(presetById("dir").rules).map(sentenceText).join("")).not.toContain("端の自分の駒");
    const details = ruleDetails(ANCHOR).map(sentenceText).join("\n");
    expect(details).toContain("返した列ごとに、反対端の自分の駒（もともと盤上にあって挟むのに使った駒）の数字もダメージに足す");
    expect(details).toContain("返されると相手の拠点になる");
    expect(ruleDetails({ ...ANCHOR, action: "capture" }).map(sentenceText).join("\n")).toContain("取った列ごとに");
  });
});
