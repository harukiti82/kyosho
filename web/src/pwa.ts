// PWA の Service Worker（ビルドが出す dist/sw.js。中身は pwa/sw.ts）を登録する。
// 本番ビルドだけ（npm run dev には sw.js がない）。SW が使えない・登録できないブラウザ（http の別ホスト・
// 埋め込みの iframe・プライベートの制限など）では何もしない。画面は SW がなくてもそのまま動く。

/** register に渡す中身（e2e と sw.js の置き場所に揃える） */
export const SW_URL = "./sw.js";

export function registerServiceWorker(nav: Navigator = navigator, win: Window = window): void {
  let container: ServiceWorkerContainer | undefined;
  try {
    container = "serviceWorker" in nav ? nav.serviceWorker : undefined;
  } catch {
    return;
  }
  if (!container) return;
  const sw = container;
  const go = () => {
    // scope は sw.js の置き場所（本番は /、GitHub Pages は /kyosho/）。
    // updateViaCache: "none" で sw.js を HTTP キャッシュから読まない（新しい版を見落とさない）
    sw.register(SW_URL, { scope: "./", updateViaCache: "none" }).catch(() => undefined);
  };
  // 初回の描画・読み込みと取り合わないよう、読み込みが終わってから
  if (win.document.readyState === "complete") go();
  else win.addEventListener("load", go, { once: true });
}
