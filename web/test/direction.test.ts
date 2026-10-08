// 方向駒（挟める方向が「駒ごと」）のテスト: 駒の方向・パス・種類と数字の保持・警告・CPU・URL・ルール文

import { describe, expect, it } from "vitest";
import { linesFor, SIZE, type Board } from "../src/engine/board";
import { chooseLookahead } from "../src/engine/cpu";
import {
  canMove,
  createGame,
  isLegal,
  kingInfo,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
  threatenedPieces,
  viewFor,
} from "../src/engine/game";
import { DEFAULT_VALUES, matchPreset, presetById, sameRules, type PieceKind, type Player, type RuleSet } from "../src/engine/rules";
import { decodeRules, encodeRules } from "../src/ui/query";
import { dirLine, handText, ruleDetails, ruleLines, sentenceText } from "../src/ui/ruletext";
import { at, rulesOf, stateOf } from "./helpers";

const names = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([r, c]) => `${"abcdefgh"[c]}${r + 1}`).sort();

/** stones: { "d4": [持ち主, 駒種], ... } から盤面を作る（横・角も置ける） */
function boardOfKinds(stones: Record<string, readonly [Player, PieceKind]>): Board {
  const b: Board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const [name, [owner, kind]] of Object.entries(stones)) {
    const [r, c] = at(name);
    b[r][c] = { owner, kind };
  }
  return b;
}

const DIR = rulesOf("dir");
const DIR_NO_KING = rulesOf("dir", { king: { ...DIR.king, on: false } });
const ALL = (r: RuleSet): RuleSet => ({ ...r, dirs: "all" });

/** d4 の周り 8 方向に後手の駒、その外側に先手の駒（d4 に置くとどの方向も挟める） */
const STAR = boardOfKinds({
  // 縦（上下）
  d3: [1, "fu"], d2: [0, "fu"], d5: [1, "fu"], d6: [0, "fu"],
  // 横（左右）
  c4: [1, "yoko"], b4: [0, "fu"], e4: [1, "yoko"], f4: [0, "fu"],
  // 斜め
  c3: [1, "kaku"], b2: [0, "fu"], e3: [1, "kaku"], f2: [0, "fu"],
  c5: [1, "hi"], b6: [0, "fu"], e5: [1, "kin"], f6: [0, "fu"],
});
const FULL_HAND = { fu: 1, yoko: 1, gin: 1, kaku: 1, kin: 1, hi: 1 };

describe("駒ごとの方向: 同じマスに置いても返せる列が駒で変わる", () => {
  const s = stateOf(STAR, { rules: DIR_NO_KING, hands: [FULL_HAND, FULL_HAND] });
  const [r, c] = at("d4");
  const want: Record<PieceKind, string[]> = {
    fu: ["d3", "d5"],
    yoko: ["c4", "e4"],
    kaku: ["c3", "c5", "e3", "e5"],
    hi: ["c4", "d3", "d5", "e4"],
    kin: ["c3", "c4", "c5", "d3", "d5", "e3", "e4", "e5"],
    gin: ["c3", "c4", "c5", "d3", "d5", "e3", "e4", "e5"],
  };
  it.each(Object.entries(want))("%s は自分の方向の列だけ返し、他の方向の列は返らない", (kind, cells) => {
    const k = kind as PieceKind;
    expect(names(previewMove(s, r, c, k)!.targets)).toEqual(cells);
    const n = playMove(s, r, c, k);
    const flipped = names(lastMoveOf(n)!.targets.map((t) => [t.r, t.c] as const));
    expect(flipped).toEqual(cells);
    // 返らなかった方向の駒は後手のまま
    for (const name of ["d3", "d5", "c4", "e4", "c3", "e3", "c5", "e5"]) {
      const [y, x] = at(name);
      expect(n.board[y][x]!.owner).toBe(cells.includes(name) ? 0 : 1);
    }
  });
  it("ダメージは返した駒の数字（方向駒の数字: 横1・角3・飛3・金5）", () => {
    expect(previewMove(s, r, c, "yoko")!.damage).toBe(2); // 横1 ×2
    expect(previewMove(s, r, c, "kaku")!.damage).toBe(3 + 3 + 3 + 5); // 角3 角3 飛3 金5
    expect(previewMove(s, r, c, "fu")!.damage).toBe(2);
  });
  it("全方向モードでは、どの駒も 8 方向すべて返す（従来どおり）", () => {
    const sa = stateOf(STAR, { rules: ALL(DIR_NO_KING), hands: [FULL_HAND, FULL_HAND] });
    for (const k of ["fu", "yoko", "kaku", "hi", "kin"] as const) {
      expect(names(previewMove(sa, r, c, k)!.targets)).toEqual(want.kin);
    }
  });
  it("縦・横は盤の絶対方向（後手が置いても歩は縦、横は横）", () => {
    // 色を入れ替えた盤で後手が d4 に置く
    const swapped = STAR.map((row) => row.map((st) => (st ? { ...st, owner: (1 - st.owner) as Player } : null)));
    const sw = stateOf(swapped, { rules: DIR_NO_KING, turn: 1, hands: [FULL_HAND, FULL_HAND] });
    expect(names(previewMove(sw, r, c, "fu")!.targets)).toEqual(want.fu);
    expect(names(previewMove(sw, r, c, "yoko")!.targets)).toEqual(want.yoko);
  });
  it("初手の置けるマス: 歩は縦の 2 マス・横は横の 2 マス・角はなし・飛と金は 4 マス", () => {
    const g = createGame(DIR);
    expect(names(legalCells(g, "fu"))).toEqual(["d3", "e6"]);
    expect(names(legalCells(g, "yoko"))).toEqual(["c4", "f5"]);
    expect(legalCells(g, "kaku")).toEqual([]);
    expect(names(legalCells(g, "hi"))).toEqual(["c4", "d3", "e6", "f5"]);
    expect(names(legalCells(g, "kin"))).toEqual(["c4", "d3", "e6", "f5"]);
    expect(playableKinds(g)).toEqual(["fu", "yoko", "kin", "hi"]);
  });
});

