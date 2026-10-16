// e2e の既定の保存: 初めての人の遊び方の必須（ui/intro.ts）を解いた印と、オンライン対戦の前の名前の案内（ui/namedialog.ts）を出した印。
// ほとんどの e2e は空の localStorage でメニューから対局を始めるので、設定ファイル（playwright*.config.ts）の storageState と
// オンラインのコンテキスト（online/net.ts）に入れる。必須を確かめるテストは storageState を空にして（EMPTY_STATE）、
// 名前の案内を確かめるテストは必須を解いた印だけ（introOnlyState）で始める。
// 設定ファイルからも読むので、画面のコード（src/）は import しない（キーと保存の形は ui/intro.ts・ui/namedialog.ts と揃える）

export const INTRO_CLEARED = { name: "kyosho:intro", value: JSON.stringify({ v: 1, state: "cleared" }) };
export const NAME_ASKED = { name: "kyosho:name-ask", value: JSON.stringify({ v: 1 }) };

/** origins（http://localhost:4179 など）で必須を解き、名前の案内も出した保存 */
export const clearedState = (origins: readonly string[]) => ({
  cookies: [],
  origins: origins.map((origin) => ({ origin, localStorage: [INTRO_CLEARED, NAME_ASKED] })),
});

/** 必須を解いただけ（名前の案内はまだ） */
export const introOnlyState = (origins: readonly string[]) => ({
  cookies: [],
  origins: origins.map((origin) => ({ origin, localStorage: [INTRO_CLEARED] })),
});

/** 何も保存していない（初めての人） */
export const EMPTY_STATE = { cookies: [], origins: [] };
