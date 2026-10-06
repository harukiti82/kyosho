// URL クエリ（設定の共有）とルールカードの文言のテスト

import { describe, expect, it } from "vitest";
import { defaultRules, matchPreset, NO_KING, PRESETS, presetById, sameRules, type PresetId } from "../src/engine/rules";
import { decodeRules, encodeRules, QUERY_BASE } from "../src/ui/query";
import compat from "./fixtures/query-compat.json";
import { endDetails, ruleDetails, ruleLines, sentenceText } from "../src/ui/ruletext";
import { cryptoRandom, drawSeat, seatChoice } from "../src/ui/setup";
import { rulesOf } from "./helpers";

describe("URL クエリ", () => {
  it.each(PRESETS.map((p) => [p.name, p.rules] as const))("%s: 書き出して読み戻すと同じ設定", (_, rules) => {
    const d = decodeRules(`?${encodeRules(rules)}`);
    expect(d).toEqual({ rules, present: true, invalid: [] });
  });
  it("カスタム設定（後手の体力だけ違う・銀だけ・手数上限あり）も往復できる", () => {
    const r = rulesOf("orig", { gate: true, hp: [7, 199], hand: { fu: 0, yoko: 0, gin: 40, kaku: 0, kin: 0, hi: 0 }, maxPlies: 123 });
    expect(decodeRules(encodeRules(r)).rules).toEqual(r);
    expect(matchPreset(r)).toBeNull();
  });
  it("クエリがなければ既定値（標準）。ルール以外のキー（部屋・計測用）だけでも既定値", () => {
    expect(decodeRules("")).toEqual({ rules: defaultRules(), present: false, invalid: [] });
    expect(matchPreset(defaultRules())?.id).toBe("std");
    for (const q of ["?utm_source=x", `?room=${"A".repeat(22)}`]) {
      expect(decodeRules(q)).toEqual({ rules: defaultRules(), present: false, invalid: [] });
    }
  });
  it("不正な値は項目ごとに基準（v1.0）の値に戻し、どの項目かを返す", () => {
    const d = decodeRules(
      "?take=oops&gate=2&dmg=__proto__&heal=toString&hp1=4&hp2=201&fu=-1&gin=1e2&kin=05&hi=41&limit=301",
    );
    expect(d.rules).toEqual(rulesOf(QUERY_BASE));
    expect(d.invalid.sort()).toEqual(["dmg", "fu", "gate", "gin", "heal", "hi", "hp1", "hp2", "kin", "limit", "take"]);
  });
  it("型違い・空・小数・巨大な数・重複キーでもエラーにならない", () => {
    for (const q of ["?hp1=", "?hp1=3.5", "?hp1=99999999999999999999", "?fu=abc&fu=3", "?take", "?%E0%A4%A", "?limit=0x10"]) {
      expect(() => decodeRules(q)).not.toThrow();
    }
    expect(decodeRules("?hp1=").invalid).toEqual(["hp1"]);
    expect(decodeRules("?fu=abc&fu=3").rules.hand.fu).toBe(8); // 先頭の値（abc）で判定して基準（v1.0）の値
  });
  it("一部だけ指定すれば、残りは基準（v1.0）の値で、指定した項目は使う", () => {
    const d = decodeRules("?take=flip&gate=1&hp1=5&utm_source=x");
    expect(d.invalid).toEqual([]);
    expect(d.rules).toEqual(rulesOf("v10", { action: "flip", gate: true, hp: [5, 20] }));
  });
  it("隠し王の設定（罰・期限）も往復できる。なしのときは king=0 だけを載せる", () => {
    const king = rulesOf("king");
    expect(encodeRules(king)).toContain("king=1&kpen=hp&kdmg=20&kdue=5");
    const lose = rulesOf("orig", { king: { on: true, penalty: "lose", amount: 7, deadline: 1 } });
    expect(decodeRules(encodeRules(lose))).toEqual({ rules: lose, present: true, invalid: [] });
    expect(encodeRules(rulesOf("v2"))).toMatch(/&king=0$/);
    // 隠し王の項目がない古い URL は「なし」
    expect(decodeRules("?take=flip&hp1=40").rules.king).toEqual(NO_KING);
    // 範囲の端
    const edge = decodeRules("?king=1&kpen=hp&kdmg=200&kdue=20");
    expect([edge.invalid, edge.rules.king]).toEqual([[], { on: true, penalty: "hp", amount: 200, deadline: 20 }]);
    expect(decodeRules("?king=1&kdmg=1&kdue=1").rules.king).toEqual({ on: true, penalty: "hp", amount: 1, deadline: 1 });
  });
  it("隠し王の不正な値は項目ごとに既定値（なし・体力−20・5 手）", () => {
    const d = decodeRules("?king=yes&kpen=__proto__&kdmg=0&kdue=21");
    expect(d.rules.king).toEqual(NO_KING);
    expect(d.invalid.sort()).toEqual(["kdmg", "kdue", "king", "kpen"]);
    const d2 = decodeRules("?king=1&kpen=die&kdmg=201&kdue=0");
    expect(d2.rules.king).toEqual({ ...NO_KING, on: true });
    expect(d2.invalid.sort()).toEqual(["kdmg", "kdue", "kpen"]);
  });
  it("隠し王の追加設定は「なし」なら比べない（プリセットの判定）", () => {
    expect(matchPreset(rulesOf("v2", { king: { on: false, penalty: "lose", amount: 3, deadline: 9 } }))?.id).toBe("v2");
    expect(matchPreset(rulesOf("king", { king: { on: true, penalty: "hp", amount: 21, deadline: 5 } }))).toBeNull();
    // 即負けなら減る体力の値は比べない
    const a = rulesOf("king", { king: { on: true, penalty: "lose", amount: 1, deadline: 5 } });
    expect(sameRules(a, { ...a, king: { ...a.king, amount: 99 } })).toBe(true);
  });
  it("範囲の端（体力 5・200、駒 0・40、手数 0・300）は有効", () => {
    const d = decodeRules("?hp1=5&hp2=200&fu=0&hi=40&limit=300");
    expect(d.invalid).toEqual([]);
    expect([d.rules.hp, d.rules.hand.fu, d.rules.hand.hi, d.rules.maxPlies]).toEqual([[5, 200], 0, 40, 300]);
  });
});