describe("方向で返せないときのパス・角だけの終盤", () => {
  // 先手が返せるのは a1→b1→c1 の横の列だけ
  const board = boardOfKinds({ b1: [1, "fu"], c1: [0, "fu"], h8: [1, "fu"] });
  it("方向で返せない駒しか持っていなければ打てない（横の列に歩・角では置けない）", () => {
    const s = stateOf(board, { rules: DIR_NO_KING, hands: [{ fu: 3, kaku: 2 }, { fu: 1 }] });
    expect(canMove(s, 0)).toBe(false);
    expect(playableKinds(s)).toEqual([]);
    expect(isLegal(s, 0, 0, "fu")).toBe(false);
    // 横を持っていれば置ける
    const s2 = stateOf(board, { rules: DIR_NO_KING, hands: [{ fu: 3, yoko: 1 }, { fu: 1 }] });
    expect(canMove(s2, 0)).toBe(true);
    expect(names(legalCells(s2, "yoko"))).toEqual(["a1"]);
    // 全方向なら歩でも置ける
    expect(canMove(stateOf(board, { rules: ALL(DIR_NO_KING), hands: [{ fu: 3 }, { fu: 1 }] }), 0)).toBe(true);
  });
  it("相手の手の後、方向の都合で置けなければ「置けるマスがない」パスになり、相手が続けて打つ", () => {
    // 先手が挟めるのは a1 から b1 を挟む横の列だけ（c1 が先手）。先手は歩しか持っていない
    const b = boardOfKinds({ b1: [1, "fu"], c1: [0, "fu"], g2: [0, "fu"], g3: [1, "fu"] });
    let s = stateOf(b, { rules: DIR_NO_KING, turn: 1, hands: [{ fu: 3 }, { fu: 1, yoko: 1 }] });
    // 後手が g1 に歩を置き、g2 を縦に返す
    s = playMove(s, 0, 6, "fu");
    expect(lastMoveOf(s)!.targets).toEqual([{ r: 1, c: 6, kind: "fu" }]);
    expect(canMove(s, 0)).toBe(false);
    expect(s.history.at(-1)).toEqual({ type: "pass", player: 0, reason: "noMoves" });
    // 後手が続けて打てる（d1 に横を置けば c1 を横に挟める）
    expect(s.turn).toBe(1);
    expect(names(legalCells(s, "yoko"))).toEqual(["d1"]);
  });
  it("角だけ残った終盤: 斜めに挟めるマスにだけ置ける", () => {
    const b = boardOfKinds({ b2: [1, "fu"], c3: [0, "fu"], b1: [1, "fu"], c1: [0, "fu"], h8: [1, "fu"] });
    const s = stateOf(b, { rules: DIR_NO_KING, hands: [{ kaku: 1 }, { fu: 1 }] });
    // a1 は斜め（b2）と横（b1）を挟めるが、角は斜めの b2 だけ返す。a3 は斜めに b2 を挟める
    expect(names(legalCells(s, "kaku"))).toEqual(["a1", "a3"]);
    const n = playMove(s, 0, 0, "kaku");
    expect(names(lastMoveOf(n)!.targets.map((t) => [t.r, t.c] as const))).toEqual(["b2"]);
    expect(n.board[0][1]!.owner).toBe(1);
  });
  it("強さ制限と組み合わせても、方向と強さの両方で返せる列だけ", () => {
    const b = boardOfKinds({ b1: [1, "kin"], c1: [0, "fu"], a2: [1, "fu"], a3: [0, "fu"], h8: [1, "fu"] });
    const rules = { ...DIR_NO_KING, gate: true };
    // 横は金5 を含むので、横（数字1）では返せない。飛（3）でも返せない。歩は縦の a2 を返せる
    expect(linesFor(b, 0, 0, 0, "yoko", rules)).toEqual([]);
    expect(names(linesFor(b, 0, 0, 0, "hi", rules).flatMap((l) => l.cells))).toEqual(["a2"]);
    const s = stateOf(b, { rules, hands: [{ yoko: 1 }, { fu: 1 }] });
    expect(canMove(s, 0)).toBe(false);
  });
});

