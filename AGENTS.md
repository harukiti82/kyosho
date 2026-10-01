# 挟将 — エージェント向けガイド

オセロの盤で、挟んだ相手の駒を取って自分の持ち駒にする二人対戦ゲーム。ルール設計（`RULES.md`）、Python のバランス検証（`sim/`）、ブラウザ版（`web/`）からなる。

> ルールの正は `RULES.md`（v1.0「取った駒が持ち駒になる」）。解釈が曖昧なときは `sim/capture.py` の実装を正とする。
> 旧ルール v0.4 は `docs/RULES-v0.4.md` と `sim/kyosho.py` に履歴として残す（変更しない）。
> ユーザー向けの説明は README.md にある。

## 概要

- 目的: ルールを詰め、人間の試遊で面白さを確かめる
- 対象: 作者と試遊する人（ブラウザ版は同じ端末での 2 人対戦と CPU 対戦）
- 状況: v0.4 の試遊で「難しい」「普通のオセロと変わらない」と出たため v1.0 に作り直した。ブラウザ版で v1.0 の試遊を始める段階
- 最重要要件: **ルールが一目で分かること**（4 行ルールの常時表示・取れる駒とダメージの予測・取られうる駒の警告）

## 技術スタック

| 領域 | 採用 | 補足 |
|---|---|---|
| シミュレーター | Python 3.12 | 標準ライブラリのみ |
| ブラウザ版 | TypeScript 7 + Vite 8 | UI フレームワークなし（DOM API 直書き） |
| テスト | Vitest 5 / Playwright（chromium ヘッドレス） | |

## ディレクトリ規約

```
kyosho/
├── .github/workflows/pages.yml ← PR でテスト+ビルド、main への push で GitHub Pages にデプロイ
├── RULES.md          ← ルール本体（v1.0）・検証結果・改訂履歴（ルール変更はここが起点）
├── docs/RULES-v0.4.md ← 旧ルール v0.4 の本文（履歴）
├── sim/              ← Python のルールエンジンとバランス検証スクリプト
│   ├── capture.py        ← v1.0 のエンジンとボット（random / greedy / lookahead）
│   ├── check_capture.py  ← v1.0 の検証値（RULES.md の表）
│   ├── export_replays.py ← web の整合テスト用棋譜を書き出す（capture.py 用）
│   └── kyosho.py ほか    ← v0.4 のシミュレーター（履歴。変更しない）
└── web/
    ├── src/engine/   ← ルールエンジン（DOM に依存しない。ここだけでゲームが完結する）
    ├── src/ui/       ← 画面の表示と入力（計算は engine に任せる）
    ├── test/         ← Vitest（engine のユニットテスト + Python 棋譜の再生テスト）
    ├── e2e/          ← Playwright（ヘッドレスで実際に終局まで打つ）
    └── screenshots/  ← e2e が保存するスクリーンショット
```

- `src/engine/` に DOM・タイマー・乱数の直接参照を入れない（CPU の乱数は引数で受ける）
- `src/ui/` に取り・ダメージなどのルール計算を書かない（予測・警告もエンジンの `previewMove` / `threatenedPieces` を使う）
- 動的な文字列は `textContent` / `ui/dom.ts` の `h()` で入れる。`innerHTML` は使わない

## コマンド

| 用途 | コマンド |
|---|---|
| dev | `cd web && npm run dev` |
| build | `cd web && npm run build`（`tsc --noEmit` 込み、`base: "./"`） |
| typecheck | `cd web && npm run typecheck` |
| test | `cd web && npm test` |
| e2e | `cd web && npm run e2e`（ビルド → `vite preview :4179` を自動起動） |
| 棋譜の再生成 | `python3 sim/export_replays.py`（約 40 秒） |
| 公開 | main への merge で自動デプロイ → https://harukiti82.github.io/kyosho/ （workflow は main 直 push せず PR 経由で変更） |
| シミュレーター | `RULES.md` のシミュレーター節を参照 |

## ルールを変えるとき

1. `RULES.md` を更新（改訂履歴も）
2. `sim/capture.py` の `Rules`（と `export_replays.py` / `check_capture.py` が渡す値）と `web/src/engine/rules.ts` の両方を直す
3. `python3 sim/export_replays.py` で棋譜を作り直し、`npm test` で Python と TS の一致を確認
4. `web/index.html` の 4 行ルール（`#rules4`）とルール説明ダイアログも同期する

## AI 向け詳細仕様

- ルール: `RULES.md`（必要時に Read）
- エンジンの公開関数: `web/src/engine/game.ts`（`createGame` / `playMove` / `previewMove` / `threatenedPieces` / `canMove`）と `cpu.ts`（`chooseLookahead`）

### 作業履歴メモ（毎ターン参照・更新）

- 現在の作業状況（毎ターン上書き）: @.agent/activeContext.md
- 完了タスクの時系列（毎ターン追記）: @.agent/progress.md

セッション開始時に必ず両方読み、応答終了前に `activeContext` は最新状態で**上書き**、
作業が一段落していれば `progress` の末尾に**1〜3 行で追記**する。
スキップ可能なターン（単発質問への回答、タイポ修正のみ）では更新しない。

## デザイン規約

Glass Pastel（ニュートラル系）。トークンは `web/src/style.css` の `:root` に集約。

- accent-from / to: `#7A8E5F` → `#C77456`
- ink: `#1F1B14` / ink-muted: `#5C6B4D`
- 盤: 枠 `#5F7148`・マス `#8FA374`。先手は黒石、後手は白石

## コミット規約

グローバル CLAUDE.md（`~/.claude/CLAUDE.md`）の「Git コミット」節に従う。
