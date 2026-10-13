// 撮影スクリプト（capture/）で使う Node の関数だけの型（@types/node は入れていない）
declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}
