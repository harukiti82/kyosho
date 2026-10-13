// PWA の Service Worker（pwa/sw.ts）と書き出し（pwa/plugin.ts）、登録（src/pwa.ts）のテスト。
// SW は偽の self（キャッシュ・fetch・イベント）で動かす。sw.js の中身も同じ偽物で評価して、toString() で壊れないことを見る

import { describe, expect, it } from "vitest";
import { renderServiceWorker, shouldPrecache, SW_FILE, versionOf } from "../pwa/plugin";
import { serviceWorker, type SwExtendableEvent, type SwFetchEvent, type SwScope } from "../pwa/sw";
import { registerServiceWorker, SW_URL } from "../src/pwa";

/** Map で持つ偽の Cache（URL で引く。クエリも区別する） */
class FakeCache {
  readonly store = new Map<string, Response>();
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.store.get(urlOf(req));
    return hit?.clone();
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    this.store.set(urlOf(req), res.clone());
  }
}
const urlOf = (req: RequestInfo | URL): string => (typeof req === "string" ? req : req instanceof URL ? req.href : req.url);

class FakeCaches {
  readonly map = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name)!;
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.map.delete(name);
  }
}

type Handler = (e: SwExtendableEvent | SwFetchEvent) => void;

/** 偽の self。network が null ならオフライン（fetch が失敗する） */
function fakeSw(scope: string, network: Map<string, string> | null = new Map()) {
  const handlers = new Map<string, Handler>();
  const caches = new FakeCaches();
  const fetched: string[] = [];
  const state = { network, skipped: false, claimed: false };
  const sw = {
    registration: { scope },
    caches: caches as unknown as CacheStorage,
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = urlOf(input);
      fetched.push(url);
      if (!state.network) throw new TypeError("Failed to fetch");
      const body = state.network.get(url.split("?")[0]);
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200 });
    },
    async skipWaiting() {
      state.skipped = true;
    },
    clients: {
      async claim() {
        state.claimed = true;
      },
    },
    addEventListener(type: string, fn: Handler) {
      handlers.set(type, fn);
    },
  };
  // Node の Response は type が "default" なので、同じオリジンの応答（"basic"）として見せる
  const basic = sw.fetch;
  sw.fetch = async (input) => {
    const res = await basic(input);
    Object.defineProperty(res, "type", { value: "basic" });
    return res;
  };

  /** install / activate を起こして waitUntil を待つ */
  const lifecycle = async (type: "install" | "activate") => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)!({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };

  /** fetch を起こす。respondWith されなければ null（横取りしない） */
  const request = async (url: string, init: { method?: string; navigate?: boolean } = {}) => {
    const req = new Request(url, { method: init.method ?? "GET" });
    if (init.navigate) Object.defineProperty(req, "mode", { value: "navigate" });
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    handlers.get("fetch")!({
      request: req,
      waitUntil: (p) => waits.push(p),
      respondWith: (r) => {
        responded = Promise.resolve(r);
      },
    } as SwFetchEvent);
    if (!responded) return null;
    const res: Response = await responded;
    // 裏のキャッシュの更新（waitUntil）も待つ。足された分も待つので 2 回回す
    await Promise.all(waits);
    await Promise.all(waits);
    return { status: res.status, text: await res.text() };
  };

  return { sw: sw as unknown as SwScope, handlers, caches, fetched, state, lifecycle, request };
}

const ORIGIN = "https://kyosho.rukiharukichi.com";
const FILES = ["assets/index-a.js", "assets/index-a.css", "favicon.svg", "manifest.webmanifest"];

function site(base: string, html = "<html>v1</html>") {
  return new Map<string, string>([
    [base, html],
    ...FILES.map((f): [string, string] => [new URL(f, base).href, `body of ${f}`]),
  ]);
}

describe("install と activate", () => {
  it("install で入口（scope の URL）と一覧を版の名前のキャッシュに入れ、待たずに有効にする", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    const cache = t.caches.map.get("kyosho-v1")!;
    expect([...cache.store.keys()].sort()).toEqual([`${ORIGIN}/`, ...FILES.map((f) => `${ORIGIN}/${f}`)].sort());
    expect(t.state.skipped).toBe(true);
    // index.html（Cloudflare では / へのリダイレクト）は取りに行かない
    expect(t.fetched).not.toContain(`${ORIGIN}/index.html`);
  });

  it("precache のどれかが取れなければ install を失敗させる（前の版のまま）", async () => {
    const net = site(`${ORIGIN}/`);
    net.delete(`${ORIGIN}/assets/index-a.js`);
    const t = fakeSw(`${ORIGIN}/`, net);
    serviceWorker(t.sw, "v1", FILES);
    await expect(t.lifecycle("install")).rejects.toThrow(/precache/);
    expect(t.state.skipped).toBe(false);
  });

  it("activate で前の版のキャッシュだけを消し、開いている画面を受け持つ", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    await t.caches.open("kyosho-old");
    await t.caches.open("someone-else");
    serviceWorker(t.sw, "v2", FILES);
    await t.lifecycle("install");
    await t.lifecycle("activate");
    expect((await t.caches.keys()).sort()).toEqual(["kyosho-v2", "someone-else"]);
    expect(t.state.claimed).toBe(true);
  });
});