describe("返された駒の種類と数字", () => {
  it("裏返すルール: 返された駒は種類（=方向）と数字がそのまま、色だけ変わる", () => {
    const b = boardOfKinds({ b1: [1, "kaku"], c1: [1, "kin"], d1: [1, "yoko"], e1: [0, "fu"], h8: [1, "fu"] });
    const s = stateOf(b, { rules: DIR_NO_KING, hands: [{ yoko: 1 }, { fu: 1 }] });
    const n = playMove(s, 0, 0, "yoko");
    expect([n.board[0][1], n.board[0][2], n.board[0][3]]).toEqual([
      { owner: 0, kind: "kaku" }, { owner: 0, kind: "kin" }, { owner: 0, kind: "yoko" },
    ]);
    expect(lastMoveOf(n)!.damage).toBe(3 + 5 + 1);
    expect(n.hands[0]).toEqual({ fu: 0, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 });
  });
  it("取るルール: 取った駒は種類のまま持ち駒に入り、その駒の方向で使える", () => {
    const rules = { ...DIR_NO_KING, action: "capture" as const };
    const b = boardOfKinds({ b1: [1, "kaku"], c1: [1, "yoko"], d1: [0, "fu"], h8: [1, "fu"] });
    const s = stateOf(b, { rules, hands: [{ yoko: 1 }, { fu: 1 }] });
    const n = playMove(s, 0, 0, "yoko");
    expect(n.hands[0]).toEqual({ fu: 0, yoko: 1, gin: 0, kaku: 1, kin: 0, hi: 0 });
    expect(lastMoveOf(n)!.damage).toBe(3 + 1);
  });
  it("駒の数字は設定で変えられる（同じ金でも既存プリセットは 3、方向駒は 5）", () => {
    const b = boardOfKinds({ b1: [1, "kin"], c1: [0, "fu"], h8: [1, "fu"] });
    const dmg = (r: RuleSet) => lastMoveOf(playMove(stateOf(b, { rules: r, hands: [{ fu: 1, yoko: 1 }, { fu: 1 }] }), 0, 0, "yoko"))!.damage;
    expect(dmg(DIR_NO_KING)).toBe(5);
    expect(dmg({ ...rulesOf("orig", { heal: "none" }), dirs: "all" })).toBe(3);
    expect(dmg({ ...DIR_NO_KING, values: { ...DIR_NO_KING.values, kin: 12 } })).toBe(12);
  });
});

