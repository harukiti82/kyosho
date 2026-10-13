// 「このゲームについて」のダイアログ（版・作者・権利・プライバシー・ルールの全文へのリンク）。
// 版の番号は web/package.json の version の 1 か所から出す（Vite は JSON の名前付き import で version だけを取り込む）。
// 文は index.html の #about に書き、ここでは版を入れて開け閉めするだけ。

import { version } from "../../package.json";
import { byId } from "./dom";

/** package.json の version（例: 1.0.0） */
export const APP_VERSION: string = version;

/** 画面に出す版。末尾の「.0」（修正の番号が 0）は落とす（1.0.0 → 1.0、1.0.1 → 1.0.1、1.2.0 → 1.2） */
export function versionLabel(v: string = APP_VERSION): string {
  return v.replace(/^(\d+\.\d+)\.0$/, "$1");
}

export class AboutDialog {
  private readonly dialog = byId<HTMLDialogElement>("about");

  constructor() {
    byId("about-version").textContent = `版 ${versionLabel()}`;
    byId("about-close").addEventListener("click", () => this.dialog.close());
  }

  open() {
    if (!this.dialog.open) this.dialog.showModal();
  }
}
