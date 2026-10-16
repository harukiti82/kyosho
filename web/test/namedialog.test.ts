import { describe, expect, it } from "vitest";
import { safeStore, type KeyValueStore } from "../src/net/online";
import { markNameAsked, NAME_ASK_KEY, nameAsked } from "../src/ui/namedialog";

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe("オンライン対戦の前の名前の案内の印", () => {
  it("印がなければまだ。出したら { v: 1 } を残し、次からは出さない", () => {
    const store = memStore();
    expect(nameAsked(store)).toBe(false);
    markNameAsked(store);
    expect(store.data[NAME_ASK_KEY]).toBe(JSON.stringify({ v: 1 }));
    expect(nameAsked(store)).toBe(true);
  });

  it("壊れた印も出したとみなす（何度も案内しない）", () => {
    expect(nameAsked(memStore({ [NAME_ASK_KEY]: "{" }))).toBe(true);
  });

  it("localStorage が使えなくても落ちない（印は残らない。画面の間は App が覚える）", () => {
    const broken = safeStore(() => {
      throw new Error("SecurityError");
    });
    expect(() => markNameAsked(broken)).not.toThrow();
    expect(nameAsked(broken)).toBe(false);
  });
});
