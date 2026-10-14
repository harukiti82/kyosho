// 合言葉（オンライン対戦で、同じ言葉を入れた 2 人を同じ部屋にする）の正規化と検証。画面とサーバーが共通で import する（DOM なし）。
// 仕様は .agent/online-protocol.md の「合言葉」

/** 正規化した合言葉の長さの上限（文字数。サロゲートペアは 1 字） */
export const PHRASE_MAX = 20;

/** 合言葉に使えない文字: 制御文字・書式文字（ゼロ幅の空白など、見えない違い）・単独のサロゲート・行や段落の区切り */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** empty: 空（空白だけを含む） / long: PHRASE_MAX 字を超える / char: 使えない文字がある */
export type PhraseProblem = "empty" | "long" | "char";

export type PhraseResult = { ok: true; phrase: string } | { ok: false; problem: PhraseProblem };

/**
 * 合言葉を正規化する: NFKC（全角と半角をそろえる）→ 使えない文字の検査 → 英字を小文字 → 連続する空白を 1 つ → 前後の空白を除く。
 * 正規化した後の長さで 1〜PHRASE_MAX 字を確かめる。同じ結果になる合言葉どうしがつながる
 */
export function normalizePhrase(raw: unknown): PhraseResult {
  if (typeof raw !== "string") return { ok: false, problem: "empty" };
  // 長すぎる入力は正規化の前に切る（NFKC は文字数を増やすことがあるので、上限の数倍で見る）
  if (raw.length > PHRASE_MAX * 8) return { ok: false, problem: "long" };
  const n = raw.normalize("NFKC");
  if (FORBIDDEN.test(n)) return { ok: false, problem: "char" };
  const phrase = n.toLowerCase().replace(/\s+/gu, " ").trim();
  if (phrase.length === 0) return { ok: false, problem: "empty" };
  if ([...phrase].length > PHRASE_MAX) return { ok: false, problem: "long" };
  return { ok: true, phrase };
}
