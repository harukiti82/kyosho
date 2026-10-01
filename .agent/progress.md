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
