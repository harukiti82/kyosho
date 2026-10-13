// PWA の Service Worker（dist/sw.js）をビルドのたびに書き出す Vite のプラグイン（依存を足さず手で書く）。
// sw.js は名前を固定し、dist の直下に置く（scope は置いた場所 = 本番は /、GitHub Pages は /kyosho/）。
// 中身は pwa/sw.ts の serviceWorker を toString() したものに、版と precache の一覧を引数で埋めたもの。
// 版は precache するファイルの中身から作るので、どれか 1 つでも変われば sw.js のバイトが変わり、ブラウザが新しい版として入れ直す。

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Plugin } from "vite";
import { serviceWorker } from "./sw.ts";

/** SW のファイル名（固定。register の "./sw.js" と揃える） */
export const SW_FILE = "sw.js";

/** public/ のうち precache しないファイル（共有のカードの画像。画面では使わない） */
const PUBLIC_SKIP = new Set(["ogp.png"]);

/** precache するか（ビルドの成果物と public/ の相対パス）。入口の index.html は scope の URL で別に入れる */
export function shouldPrecache(file: string): boolean {
  if (file === "index.html" || file === SW_FILE) return false;
  if (file.endsWith(".map")) return false;
  return !PUBLIC_SKIP.has(file);
}

/** 中身から版を作る（SHA-256 の先頭 16 桁。ファイル名の順に並べて足す） */
export async function versionOf(contents: ReadonlyMap<string, Uint8Array | string>): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const name of [...contents.keys()].sort()) {
    const body = contents.get(name)!;
    parts.push(enc.encode(`${name}\0`), typeof body === "string" ? enc.encode(body) : body, enc.encode("\0"));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sw.js の中身 */
export function renderServiceWorker(version: string, files: readonly string[]): string {
  return [
    "// 挟将の Service Worker。web/pwa/plugin.ts がビルドのたびに書き出す（手で直さない）。元は web/pwa/sw.ts",
    `(${serviceWorker.toString()})(self, ${JSON.stringify(version)}, ${JSON.stringify(files)});`,
    "",
  ].join("\n");
}

/** public/ の下のファイルを相対パスで並べる */
function listPublic(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) out.push(...listPublic(path, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

export function pwaPlugin(): Plugin {
  let publicDir = "";
  return {
    name: "kyosho-pwa",
    apply: "build",
    // index.html（Vite の HTML の処理が出す）が揃ってから一覧を作る
    enforce: "post",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    async generateBundle(_options, bundle) {
      const contents = new Map<string, Uint8Array | string>();
      for (const item of Object.values(bundle)) {
        if (!shouldPrecache(item.fileName)) continue;
        contents.set(item.fileName, item.type === "chunk" ? item.code : item.source);
      }
      if (publicDir) {
        for (const file of listPublic(publicDir)) {
          if (shouldPrecache(file)) contents.set(file, readFileSync(`${publicDir}/${file}`));
        }
      }
      // 入口の index.html は一覧に入れないが、版には足す（文言だけ変えた版も入れ直す）
      const html = bundle["index.html"];
      if (html?.type === "asset") contents.set("index.html", html.source);
      const files = [...contents.keys()].filter(shouldPrecache).sort();
      this.emitFile({ type: "asset", fileName: SW_FILE, source: renderServiceWorker(await versionOf(contents), files) });
    },
  };
}
