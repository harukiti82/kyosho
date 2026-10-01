# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: ブラウザ版（`web/`）を GitHub Pages で公開済み（https://harukiti82.github.io/kyosho/）。人間の試遊待ち
- ステータス: 試遊フィードバック待ち
- 最終更新: 2026-10-01

## 直近の観点・指摘

- 試遊でルールを確かめるのが目的。計算結果の正確さ（Python と一致）と予測表示の分かりやすさを最優先
- ルールの数値は勝手に変えない。違和感は報告に書いてユーザーに判断を仰ぐ
- スマホ（幅 375px）で横スクロールなし・誤タップ防止（1 回目は予測、2 回目で確定）を維持する

## 未解決・次の一手

- [ ] 人間の試遊で出た指摘を反映（序盤の緊張感・終盤の逆転感・角の温存判断）

## 現フェーズで Read すべき設計書

- ルール変更・調整: `RULES.md` → `sim/kyosho.py` → `web/src/engine/rules.ts`
- 画面の修正: `web/src/ui/app.ts`, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`
- デプロイ: `.github/workflows/pages.yml`（PR はテスト+ビルドのみ、main への push でデプロイ）
