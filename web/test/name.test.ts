// プレイヤーの名前の正規化（net/name.ts）: 空は名前なし・長さ（絵文字も 1 字）・改行や見えない文字を弾く・HTML の記号はそのまま

import { describe, expect, it } from "vitest";
import { NAME_MAX, NAME_PROBLEM_TEXT, normalizeName } from "../src/net/name";

const ok = (raw: unknown) => {
  const r = normalizeName(raw);
  if (!r.ok) throw new Error(`通らない: ${JSON.stringify(raw)} ${r.problem}`);
  return r.name;
};
const problem = (raw: unknown) => {
  const r = normalizeName(raw);
  return r.ok ? null : r.problem;
};

describe("normalizeName", () => {
  it("空・空白だけ・省略は名前なし（空の文字列）", () => {
    expect(ok("")).toBe("");
    expect(ok("   ")).toBe("");
    expect(ok("　")).toBe("");
    expect(ok(undefined)).toBe("");
    expect(ok(null)).toBe("");
  });

  it("前後の空白を除き、連続する空白（全角の空白も）を 1 つの半角の空白にする。全角の英字・半角のカナは変えない", () => {
    expect(ok("  はる  ")).toBe("はる");
    expect(ok("はる　　き")).toBe("はる き");
    expect(ok("ＡＢＣ")).toBe("ＡＢＣ");
    expect(ok("ｶﾀｶﾅ")).toBe("ｶﾀｶﾅ");
    // NFC: 分けて書いた濁点は 1 字にまとめる
    expect(ok("が")).toBe("が");
  });

  it(`${NAME_MAX} 字まで（絵文字・サロゲートペアも 1 字）。超えたら long`, () => {
    expect(ok("あ".repeat(NAME_MAX))).toBe("あ".repeat(NAME_MAX));
    expect(problem("あ".repeat(NAME_MAX + 1))).toBe("long");
    expect(ok("🍣".repeat(NAME_MAX))).toBe("🍣".repeat(NAME_MAX));
    expect(problem("🍣".repeat(NAME_MAX + 1))).toBe("long");
    // 前後の空白は数えない
    expect(ok(` ${"a".repeat(NAME_MAX)} `)).toBe("a".repeat(NAME_MAX));
    // とても長い入力は正規化の前に断る
    expect(problem("a".repeat(10_000))).toBe("long");
  });

  it("改行・タブ・制御文字・見えない文字（ゼロ幅・書式・行の区切り）・単独のサロゲート・重ねすぎた結合文字は char", () => {
    for (const bad of ["a\nb", "a\rb", "a\tb", "\u0000", "a\u0007", "a\u007f", "a​b", "a‍b", "‮abc", "﻿a", "a b", "a b", "\ud800", "x\u0301\u0301\u0301\u0301"]) {
      expect(problem(bad), JSON.stringify(bad)).toBe("char");
    }
    // 結合文字 3 つまで（キーキャップの絵文字など）は通す
    expect(ok("1️⃣")).toBe("1️⃣");
  });

  it("文字列でない値は char", () => {
    for (const bad of [1, true, {}, ["a"]]) expect(problem(bad)).toBe("char");
  });

  it("HTML の記号はそのまま（画面は textContent でだけ出す）", () => {
    expect(ok("<script>")).toBe("<script>");
    expect(ok("<b>&</b>")).toBe("<b>&</b>");
    expect(problem("<script>alert(1)</script>")).toBe("long");
  });

  it("問題ごとの短い文", () => {
    expect(NAME_PROBLEM_TEXT.long).toBe(`${NAME_MAX}文字まで`);
    expect(NAME_PROBLEM_TEXT.char).toBe("使えない文字があります");
  });
});
