// アクセス解析（Cloudflare Web Analytics）。クッキーを使わない計測スクリプトを、本番のホスト名で開いたときだけ読み込む。
// localhost・vite preview（e2e）・wrangler dev・GitHub Pages では読み込まず、外へ何も送らない。
// 読み込みに失敗しても（広告ブロッカーなど）ゲームには関わらない。数えるのはページの表示だけで、独自のイベントは送らない。

/** Cloudflare のダッシュボードで発行したサイトのトークン（公開値。ページに埋め込まれる）。空なら何も読み込まない */
export const BEACON_TOKEN: string = "aa2807ed62f64a18af742b772bfd3cba";

export const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

/** 計測するホスト名。GitHub Pages（harukiti82.github.io）は移行が済むまでの仮の公開先なので数えない */
export const ANALYTICS_HOSTS: readonly string[] = ["kyosho.rukiharukichi.com"];

/** このホスト名で読み込む計測スクリプトの属性。読み込まないときは null */
export function beaconFor(hostname: string, token: string = BEACON_TOKEN): { src: string; config: string } | null {
  if (token === "" || !ANALYTICS_HOSTS.includes(hostname)) return null;
  return { src: BEACON_SRC, config: JSON.stringify({ token }) };
}

/** 本番のホスト名なら計測スクリプトを head に 1 つだけ足す。足したら true */
export function loadAnalytics(doc: Document = document, token: string = BEACON_TOKEN): boolean {
  try {
    const beacon = beaconFor(doc.location?.hostname ?? "", token);
    if (!beacon) return false;
    if (doc.querySelector(`script[src="${BEACON_SRC}"]`)) return false;
    const s = doc.createElement("script");
    s.defer = true;
    s.src = beacon.src;
    s.setAttribute("data-cf-beacon", beacon.config);
    doc.head.append(s);
    return true;
  } catch {
    // 計測はおまけ。失敗してもゲームを止めない
    return false;
  }
}
