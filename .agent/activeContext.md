# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: ブラウザ版（`web/`）を「ルールをスイッチで組み合わせて遊び比べる試遊版」にした（https://harukiti82.github.io/kyosho/）。ユーザーの試遊待ち
- ステータス: どの組み合わせが面白いかのユーザー判断待ち（ルールの決定はユーザーがする）
- 最終更新: 2026-10-01

## 直近の観点・指摘

- 最重要要件は「ルールが一目で分かること」。ルールカードは設定から自動生成（`ui/ruletext.ts`）。予測の赤枠＋ダメージ・回復、返されうる自駒の「!」を崩さない
- プリセット v0.4 / v1.0 / v2 案は `sim/kyosho.py` / `capture.py` / `gate.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- Web 版の終局判定は 体力 → 石数 → 引き分け。capture.py / gate.py は体力同点を引き分けにする（整合テストで読み替え済み）
- 裏返すルールでは、予測中に「この手で返す相手の駒」にも「!」が付く（返した後に返し返されうる、の意味）。分かりにくければ表示を分ける
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・タップ 2 回で確定を維持する
- v0.4（`sim/kyosho.py`・`docs/RULES-v0.4.md`）は履歴。ロジックは変更しない

## 未解決・次の一手

- [ ] ユーザーの試遊で出た指摘を反映（どのプリセット・組み合わせが良かったか、設定画面が迷わないか）
- [ ] 採用する組み合わせが決まったら RULES.md を新版に改稿し、既定プリセットを切り替える

## 現フェーズで Read すべき設計書

- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」
- 画面の修正: `web/src/ui/app.ts`（対局）, `web/src/ui/setup.ts`（設定）, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-setup / pc-v04 / pc-v10 / pc-v2 / pc-orig / pc-pass / pc-result / sp-* ）
- デプロイ: `.github/workflows/pages.yml`（PR はテスト+ビルドのみ、main への push でデプロイ）
