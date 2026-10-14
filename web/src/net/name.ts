// プレイヤーの名前（設定メニューで決め、名札・終局画面に出す。オンライン対戦では相手の画面にも出る）の正規化と検証。
// 画面とサーバーが共通で import する（DOM なし）。見えない文字の弾き方は合言葉（net/phrase.ts）と同じ。
// 仕様は .agent/online-protocol.md の「名前」

import { FORBIDDEN } from "./phrase";

/** 名前の長さの上限（文字数。サロゲートペアは 1 字。絵文字の肌の色などの組み合わせは 2 字以上に数える） */
export const NAME_MAX = 10;

/** 結合文字（濁点・アクセントなど）が続いてよい数。これより多く重ねると字が上下にはみ出すので弾く */
const MARKS = /\p{M}{4,}/u;

/** long: NAME_MAX 字を超える / char: 使えない文字（改行・制御文字・見えない文字・重ねすぎた結合文字）がある */
export type NameProblem = "long" | "char";

/** name が "" なら名前なし（今までどおり「あなた」「先手」などで呼ぶ） */
export type NameResult = { ok: true; name: string } | { ok: false; problem: NameProblem };

/**
 * 名前を正規化する: NFC → 使えない文字の検査 → 連続する空白を 1 つの半角の空白 → 前後の空白を除く。
 * 合言葉と違って NFKC・小文字にはしない（全角の英字など、決めた字のまま見せる）。空（空白だけ）は名前なしで ok
 */
export function normalizeName(raw: unknown): NameResult {
  if (raw === undefined || raw === null) return { ok: true, name: "" };
  if (typeof raw !== "string") return { ok: false, problem: "char" };
  // 長すぎる入力は正規化の前に切る
  if (raw.length > NAME_MAX * 8) return { ok: false, problem: "long" };
  const n = raw.normalize("NFC");
  if (FORBIDDEN.test(n) || MARKS.test(n)) return { ok: false, problem: "char" };
  const name = n.replace(/\s+/gu, " ").trim();
  if ([...name].length > NAME_MAX) return { ok: false, problem: "long" };
  return { ok: true, name };
}

/** 名前の問題を画面に出す短い文（設定メニューの欄の検証） */
export const NAME_PROBLEM_TEXT: Record<NameProblem, string> = {
  long: `${NAME_MAX}文字まで`,
  char: "使えない文字があります",
};
