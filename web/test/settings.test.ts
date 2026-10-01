// URL クエリ（設定の共有）とルールカードの文言のテスト

import { describe, expect, it } from "vitest";
import { defaultRules, matchPreset, PRESETS } from "../src/engine/rules";
import { decodeRules, encodeRules } from "../src/ui/query";
import { endDetails, ruleLines, sentenceText } from "../src/ui/ruletext";
import { rulesOf } from "./helpers";

describe("URL クエリ", () => {
  it.each(PRESETS.map((p) => [p.name, p.rules] as const))("%s: 書き出して読み戻すと同じ設定", (_, rules) => {
    const d = decodeRules(`?${encodeRules(rules)}`);
    expect(d).toEqual({ rules, present: true, invalid: [] });
  });
  it("カスタム設定（後手の体力だけ違う・銀だけ・手数上限あり）も往復できる", () => {
    const r = rulesOf("orig", { gate: true, hp: [7, 199], hand: { fu: 0, gin: 40, kin: 0, hi: 0 }, maxPlies: 123 });
    expect(decodeRules(encodeRules(r)).rules).toEqual(r);
    expect(matchPreset(r)).toBeNull();
  });
  it("クエリがなければ既定値（v1.0）", () => {
    expect(decodeRules("")).toEqual({ rules: defaultRules(), present: false, invalid: [] });
    expect(matchPreset(defaultRules())?.id).toBe("v10");
  });
  it("不正な値は項目ごとに既定値に戻し、どの項目かを返す", () => {
    const d = decodeRules(
      "?take=oops&gate=2&dmg=__proto__&heal=toString&hp1=4&hp2=201&fu=-1&gin=1e2&kin=05&hi=41&limit=301",
    );
    expect(d.rules).toEqual(defaultRules());
    expect(d.invalid.sort()).toEqual(["dmg", "fu", "gate", "gin", "heal", "hi", "hp1", "hp2", "kin", "limit", "take"]);
  });
  it("型違い・空・小数・巨大な数・重複キーでもエラーにならない", () => {
    for (const q of ["?hp1=", "?hp1=3.5", "?hp1=99999999999999999999", "?fu=abc&fu=3", "?take", "?%E0%A4%A", "?limit=0x10"]) {
      expect(() => decodeRules(q)).not.toThrow();
    }
    expect(decodeRules("?hp1=").invalid).toEqual(["hp1"]);
    expect(decodeRules("?fu=abc&fu=3").rules.hand.fu).toBe(8); // 先頭の値（abc）で判定して既定値
  });
  it("一部だけ指定すれば、残りは既定値で、指定した項目は使う", () => {
    const d = decodeRules("?take=flip&gate=1&hp1=5&utm_source=x");
    expect(d.invalid).toEqual([]);
    expect(d.rules).toEqual({ ...defaultRules(), action: "flip", gate: true, hp: [5, 20] });
  });
  it("範囲の端（体力 5・200、駒 0・40、手数 0・300）は有効", () => {
    const d = decodeRules("?hp1=5&hp2=200&fu=0&hi=40&limit=300");
    expect(d.invalid).toEqual([]);
    expect([d.rules.hp, d.rules.hand.fu, d.rules.hand.hi, d.rules.maxPlies]).toEqual([[5, 200], 0, 40, 300]);
  });
});

describe("ルールカードの文言", () => {
  const card = (id: string) => ruleLines(PRESETS.find((p) => p.id === id)!.rules).map(sentenceText);
  it("どの設定でも 3〜5 行", () => {
    for (const p of PRESETS) {
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
  it("取る＋強さ制限は「取れない」", () => {
    expect(ruleLines(rulesOf("v10", { gate: true })).map(sentenceText)).toContain("置いた駒より数字が大きい駒を含む列は取れない");
  });
  it("決着の説明に手数上限の有無が入る", () => {
    expect(endDetails(rulesOf("v10"))[1]).toContain("80 手");
    expect(endDetails(rulesOf("v2"))[1]).toBe("手数の上限なし");
  });
});
