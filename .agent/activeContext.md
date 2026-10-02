# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: 試遊版（`web/`）に戦略要素「方向駒」（駒ごとに挟める方向が違う）を設定項目＋プリセット「方向駒」として追加した（https://harukiti82.github.io/kyosho/）。ユーザーの試遊待ち
- ステータス: 隠し王・方向駒が面白いか・どの組み合わせを採るかのユーザー判断待ち（ルールの決定はユーザーがする）
- 最終更新: 2026-10-02

## 直近の観点・指摘

- 最重要要件は「ルールが一目で分かること」。ルールカードは設定から自動生成（`ui/ruletext.ts`、方向駒は「挟めるのは駒の矢印の方向だけ（歩↕ 横↔ 角✕ 飛✚ 金✱）」の 1 行、最大 7 行）。予測の赤枠＋ダメージ・回復、返されうる自駒の「!」、自分の王の赤い「!」、駒の方向アイコン（`ui/diricon.ts` の SVG）を崩さない
- 方向駒: 盤上の駒は種類だけを持ち、数字は `RuleSet.values`、方向は `PIECES[kind].reach`。返せる列は `rawLines` → `pieceLines`（方向・強さ制限）。「!」と予測は相手の持ち駒の方向で計算
- プリセット「方向駒」は体力 60・65（60・60 だと 2 手読み同士で先手 60.9%（2000 局）→ 後手に +5 で 48.9%）。数値は RULES.md「Web 試遊版 > 方向駒」
- 既存プリセットは 全方向・既定の数字（歩1 銀2 金3 飛5）・横角 0 個。URL は方向駒の項目を既定値と違うときだけ載せる（既存の URL は不変、古い URL は全方向）
- 隠し情報: 相手の王は UI・CPU から見えない API 境界（`viewFor` / `kingInfo`）
- プリセット v0.4 / v1.0 / v2 案は `sim/kyosho.py` / `capture.py` / `gate.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる（6 行以上のルールカードは `.dense` で詰める）・タップ 2 回で確定・方向駒の持ち駒 5 種が 1 行
- v0.4（`sim/kyosho.py`・`docs/RULES-v0.4.md`）は履歴。ロジックは変更しない

## 未解決・次の一手

- [ ] ユーザーの試遊で方向駒・隠し王の感想を聞く（矢印と印だけで方向の違いが分かるか、角の温存や縦の列を空けない読みが生まれるか、盤の中央の歩の矢印が「盤上の駒の方向も効く」と誤解されないか）
- [ ] 採用する組み合わせが決まったら RULES.md を新版に改稿し、既定プリセットを切り替える

## 現フェーズで Read すべき設計書

- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」
- 方向駒の挙動: `web/src/engine/board.ts`（`pieceLines`）, `web/src/engine/game.ts`, `web/test/direction.test.ts`。隠し王: `game.ts`（隠し王節）, `cpu.ts`, `test/king.test.ts`
- 画面の修正: `web/src/ui/app.ts`（対局）, `web/src/ui/setup.ts`（設定）, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-* / sp-* 、隠し王は *-king-*、方向駒は *-dir*）
- デプロイ: `.github/workflows/pages.yml`（PR はテスト+ビルドのみ、main への push でデプロイ）