describe("既定（標準）と共有済みの URL の互換", () => {
  // ユーザーが既定に指定した URL のクエリ
  const STD_QUERY =
    "take=flip&gate=0&dmg=sum&heal=avg&hp1=125&hp2=130&fu=10&gin=0&kin=2&hi=3&limit=0&king=1&kpen=hp&kdmg=30&kdue=5&dir=piece&yoko=10&kaku=4&vkin=5&vhi=3&anc=atk";
  it("指定の URL を読むと、丸めも不正もなく既定の設定と同じ。既定を書き出すと指定の URL と同じ", () => {
    expect(decodeRules(`?${STD_QUERY}`)).toEqual({ rules: defaultRules(), present: true, invalid: [] });
    expect(encodeRules(defaultRules())).toBe(STD_QUERY);
  });
  it("既存プリセットの URL は既定を変える前と同じ文字列で、同じ設定に読める", () => {
    for (const [id, q] of Object.entries(compat.urls)) {
      const rules = presetById(id as PresetId).rules;
      expect(encodeRules(rules)).toBe(q);
      expect(decodeRules(`?${q}`)).toEqual({ rules, present: true, invalid: [] });
    }
  });
  it("一部だけ・不正な値を含む古い URL も、既定を変える前と同じ設定に読める", () => {
    for (const [q, before] of Object.entries(compat.decoded)) expect(decodeRules(q)).toEqual(before);
  });
  it("差分の基準は v1.0 のまま", () => {
    expect(QUERY_BASE).toBe("v10");
  });
});

