# Progress Log

> AI が作業完了時に**末尾へ追記**する時系列ログ。新しいものほど下。
> 14 日より古いエントリがあるか 30 件を超えたら、`progress-archive.md` への移送を提案する（自動削除はしない）。

---

## 2026-10-01

- ルール v0.4 とバランス検証シミュレーター（`sim/`）を追加
- ブラウザ版（`web/`）: TS エンジン + 2 手読み CPU + 画面を実装。Python 棋譜 76 局との整合テスト、Playwright で CPU/2 人/角ありを終局まで確認
- AGENTS.md / README / `.agent/` を整備
- GitHub Pages 公開: `.github/workflows/pages.yml` を追加し https://harukiti82.github.io/kyosho/ にデプロイ
- ルール v1.0「取った駒が持ち駒になる」に作り直し: RULES.md 改稿（v0.4 は `docs/RULES-v0.4.md`）、web のエンジン・CPU・UI・テストを置き換え
- v1.0 の整合テスト（`sim/capture.py` の 50 局と全手一致）、UI に 4 行ルール常時表示・取れる駒の予測・取られうる駒の警告・取った駒の演出を追加
- Web 版を試遊版に作り直し: エンジンを `RuleSet` で一般化（裏返す/取る・強さ制限・ダメージ・回復・体力・駒数・手数上限）、プリセット 4 種・設定画面・URL 共有・自動生成ルールカード
- Python 整合を 3 本に拡張（kyosho / capture / gate の 86 局で全手・2 手読み候補一致）、e2e で 4 プリセットを終局まで確認
- 隠し王（読み合い要素）を追加: エンジン（王の指定・期限の自動指定・罰・公開・`viewFor` の隠し情報境界）、CPU（候補の期待値・自分の王の守り・指定の手をランダム化）、設定・URL・ルールカード、プリセット「隠し王」（体力 70・60）
- `npm run balance`（Vite runnerImport で TS エンジンを Node 実行）で 400 局のバランス確認。e2e に `king.spec.ts`（種付き乱数の鏡の対局で CPU の王を返す・2 人対戦の確認ボタン・期限 1 手）
