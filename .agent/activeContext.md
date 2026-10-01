# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: ルール v1.0「取った駒が持ち駒になる」のブラウザ版（`web/`）を GitHub Pages で公開（https://harukiti82.github.io/kyosho/）。人間の試遊待ち
- ステータス: v1.0 の試遊フィードバック待ち
- 最終更新: 2026-10-01

## 直近の観点・指摘

- 最重要要件は「ルールが一目で分かること」。4 行ルールの常時表示、取れる駒の赤枠＋ダメージ数、取られうる自駒の「!」警告を崩さない
- 計算結果の正確さ（`sim/capture.py` と一致）を維持する。ルールの数値は勝手に変えない。違和感は報告に書いてユーザーに判断を仰ぐ
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・誤タップ防止（1 回目は予測、2 回目で確定）を維持する
- v0.4（`sim/kyosho.py`・`docs/RULES-v0.4.md`）は履歴。変更しない

## 未解決・次の一手

- [ ] v1.0 の人間の試遊で出た指摘を反映（4 行ルールだけで遊べるか・序盤の退屈さ・飛の置き場所の悩みが生まれるか）
- [ ] 試遊でも後手有利なら体力・持ち駒の調整案を出す（ボットでは先手勝率 47.0%）

## 現フェーズで Read すべき設計書

- ルール変更・調整: `RULES.md` → `sim/capture.py` → `web/src/engine/rules.ts`（AGENTS.md の「ルールを変えるとき」）
- 画面の修正: `web/src/ui/app.ts`, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-preview / pc-capture / pc-threat / pc-pass / sp-preview ほか）
- デプロイ: `.github/workflows/pages.yml`（PR はテスト+ビルドのみ、main への push でデプロイ）
