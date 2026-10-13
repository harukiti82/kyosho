// Service Worker の本体。ビルドのとき pwa/plugin.ts がこの関数を toString() で sw.js に書き出し、
// 版（precache する中身のハッシュ）とファイルの一覧を引数に埋める。ユニットテスト（test/sw.test.ts）は偽の self で同じ関数を動かす。
// そのため関数の中から外（import・モジュールの定数）を参照しない。SW のグローバル（URL・Response・setTimeout など）だけを使う。
//
// キャッシュの方針:
// - 画面の入口（scope の URL への navigation）はネットワークを優先し、成功したらキャッシュを更新、失敗・待ちすぎならキャッシュ
// - ハッシュ付きの assets/ はキャッシュを優先（中身が変われば名前も変わる）。ほかの precache 済みのファイルもキャッシュから
// - 横取りしない: GET 以外・別オリジン（static.cloudflareinsights.com など）・scope の外・/api（HTTP と WebSocket）・/cdn-cgi
// 新しい版は install で次の版のキャッシュを作り終えたらすぐ有効にし（skipWaiting）、activate で前の版のキャッシュを消す。
// 開いている画面は読み直さない（対局を壊さない）。次に開いたときは入口がネットワーク優先なので新しい版になる

/** SW のイベント（WebWorker の型は DOM の型と一緒に読めないので、使う所だけ） */
export interface SwExtendableEvent {
  waitUntil(p: Promise<unknown>): void;
}
export interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}

/** sw.js の self のうち使う所。テストでは偽物を渡す */
export interface SwScope {
  readonly registration: { readonly scope: string };
  readonly caches: CacheStorage;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", fn: (e: SwExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: SwFetchEvent) => void): void;
}

export interface SwOptions {
  /** 入口をネットワークから待つ長さ（ミリ秒）。過ぎたらキャッシュを返し、取れた分は裏でキャッシュに入れる */
  navTimeoutMs?: number;
}

/**
 * Service Worker を動かす。
 * @param version 版。キャッシュの名前 kyosho-<version> になる
 * @param files scope からの相対パスで precache するファイル（入口の index.html は含めず、scope の URL そのものを別に入れる）
 */
export function serviceWorker(sw: SwScope, version: string, files: readonly string[], options: SwOptions = {}): void {
  const PREFIX = "kyosho-";
  const CACHE = PREFIX + version;
  const navTimeoutMs = options.navTimeoutMs ?? 4000;
  const scope = new URL(sw.registration.scope);
  // 入口は scope の URL（./）で持つ。index.html は Cloudflare では / へのリダイレクトになるので使わない
  const shell = scope.href;
  const precache = [shell, ...files.map((f) => new URL(f, scope).href)];
  const assetsPath = `${scope.pathname}assets/`;

  // 横取りしないリクエスト（respondWith を呼ばず、ブラウザがふつうに取る）
  const bypass = (req: Request): boolean => {
    if (req.method !== "GET") return true;
    const url = new URL(req.url);
    if (url.origin !== scope.origin) return true;
    if (!url.pathname.startsWith(scope.pathname)) return true;
    // /api はオリジンの直下（protocol.ts の API_PATH）。/cdn-cgi は Cloudflare がエッジで足すもの（計測など）
    return url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/");
  };

  // キャッシュに入れられる応答か（同じオリジンの 200 番台。リダイレクトを経た応答は navigation に返せないので作り直す）
  const storable = (res: Response): boolean => res.ok && res.type === "basic";
  const clean = async (res: Response): Promise<Response> =>
    res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res;

  sw.addEventListener("install", (e) => {
    e.waitUntil(
      (async () => {
        const cache = await sw.caches.open(CACHE);
        await Promise.all(
          precache.map(async (url) => {
            // HTTP キャッシュ（GitHub Pages は max-age=600）の古い入口を掴まないよう確かめ直す
            const res = await sw.fetch(url, { cache: "no-cache" });
            if (!storable(res)) throw new Error(`precache に失敗: ${url} ${res.status}`);
            await cache.put(url, await clean(res));
          }),
        );
        await sw.skipWaiting();
      })(),
    );
  });

  sw.addEventListener("activate", (e) => {
    e.waitUntil(
      (async () => {
        for (const key of await sw.caches.keys()) {
          if (key.startsWith(PREFIX) && key !== CACHE) await sw.caches.delete(key);
        }
        await sw.clients.claim();
      })(),
    );
  });

  // 入口: ネットワーク優先。scope の URL（クエリ付きを含む）の 200 はキャッシュを更新する
  const navigate = async (e: SwFetchEvent): Promise<Response> => {
    const req = e.request;
    const cache = await sw.caches.open(CACHE);
    const isShell = new URL(req.url).pathname === scope.pathname;
    const fresh = sw.fetch(new Request(req, { cache: "no-cache" })).then((res) => {
      if (isShell && storable(res)) e.waitUntil(clean(res.clone()).then((r) => cache.put(shell, r)));
      return res;
    });
    e.waitUntil(fresh.catch(() => undefined));
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), navTimeoutMs));
    const first = await Promise.race([fresh.catch(() => null), timeout]);
    if (first) return first;
    // オフライン・待ちすぎ: scope の中の navigation はどれも入口を返す（?room= も画面が案内を出す）
    const cached = await cache.match(shell, { ignoreVary: true });
    return cached ?? fresh;
  };

  // それ以外: キャッシュ優先。assets/ の取れた分は足しておく（前の版の画面が開いたまま新しい入口を読んだときなど）
  const cacheFirst = async (e: SwFetchEvent): Promise<Response> => {
    const req = e.request;
    const cache = await sw.caches.open(CACHE);
    // Vary（vite preview の Origin など）は見ない: module script は Origin を付けるが、precache の取得は付けない。中身はどれも静的
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await sw.fetch(req);
    if (storable(res) && new URL(req.url).pathname.startsWith(assetsPath)) e.waitUntil(cache.put(req, res.clone()));
    return res;
  };

  sw.addEventListener("fetch", (e) => {
    if (bypass(e.request)) return;
    e.respondWith(e.request.mode === "navigate" ? navigate(e) : cacheFirst(e));
  });
}