describe("警告と予測は相手の持ち駒の方向を考慮する", () => {
  // 先手の c1 は、後手が d1 に置けば横に挟まれる（b1 が後手）
  const b = boardOfKinds({ b1: [1, "fu"], c1: [0, "kin"], h8: [0, "fu"], g7: [1, "fu"] });
  it("相手が横に挟める駒を持っていなければ「!」は付かない", () => {
    const onlyFu = stateOf(b, { rules: DIR_NO_KING, turn: 0, hands: [{ fu: 1 }, { fu: 3, kaku: 1 }] });
    expect(names(threatenedPieces(onlyFu, 0))).toEqual([]);
    const withYoko = stateOf(b, { rules: DIR_NO_KING, turn: 0, hands: [{ fu: 1 }, { fu: 3, yoko: 1 }] });
    expect(names(threatenedPieces(withYoko, 0))).toEqual(["c1"]);
    // 全方向なら歩でも挟める
    expect(names(threatenedPieces(stateOf(b, { rules: ALL(DIR_NO_KING), hands: [{ fu: 1 }, { fu: 3 }] }), 0))).toEqual(["c1"]);
  });
  it("予測の「置いた後に返されうる駒」も相手の持ち駒の方向で計算する", () => {
    // 先手が b3 に飛を置いて b2 を縦に返す（b1 は先手）。返した b2 は、後手が a2 に置けば横に挟める（c2 が後手）
    const b2 = boardOfKinds({ b1: [0, "fu"], b2: [1, "fu"], c2: [1, "fu"], h8: [0, "fu"] });
    const pv = (opp: Partial<Record<PieceKind, number>>) =>
      previewMove(stateOf(b2, { rules: DIR_NO_KING, hands: [{ hi: 1 }, opp] }), 2, 1, "hi")!;
    expect(names(pv({ hi: 1 }).targets)).toEqual(["b2"]);
    // 後手が歩（縦）だけなら挟めない。横を持っていれば挟める
    expect(names(pv({ fu: 2 }).exposed)).toEqual([]);
    expect(names(pv({ yoko: 1 }).exposed)).toEqual(["b2"]);
    expect(pv({ yoko: 1 }).exposedDamage).toBe(1);
  });
});

describe("隠し王と方向駒", () => {
  it("角を王にでき、相手が横に挟めば罰。相手が角しか持っていなければその列では返せない", () => {
    const b = boardOfKinds({ b2: [1, "kaku"], c3: [0, "fu"], c4: [0, "fu"], h8: [1, "fu"] });
    let s = stateOf(b, { rules: DIR, turn: 1, hands: [{ kaku: 2, yoko: 1 }, { kaku: 1 }] });
    // 後手が d4 に角を王として置き、c3 を斜めに返す（b2 は後手）
    s = playMove(s, 3, 3, "kaku", { king: true });
    expect(lastMoveOf(s)!.targets).toEqual([{ r: 2, c: 2, kind: "fu" }]);
    expect(kingInfo(s, 1)).toMatchObject({ status: "hidden", cell: [3, 3] });
    expect(s.turn).toBe(0);
    // 先手が角しか持っていなければ e4 には置けない（d4 の王は横の列にある）
    expect(isLegal({ ...s, hands: [{ ...s.hands[0], yoko: 0 }, s.hands[1]] }, 3, 4, "kaku")).toBe(false);
    // 横を e4 に置けば d4 の王（角3）を横に挟める（c4 は先手）
    const n = playMove(s, 3, 4, "yoko");
    expect(lastMoveOf(n)!.king).toMatchObject({ r: 3, c: 3, kind: "kaku", penalty: 20 });
    expect(n.board[3][3]).toEqual({ owner: 0, kind: "kaku" });
    expect(n.hp[1]).toBe(DIR.hp[1] - 3 - 20);
  });
  it("CPU は方向ルールで打つ（方向駒プリセットを 2 手読み同士で終局まで、全手が合法・王も決まる）", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let s = createGame(DIR);
    const kinds = new Set<PieceKind>();
    while (!s.result) {
      const ch = chooseLookahead(viewFor(s, s.turn), rand)!;
      expect(isLegal(s, ch.r, ch.c, ch.kind)).toBe(true);
      kinds.add(ch.kind);
      s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
    }
    expect(kingInfo(s, 0).status).not.toBe("unset");
    expect(kingInfo(s, 1).status).not.toBe("unset");
    // 複数の駒種を使い分ける
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });
});

