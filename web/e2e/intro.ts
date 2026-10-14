// e2e の既定の保存: 初めての人の遊び方の必須（ui/intro.ts）を解いた印。ほとんどの e2e は空の localStorage でメニューから対局を始めるので、
// 設定ファイル（playwright*.config.ts）の storageState とオンラインのコンテキスト（online/net.ts）に入れる。
// 必須を確かめるテストは storageState を空にして（EMPTY_STATE）始める。
// 設定ファイルからも読むので、画面のコード（src/）は import しない（INTRO_KEY と保存の形は ui/intro.ts と揃える）

export const INTRO_CLEARED = { name: "kyosho:intro", value: JSON.stringify({ v: 1, state: "cleared" }) };

/** origins（http://localhost:4179 など）で必須を解いた保存 */
export const clearedState = (origins: readonly string[]) => ({
  cookies: [],
  origins: origins.map((origin) => ({ origin, localStorage: [INTRO_CLEARED] })),
});

/** 何も保存していない（初めての人） */
export const EMPTY_STATE = { cookies: [], origins: [] };
