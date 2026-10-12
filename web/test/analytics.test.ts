// アクセス解析: 本番のホスト名でトークンがあるときだけ、計測スクリプトを 1 回だけ足す

import { describe, expect, it } from "vitest";
import { ANALYTICS_HOSTS, BEACON_SRC, beaconFor, loadAnalytics } from "../src/ui/analytics";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** loadAnalytics が使う分だけの document（vitest は node 環境） */
function fakeDoc(hostname: string, opts: { failAppend?: boolean } = {}) {
  const added: { defer: boolean; src: string; attrs: Record<string, string> }[] = [];
  const doc = {
    location: { hostname },
    querySelector: (sel: string) => (sel === `script[src="${BEACON_SRC}"]` && added.length > 0 ? added[0] : null),
    createElement: () => {
      const el = { defer: false, src: "", attrs: {} as Record<string, string>, setAttribute: (k: string, v: string) => (el.attrs[k] = v) };
      return el;
    },
    head: {
      append: (el: (typeof added)[number]) => {
        if (opts.failAppend) throw new Error("append failed");
        added.push(el);
      },
    },
  };
  return { doc: doc as unknown as Document, added };
}

describe("beaconFor", () => {
  it("本番のホスト名でトークンがあれば、トークン入りの属性を返す", () => {
    expect(ANALYTICS_HOSTS).toEqual(["kyosho.rukiharukichi.com"]);
    const b = beaconFor("kyosho.rukiharukichi.com", TOKEN);
    expect(b).toEqual({ src: "https://static.cloudflareinsights.com/beacon.min.js", config: `{"token":"${TOKEN}"}` });
  });

  it("本番以外のホスト名では読み込まない", () => {
    for (const host of ["localhost", "127.0.0.1", "harukiti82.github.io", "kyosho.example.workers.dev", "rukiharukichi.com", ""]) {
      expect(beaconFor(host, TOKEN), host).toBeNull();
    }
  });

  it("トークンが空なら本番でも読み込まない", () => {
    expect(beaconFor("kyosho.rukiharukichi.com", "")).toBeNull();
  });
});

describe("loadAnalytics", () => {
  it("本番では defer の script を 1 つだけ head に足す。2 回呼んでも増えない", () => {
    const { doc, added } = fakeDoc("kyosho.rukiharukichi.com");
    expect(loadAnalytics(doc, TOKEN)).toBe(true);
    expect(loadAnalytics(doc, TOKEN)).toBe(false);
    expect(added).toHaveLength(1);
    expect(added[0].defer).toBe(true);
    expect(added[0].src).toBe(BEACON_SRC);
    expect(JSON.parse(added[0].attrs["data-cf-beacon"])).toEqual({ token: TOKEN });
  });

  it("localhost・トークンが空のときは何も足さない", () => {
    const local = fakeDoc("localhost");
    expect(loadAnalytics(local.doc, TOKEN)).toBe(false);
    expect(local.added).toHaveLength(0);
    const empty = fakeDoc("kyosho.rukiharukichi.com");
    expect(loadAnalytics(empty.doc, "")).toBe(false);
    expect(empty.added).toHaveLength(0);
  });

  it("要素を足せなくても例外を外に出さない", () => {
    const { doc } = fakeDoc("kyosho.rukiharukichi.com", { failAppend: true });
    expect(loadAnalytics(doc, TOKEN)).toBe(false);
  });
});