describe("fetch の振り分け", () => {
  it("/api（HTTP・WebSocket の upgrade の GET も）・/cdn-cgi・別オリジン・GET 以外・scope の外は横取りしない", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    for (const url of [
      `${ORIGIN}/api/health`,
      `${ORIGIN}/api`,
      `${ORIGIN}/api/rooms/abc/ws`,
      `${ORIGIN}/cdn-cgi/rum`,
      "https://static.cloudflareinsights.com/beacon.min.js",
    ]) {
      expect(await t.request(url), url).toBeNull();
    }
    expect(await t.request(`${ORIGIN}/api/rooms`, { method: "POST" })).toBeNull();
    // /apix は /api ではない（scope の中のふつうのファイル）
    expect(await t.request(`${ORIGIN}/apix`)).not.toBeNull();
  });

  it("GitHub Pages のサブパス: scope /kyosho/ の外（オリジン直下の /api・ほかの repo）は横取りしない", async () => {
    const base = "https://harukiti82.github.io/kyosho/";
    const t = fakeSw(base, site(base));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    expect([...t.caches.map.get("kyosho-v1")!.store.keys()]).toContain(`${base}assets/index-a.js`);
    expect(await t.request("https://harukiti82.github.io/other/")).toBeNull();
    expect(await t.request("https://harukiti82.github.io/api/health")).toBeNull();
    expect(await t.request(`${base}assets/index-a.js`)).toEqual({ status: 200, text: "body of assets/index-a.js" });
  });

  it("assets はキャッシュ優先（ネットワークに行かない）。キャッシュにない assets は取って足す", async () => {
    const net = site(`${ORIGIN}/`);
    net.set(`${ORIGIN}/assets/index-b.js`, "new js");
    const t = fakeSw(`${ORIGIN}/`, net);
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    t.fetched.length = 0;
    expect(await t.request(`${ORIGIN}/assets/index-a.js`)).toEqual({ status: 200, text: "body of assets/index-a.js" });
    expect(t.fetched).toEqual([]);
    expect(await t.request(`${ORIGIN}/assets/index-b.js`)).toEqual({ status: 200, text: "new js" });
    t.state.network = null;
    expect(await t.request(`${ORIGIN}/assets/index-b.js`)).toEqual({ status: 200, text: "new js" });
  });

  it("assets の外でキャッシュにないもの（ogp.png）は取るだけで入れない", async () => {
    const net = site(`${ORIGIN}/`);
    net.set(`${ORIGIN}/ogp.png`, "png");
    const t = fakeSw(`${ORIGIN}/`, net);
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    expect(await t.request(`${ORIGIN}/ogp.png`)).toEqual({ status: 200, text: "png" });
    expect(t.caches.map.get("kyosho-v1")!.store.has(`${ORIGIN}/ogp.png`)).toBe(false);
  });
});