describe("ルールカードの文言", () => {
  const card = (id: string) => ruleLines(PRESETS.find((p) => p.id === id)!.rules).map(sentenceText);
  it("プリセットは 3〜5 行（方向駒は方向の 1 行が増えて 6 行、拠点・標準は端の駒の 1 行が増えて 7 行）", () => {
    expect(ruleLines(rulesOf("dir"))).toHaveLength(6);
    expect(ruleLines(rulesOf("anchor"))).toHaveLength(7);
    expect(ruleLines(rulesOf("std"))).toHaveLength(7);
    for (const p of PRESETS.filter((p) => p.id !== "dir" && p.id !== "anchor" && p.id !== "std")) {
      const n = ruleLines(p.rules).length;
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(ruleLines(rulesOf("v04", { gate: true }))).toHaveLength(5);
  });
  it("v0.4", () => {
    expect(card("v04")).toEqual([
      "挟んだ相手の駒を裏返す（挟めるマスにしか置けない）",
      "返した駒の最大の数字＋枚数÷4がダメージ",
      "挟んだ両端の駒の低い方−1だけ回復",
      "体力 先手 65・後手 66 が 0 で負け",
    ]);
  });
  it("v1.0（取る）", () => {
    expect(card("v10")).toEqual([
      "空きマスならどこにでも置け、挟んだ相手の駒を取って自分の持ち駒にする",
      "取った駒の数字の合計がダメージ",
      "回復なし",
      "体力 20 が 0 で負け（80 手で終われば体力の多い方が勝ち）",
    ]);
  });
  it("v2 案", () => {
    expect(card("v2")).toEqual([
      "挟んだ相手の駒を裏返す（挟めるマスにしか置けない）",
      "置いた駒より数字が大きい駒を含む列は返せない",
      "返した駒の数字の合計がダメージ",
      "回復なし",
      "体力 40 が 0 で負け",
    ]);
  });
  it("原案", () => {
    expect(card("orig")).toContain("挟んだ両端の駒の平均だけ回復");
  });
  it("標準（既定）: 方向・端の駒・回復・隠し王（−30）の行がすべて入る", () => {
    expect(card("std")).toEqual([
      "挟んだ相手の駒を裏返す（挟めるマスにしか置けない）",
      "挟めるのは駒の矢印の方向だけ（歩↕ 横↔ 角✕ 飛✚ 金✱）",
      "返した駒の数字の合計がダメージ",
      "挟んだ端の自分の駒の数字もダメージに足す",
      "挟んだ両端の駒の平均だけ回復",
      "最初の5手のうち1つを王に（相手に見えない）。王を返されたら体力−30",
      "体力 先手 125・後手 130 が 0 で負け",
    ]);
  });
  it("取る＋強さ制限は「取れない」", () => {
    expect(ruleLines(rulesOf("v10", { gate: true })).map(sentenceText)).toContain("置いた駒より数字が大きい駒を含む列は取れない");
  });
  it("隠し王: 期限と罰の 1 行が体力の行の前に入る", () => {
    expect(card("king")).toEqual([
      "挟んだ相手の駒を裏返す（挟めるマスにしか置けない）",
      "返した駒の数字の合計がダメージ",
      "回復なし",
      "最初の5手のうち1つを王に（相手に見えない）。王を返されたら体力−20",
      "体力 先手 70・後手 60 が 0 で負け",
    ]);
    const lose1 = rulesOf("v10", { king: { on: true, penalty: "lose", amount: 20, deadline: 1 } });
    expect(ruleLines(lose1).map(sentenceText)).toContain("最初に置く駒が王（相手に見えない）。王を取られたら即負け");
    // 強さ制限＋隠し王でも 6 行まで
    expect(ruleLines(rulesOf("king", { gate: true }))).toHaveLength(6);
    expect(endDetails(lose1)[0]).toBe("体力が 0 以下になるか、王を取られたらその時点で負け");
    const details = ruleDetails(rulesOf("king")).map(sentenceText).join("\n");
    expect(details).toContain("5 手目までに選ばなかったら、5 手目に置いた駒が自動で王になる");
    expect(details).toContain("通常のダメージに加えて体力 −20");
    expect(ruleLines(rulesOf("v2")).map(sentenceText).join("")).not.toContain("王");
  });
  it("決着の説明に手数上限の有無が入る", () => {
    expect(endDetails(rulesOf("v10"))[1]).toContain("80 手");
    expect(endDetails(rulesOf("v2"))[1]).toBe("手数の上限なし");
  });
});

describe("CPU 対戦の手番", () => {
  it("設定画面の既存の値（先手 0・後手 1）の意味は変わらず、抽選しない", () => {
    expect(seatChoice("0")).toEqual({ human: 0, randomSeat: false });
    expect(seatChoice("1")).toEqual({ human: 1, randomSeat: false });
    // 値がない・知らない値は従来どおり先手
    expect(seatChoice(null)).toEqual({ human: 0, randomSeat: false });
    expect(seatChoice("2")).toEqual({ human: 0, randomSeat: false });
  });
  it("「ランダム」は抽選する印を立てる", () => {
    expect(seatChoice("random")).toEqual({ human: 0, randomSeat: true });
  });
  it("抽選は乱数が 0.5 未満なら先手、0.5 以上なら後手", () => {
    expect(drawSeat(() => 0)).toBe(0);
    expect(drawSeat(() => 0.4999)).toBe(0);
    expect(drawSeat(() => 0.5)).toBe(1);
    expect(drawSeat(() => 0.9999)).toBe(1);
  });
  it("既定の乱数（crypto）は 0 以上 1 未満で、先手も後手も出る", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const x = cryptoRandom();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      seen.add(drawSeat());
    }
    expect([...seen].sort()).toEqual([0, 1]);
  });
  it("手番は共有 URL に載らない（URL はルールだけ）", () => {
    expect(encodeRules(defaultRules())).not.toMatch(/side|seat/);
  });
});
