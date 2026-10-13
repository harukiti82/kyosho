// pwa/plugin.ts がビルドのときに使う Node の関数の型だけ（@types/node は入れていない。vite.config.ts と同じ方針）
declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string): Uint8Array;
  export function statSync(path: string): { isDirectory(): boolean };
}