describe("入口（navigation）", () => {
  it("ネットワーク優先: 新しい入口を返し、キャッシュも新しくする", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`, "<html>v1</html>"));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    t.state.network!.set(`${ORIGIN}/`, "<html>v2</html>");
    expect(await t.request(`${ORIGIN}/`, { navigate: true })).toEqual({ status: 200, text: "<html>v2</html>" });
    t.state.network = null;
    expect(await t.request(`${ORIGIN}/`, { navigate: true })).toEqual({ status: 200, text: "<html>v2</html>" });
  });

  it("オフライン: キャッシュの入口を返す。?room= の招待リンクも入口を返す", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    t.state.network = null;
    expect(await t.request(`${ORIGIN}/`, { navigate: true })).toEqual({ status: 200, text: "<html>v1</html>" });
    expect(await t.request(`${ORIGIN}/?room=${"A".repeat(22)}`, { navigate: true })).toEqual({ status: 200, text: "<html>v1</html>" });
  });

  it("クエリ付きの入口（?room=）が取れたら、クエリなしの入口のキャッシュを更新する", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`, "<html>v1</html>"));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    t.state.network!.set(`${ORIGIN}/`, "<html>v2</html>");
    await t.request(`${ORIGIN}/?rules=x`, { navigate: true });
    expect(await (await t.caches.map.get("kyosho-v1")!.match(`${ORIGIN}/`))!.text()).toBe("<html>v2</html>");
  });

  it("scope の中のほかのパスの 404 は入口のキャッシュに入れない", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    serviceWorker(t.sw, "v1", FILES);
    await t.lifecycle("install");
    expect((await t.request(`${ORIGIN}/nothing`, { navigate: true }))!.status).toBe(404);
    expect(await (await t.caches.map.get("kyosho-v1")!.match(`${ORIGIN}/`))!.text()).toBe("<html>v1</html>");
  });

  it("キャッシュがなくオフラインなら失敗を返す（ブラウザのオフラインの画面）", async () => {
    const t = fakeSw(`${ORIGIN}/`, null);
    serviceWorker(t.sw, "v1", FILES);
    await expect(t.request(`${ORIGIN}/`, { navigate: true })).rejects.toThrow();
  });

  it("ネットワークが待ちすぎたらキャッシュの入口を返す", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    serviceWorker(t.sw, "v1", FILES, { navTimeoutMs: 20 });
    await t.lifecycle("install");
    const slow = t.sw.fetch;
    (t.sw as { fetch: SwScope["fetch"] }).fetch = (input) =>
      new Promise((resolve) => setTimeout(() => resolve(slow(input)), 200));
    const started = Date.now();
    const res = await t.request(`${ORIGIN}/`, { navigate: true });
    expect(res).toEqual({ status: 200, text: "<html>v1</html>" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("sw.js の書き出し", () => {
  it("precache の対象: 入口・sw.js・source map・ogp.png は入れない", () => {
    expect(shouldPrecache("assets/index-a.js")).toBe(true);
    expect(shouldPrecache("icons/icon-192.png")).toBe(true);
    expect(shouldPrecache("manifest.webmanifest")).toBe(true);
    for (const f of ["index.html", SW_FILE, "assets/index-a.js.map", "ogp.png"]) expect(shouldPrecache(f), f).toBe(false);
  });

  it("版は中身で決まる: 同じ中身なら同じ、1 バイトでも違えば違う", async () => {
    const of = (entries: [string, Uint8Array | string][]) => versionOf(new Map(entries));
    const a = await of([["x.js", "1"], ["y.css", new Uint8Array([1, 2])]]);
    const b = await of([["y.css", new Uint8Array([1, 2])], ["x.js", "1"]]);
    const c = await of([["x.js", "2"], ["y.css", new Uint8Array([1, 2])]]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("書き出した sw.js を self に渡して評価すると、同じように動く", async () => {
    const t = fakeSw(`${ORIGIN}/`, site(`${ORIGIN}/`));
    const source = renderServiceWorker("abc", FILES);
    new Function("self", source)(t.sw);
    expect([...t.handlers.keys()].sort()).toEqual(["activate", "fetch", "install"]);
    await t.lifecycle("install");
    expect(t.caches.map.get("kyosho-abc")!.store.size).toBe(FILES.length + 1);
    expect(await t.request(`${ORIGIN}/api/health`)).toBeNull();
  });
});

describe("登録（src/pwa.ts）", () => {
  const win = (readyState: string) => {
    const listeners: string[] = [];
    let onLoad: (() => void) | null = null;
    return {
      listeners,
      fire: () => onLoad?.(),
      win: {
        document: { readyState },
        addEventListener: (type: string, fn: () => void) => {
          listeners.push(type);
          onLoad = fn;
        },
      } as unknown as Window,
    };
  };

  it("serviceWorker がないブラウザでは何もしない（例外を出さない）", () => {
    const w = win("complete");
    expect(() => registerServiceWorker({} as Navigator, w.win)).not.toThrow();
    expect(w.listeners).toEqual([]);
  });

  it("serviceWorker を読むだけで例外になる環境（埋め込みの iframe など）でも壊れない", () => {
    const nav = {
      get serviceWorker(): ServiceWorkerContainer {
        throw new DOMException("denied", "SecurityError");
      },
    } as Navigator;
    expect(() => registerServiceWorker(nav, win("complete").win)).not.toThrow();
  });

  it("読み込みの後に ./sw.js を scope ./・updateViaCache none で登録する。登録の失敗は握りつぶす", async () => {
    const calls: [string, RegistrationOptions | undefined][] = [];
    const nav = {
      serviceWorker: {
        register: (url: string, opts?: RegistrationOptions) => {
          calls.push([url, opts]);
          return Promise.reject(new Error("blocked"));
        },
      },
    } as unknown as Navigator;
    const w = win("loading");
    registerServiceWorker(nav, w.win);
    expect(calls).toEqual([]);
    expect(w.listeners).toEqual(["load"]);
    w.fire();
    expect(calls).toEqual([[SW_URL, { scope: "./", updateViaCache: "none" }]]);
    await new Promise((r) => setTimeout(r, 0));
  });
});