describe("URL・設定・ルール文", () => {
  it("旧形式の URL（方向駒の項目なし）は全方向・既定の数字・横と角 0 個", () => {
    const d = decodeRules("?take=flip&gate=1&dmg=max&heal=low&hp1=65&hp2=66&fu=14&gin=10&kin=6&hi=2&limit=50&king=0");
    expect(d.invalid).toEqual([]);
    expect(d.rules).toEqual({ ...presetById("v04").rules, gate: true, maxPlies: 50 });
    expect([d.rules.dirs, d.rules.hand.yoko, d.rules.hand.kaku, d.rules.values]).toEqual(["all", 0, 0, DEFAULT_VALUES]);
  });
  it("既存プリセットの URL は方向駒の追加前と同じ文字列", () => {
    expect(encodeRules(presetById("v2").rules)).toBe("take=flip&gate=1&dmg=sum&heal=none&hp1=40&hp2=40&fu=20&gin=0&kin=8&hi=4&limit=0&king=0");
    expect(encodeRules(presetById("king").rules)).toBe(
      "take=flip&gate=0&dmg=sum&heal=none&hp1=70&hp2=60&fu=14&gin=10&kin=6&hi=2&limit=0&king=1&kpen=hp&kdmg=20&kdue=5",
    );
  });
  it("方向駒の設定（挟める方向・駒種ごとの数と数字）が往復できる", () => {
    const q = encodeRules(DIR);
    expect(q).toContain("&dir=piece&yoko=8&kaku=6&vkin=5&vhi=3");
    expect(decodeRules(q)).toEqual({ rules: DIR, present: true, invalid: [] });
    expect(matchPreset(decodeRules(q).rules)?.id).toBe("dir");
    const custom = { ...DIR, values: { ...DIR.values, fu: 20, yoko: 1 }, hand: { ...DIR.hand, gin: 40 } };
    expect(decodeRules(encodeRules(custom)).rules).toEqual(custom);
    // 方向だけ全方向に戻すと別の設定（カスタム）
    expect(matchPreset(ALL(DIR))).toBeNull();
    expect(sameRules(DIR, { ...DIR, values: { ...DIR.values, kin: 3 } })).toBe(false);
  });
  it("方向駒の不正な値は項目ごとに既定値（全方向・既定の数字・0 個）", () => {
    const d = decodeRules("?dir=diag&yoko=41&kaku=-1&vfu=0&vkin=21&vhi=3.5&vyoko=abc");
    expect(d.invalid.sort()).toEqual(["dir", "kaku", "vfu", "vhi", "vkin", "vyoko", "yoko"]);
    expect([d.rules.dirs, d.rules.hand.yoko, d.rules.hand.kaku, d.rules.values]).toEqual(["all", 0, 0, DEFAULT_VALUES]);
    const edge = decodeRules("?dir=piece&vfu=1&vkin=20&yoko=40");
    expect([edge.invalid, edge.rules.dirs, edge.rules.values.kin, edge.rules.hand.yoko]).toEqual([[], "piece", 20, 40]);
  });
  it("ルールカードに方向の 1 行（含まれる駒だけ）。全方向では出さない", () => {
    const card = ruleLines(DIR).map(sentenceText);
    expect(card.slice(0, 5)).toEqual([
      "挟めるマスに置き、相手の駒を裏返す",
      "駒の矢印の方向だけ挟める 歩↕ 横↔ 角✕ 飛✚ 金✱",
      "返した駒の数字の合計がダメージ",
      "回復なし",
      "最初の5手のうち1つを王にする。相手に見えず、返されたら体力−20",
    ]);
    expect(card).toHaveLength(6);
    expect(card[5]).toMatch(/^体力 .* が 0 で負け$/);
    const fewer = { ...DIR, hand: { fu: 0, yoko: 0, gin: 2, kaku: 3, kin: 0, hi: 0 } };
    // 中央の歩は常に盤上にあるので含める
    expect(sentenceText(dirLine(fewer))).toBe("駒の矢印の方向だけ挟める 歩↕ 銀✱ 角✕");
    expect(ruleLines(ALL(DIR)).map(sentenceText).join("")).not.toContain("矢印");
    expect(handText(DIR)).toBe("歩1↕ ×8・横1↔ ×8・角3✕ ×6・飛3✚ ×6・金5✱ ×4");
    expect(handText(presetById("orig").rules)).toBe("歩1 ×14・銀2 ×10・金3 ×6・飛5 ×2");
    const details = ruleDetails(DIR).map(sentenceText).join("\n");
    expect(details).toContain("挟める方向は駒ごとに違う");
    expect(details).toContain("縦・横は盤の向き（先手・後手で同じ）");
  });
});
