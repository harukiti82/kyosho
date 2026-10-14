// 合言葉の正規化（net/phrase.ts）: 全角と半角・大文字と小文字・空白の違いを同じにし、長さと使えない文字を確かめる

import { describe, expect, it } from "vitest";
import { normalizePhrase, PHRASE_MAX } from "../src/net/phrase";

const ok = (raw: unknown) => {
  const r = normalizePhrase(raw);
  if (!r.ok) throw new Error(`通らない: ${JSON.stringify(raw)} ${r.problem}`);
  return r.phrase;
};
const problem = (raw: unknown) => {
  const r = normalizePhrase(raw);
  return r.ok ? null : r.problem;
};

describe("normalizePhrase", () => {
  it("NFKC で全角と半角をそろえ、英字を小文字にする", () => {
    expect(ok("ＡＢＣ１２３")).toBe("abc123");
    expect(ok("AbC")).toBe("abc");
    expect(ok("ｶﾀｶﾅ")).toBe("カタカナ");
    expect(ok("ネコ")).toBe("ネコ");
    expect(ok("①")).toBe("1");
  });

  it("前後の空白を除き、連続する空白（全角の空白も）を 1 つにする", () => {
    expect(ok("  hello   world  ")).toBe("hello world");
    expect(ok("　あい　　ことば　")).toBe("あい ことば");
    expect(ok("a  b")).toBe("a b");
  });

  it("同じ結果になる入力どうしが同じ合言葉", () => {
    expect(ok("Ｋｙｏｓｈｏ　　１")).toBe(ok(" kyosho 1 "));
  });

  it(`長さは正規化した後の 1〜${PHRASE_MAX} 字（サロゲートペアは 1 字）`, () => {
    expect(ok("a".repeat(PHRASE_MAX))).toHaveLength(PHRASE_MAX);
    expect(ok("😀".repeat(PHRASE_MAX))).toBe("😀".repeat(PHRASE_MAX));
    expect(problem("a".repeat(PHRASE_MAX + 1))).toBe("long");
    expect(problem("あ".repeat(PHRASE_MAX + 1))).toBe("long");
    // 前後の空白は数えない
    expect(ok(`  ${"a".repeat(PHRASE_MAX)}  `)).toHaveLength(PHRASE_MAX);
    expect(problem("x".repeat(10_000))).toBe("long");
  });

  it("空・空白だけ・文字列でないものは empty", () => {
    expect(problem("")).toBe("empty");
    expect(problem("   ")).toBe("empty");
    expect(problem("　")).toBe("empty");
    expect(problem(undefined)).toBe("empty");
    expect(problem(12)).toBe("empty");
  });

  it("制御文字・見えない書式文字・単独のサロゲート・行の区切りは char", () => {
    for (const s of ["a\u0000b", "a\tb", "a\nb", "a\u007fb", "a​b", "a‍b", "a﻿b", "a\ud800b", "a b", "a b"]) {
      expect(problem(s), JSON.stringify(s)).toBe("char");
    }
  });
});
