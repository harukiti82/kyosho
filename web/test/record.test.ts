import { describe, expect, it } from "vitest";
import { safeStore, type KeyValueStore } from "../src/net/online";
import { addResult, emptyRecord, readRecord, RECORD_KEY, RecordBook, recordFor, recordSummary, recordViewer } from "../src/ui/record";

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

describe("通算の数え方", () => {
  it("CPU 対戦は強さごとに人間から見た勝ち・負け・引き分けを数える（人間が後手でも）", () => {
    const key = { mode: "cpu", level: "normal" } as const;
    let r = emptyRecord();
    r = addResult(r, key, recordViewer(key, 1), 1);
    r = addResult(r, key, recordViewer(key, 0), 1);
    r = addResult(r, key, recordViewer(key, 0), null);
    expect(recordFor(r, key)).toEqual({ wins: 1, losses: 1, draws: 1 });
    // ほかの強さ・2 人対戦は変わらない
    expect(r.cpu.easy).toEqual({ wins: 0, losses: 0, draws: 0 });
    expect(r.cpu.hard).toEqual({ wins: 0, losses: 0, draws: 0 });
    expect(r.pvp).toEqual({ wins: 0, losses: 0, draws: 0 });
  });

  it("2 人対戦は先手から見て数える（wins = 先手の勝ち、losses = 後手の勝ち）", () => {
    const key = { mode: "pvp" } as const;
    expect(recordViewer(key, 1)).toBe(0);
    let r = emptyRecord();
    for (const w of [0, 0, 1, null] as const) r = addResult(r, key, 0, w);
    expect(r.pvp).toEqual({ wins: 2, losses: 1, draws: 1 });
  });

  it("元の値を変えない", () => {
    const r = emptyRecord();
    addResult(r, { mode: "cpu", level: "easy" }, 0, 0);
    expect(r).toEqual(emptyRecord());
  });

  it("設定メニューの一覧は数えた対局がある分だけ", () => {
    let r = emptyRecord();
    expect(recordSummary(r)).toEqual([]);
    r = addResult(r, { mode: "cpu", level: "hard" }, 0, 0);
    r = addResult(r, { mode: "cpu", level: "easy" }, 0, 1);
    r = addResult(r, { mode: "pvp" }, 0, 0);
    expect(recordSummary(r)).toEqual(["イージー 0勝1敗", "ハード 1勝0敗", "2人対戦 先手1勝 後手0勝"]);
    r = addResult(r, { mode: "pvp" }, 0, null);
    expect(recordSummary(r)[2]).toBe("2人対戦 先手1勝 後手0勝 1分");
  });
});

describe("通算の保存", () => {
  it("保存がない・JSON でない・オブジェクトでないときは null", () => {
    expect(readRecord(memStore())).toBeNull();
    expect(readRecord(memStore({ [RECORD_KEY]: "{" }))).toBeNull();
    expect(readRecord(memStore({ [RECORD_KEY]: "3" }))).toBeNull();
    expect(readRecord(memStore({ [RECORD_KEY]: "null" }))).toBeNull();
  });

  it("形が崩れた項目だけ 0 にする", () => {
    const raw = { cpu: { easy: { wins: 2, losses: -1, draws: 1.5 }, normal: "x", hard: { wins: 3, losses: 4, draws: 0 } }, pvp: { wins: "2", losses: 1e400, draws: 1 } };
    const r = readRecord(memStore({ [RECORD_KEY]: JSON.stringify(raw) }))!;
    expect(r.cpu.easy).toEqual({ wins: 2, losses: 0, draws: 0 });
    expect(r.cpu.normal).toEqual({ wins: 0, losses: 0, draws: 0 });
    expect(r.cpu.hard).toEqual({ wins: 3, losses: 4, draws: 0 });
    expect(r.pvp).toEqual({ wins: 0, losses: 0, draws: 1 });
    expect(readRecord(memStore({ [RECORD_KEY]: "[]" }))).toEqual(emptyRecord());
  });

  it("帳簿は数えるたびに保存し、再読み込み（新しい帳簿）でも残る。消すと 0 に戻る", () => {
    const s = memStore();
    const book = new RecordBook(s);
    book.add({ mode: "cpu", level: "easy" }, 0, 0);
    book.add({ mode: "cpu", level: "easy" }, 0, 1);
    expect(new RecordBook(s).get().cpu.easy).toEqual({ wins: 1, losses: 1, draws: 0 });
    book.clear();
    expect(new RecordBook(s).get()).toEqual(emptyRecord());
  });

  it("別のタブで数えた分も足す（保存を読み直してから数える）", () => {
    const s = memStore();
    const a = new RecordBook(s);
    const b = new RecordBook(s);
    a.add({ mode: "pvp" }, 0, 0);
    b.add({ mode: "pvp" }, 0, 1);
    expect(a.get().pvp).toEqual({ wins: 1, losses: 1, draws: 0 });
  });

  it("壊れた保存は 0 から数え、次に数えたときに正しい形で上書きする", () => {
    const s = memStore({ [RECORD_KEY]: "{broken" });
    const book = new RecordBook(s);
    expect(book.get()).toEqual(emptyRecord());
    book.add({ mode: "cpu", level: "hard" }, 1, 1);
    expect(readRecord(s)!.cpu.hard).toEqual({ wins: 1, losses: 0, draws: 0 });
  });

  it("ストレージが使えないときは例外で止まらず、この画面の間だけ数える", () => {
    const store = safeStore(() => {
      throw new Error("SecurityError");
    });
    const book = new RecordBook(store);
    book.add({ mode: "cpu", level: "normal" }, 0, 0);
    book.add({ mode: "cpu", level: "normal" }, 0, null);
    expect(book.get().cpu.normal).toEqual({ wins: 1, losses: 0, draws: 1 });
    book.clear();
    expect(book.get()).toEqual(emptyRecord());
  });
});
