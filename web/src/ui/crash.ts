// 想定外のエラー（捕まえていない例外・拒否されたままの Promise）の知らせ。
// 画面はそのまま残し、小さな知らせ（#crash）を 1 回だけ出す。閉じればそのまま続けられ、「再読み込み」で読み込み直す。
// 2 回目からのエラーは知らせない（同じエラーが続けて起きても何度も出さない）。
// App より先に入れる（App の作成中の例外も拾う）。

/**
 * window の error のうち、この画面のエラーとして知らせるもの。
 * 別のオリジンのスクリプト（拡張機能・計測のスクリプト）の中身の見えないエラー「Script error.」と、
 * ブラウザが出す ResizeObserver の警告は知らせない
 */
export function isAppError(message: string, filename: string, hasError: boolean, origin: string): boolean {
  if (/^ResizeObserver loop/.test(message)) return false;
  if (!hasError && /^Script error\.?$/.test(message)) return false;
  if (filename && !filename.startsWith(`${origin}/`)) return false;
  return true;
}

export function installCrashNotice(win: Window = window): void {
  const doc = win.document;
  const box = doc.getElementById("crash") as HTMLDialogElement | null;
  if (!box) return;
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    // 開いているダイアログ（設定・終局画面など）があってもその上に出して押せるよう、モーダルで開く
    try {
      box.showModal();
    } catch {
      box.setAttribute("open", "");
    }
    doc.getElementById("crash-reload")?.focus();
  };
  doc.getElementById("crash-reload")?.addEventListener("click", () => win.location.reload());
  doc.getElementById("crash-close")?.addEventListener("click", () => box.close());
  win.addEventListener("error", (e) => {
    if (isAppError(e.message ?? "", e.filename ?? "", e.error != null, win.location.origin)) show();
  });
  win.addEventListener("unhandledrejection", () => show());
}
