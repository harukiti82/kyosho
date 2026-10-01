# 挟将 — エージェント向けガイド

オセロの盤で、挟んだ相手の駒の数字がダメージになる二人対戦ゲーム。ルール設計（`RULES.md`）、Python のバランス検証（`sim/`）、ルールを組み合わせて遊び比べるブラウザの試遊版（`web/`）からなる。

> ルールの正は `RULES.md`（v1.0「取った駒が持ち駒になる」）。解釈が曖昧なときは `sim/capture.py` の実装を正とする。
> Web 試遊版の設定項目とプリセット（隠し王を含む）は `RULES.md` の「Web 試遊版」節。プリセット v0.4 / v1.0 / v2 案は `sim/kyosho.py` / `sim/capture.py` / `sim/gate.py` と全手一致させる。
> 旧ルール v0.4 は `docs/RULES-v0.4.md` と `sim/kyosho.py` に履歴として残す（変更しない）。
> ユーザー向けの説明は README.md にある。

## 概要

- 目的: ルールを詰め、人間の試遊で面白さを確かめる
- 対象: 作者と試遊する人（ブラウザ版は同じ端末での 2 人対戦と CPU 対戦。ルールは設定画面で組み合わせる）
- 状況: v0.4 は「難しい」「普通のオセロと変わらない」、v1.0 は「オセロじゃなくてもよくなって悪化」。読み合いを足すため「隠し王」（相手に見えない王）を設定項目とプリセットに追加した。どの組み合わせが面白いかをユーザー自身が遊び比べる段階（ルールの決定はユーザーがする）
- 最重要要件: **ルールが一目で分かること**（設定から生成するルールカードの常時表示・返せる駒とダメージ・回復の予測・返されうる駒の警告）

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
│   ├── gate.py           ← v2 案（置いた駒より強い駒は返せない）のエンジンとボット
│   ├── check_capture.py  ← v1.0 の検証値（RULES.md の表）
│   ├── export_replays.py ← web の整合テスト用棋譜を書き出す（kyosho.py / capture.py / gate.py の 3 本）
│   └── kyosho.py ほか    ← v0.4 のシミュレーター（履歴。ロジックは変更しない）
└── web/
    ├── src/engine/   ← ルールエンジン（DOM に依存しない。RuleSet で全組み合わせを扱う。ここだけでゲームが完結する）
    ├── src/ui/       ← 画面の表示と入力（app.ts: 対局画面 / setup.ts: 設定画面 / query.ts: URL ⇔ 設定 / ruletext.ts: ルール文）
    ├── test/         ← Vitest（engine・URL・ルール文のユニットテスト + Python 棋譜の再生テスト）
    ├── e2e/          ← Playwright（ヘッドレスで実際に終局まで打つ。king.spec.ts は種付き乱数の鏡の対局で隠し王を確かめる）
    ├── scripts/      ← バランス確認（balance.ts を Vite の runnerImport で Node 実行。`npm run balance`）
    └── screenshots/  ← e2e が保存するスクリーンショット
```

- `src/engine/` に DOM・タイマー・乱数の直接参照を入れない（CPU の乱数は引数で受ける）
- `src/ui/` に取り・ダメージなどのルール計算を書かない（予測・警告もエンジンの `previewMove` / `threatenedPieces` を使う）
- 隠し王の真の場所（`GameState.kings`）は隠し情報。`src/ui/` と `engine/cpu.ts` からは直接読まず、CPU は `viewFor(state, 自分)`、UI は `kingInfo(state, 見せてよい人)` を使う（`test/king.test.ts` がソースを検査する）
- URL クエリは外部入力。`ui/query.ts` の `decodeRules` で型・範囲を検証し、不正な項目は既定値に戻す
- 動的な文字列は `textContent` / `ui/dom.ts` の `h()` で入れる。`innerHTML` は使わない

## コマンド

| 用途 | コマンド |
|---|---|
| dev | `cd web && npm run dev` |
| build | `cd web && npm run build`（`tsc --noEmit` 込み、`base: "./"`） |
| typecheck | `cd web && npm run typecheck` |
| test | `cd web && npm test` |
| e2e | `cd web && npm run e2e`（ビルド → `vite preview :4179` を自動起動） |
| バランス確認 | `cd web && npm run balance -- 400 king`（2 手読み同士。第 3 引数で体力 "先手,後手"） |
| 棋譜の再生成 | `python3 sim/export_replays.py`（v0.4 / v1.0 / v2 案、約 30 秒） |
| 公開 | main への merge で自動デプロイ → https://harukiti82.github.io/kyosho/ （workflow は main 直 push せず PR 経由で変更） |
| シミュレーター | `RULES.md` のシミュレーター節を参照 |

## ルール・設定項目を変えるとき

- プリセットの値を変える: `web/src/engine/rules.ts` の `PRESETS` と `RULES.md` の「Web 試遊版」節。v0.4 / v1.0 / v2 案は対応するシミュレーターの `Rules`（`sim/export_replays.py` が渡す値）も揃える
- 設定項目を足す: `RuleSet`（`engine/rules.ts`）→ エンジン（`board.ts` / `game.ts` / `cpu.ts`）→ `ui/query.ts`（URL の検証）→ `ui/ruletext.ts`（ルールカード・詳細の文）→ `index.html` の設定フォームと `ui/setup.ts`
- シミュレーターのルールを変えたら `python3 sim/export_replays.py` で棋譜を作り直し、`npm test` で Python と TS の一致を確認
- 対局画面のルールカード・ルール詳細は設定から自動生成する（`index.html` に固定の文は書かない）

## AI 向け詳細仕様

- ルール: `RULES.md`（必要時に Read）
- エンジンの公開関数: `web/src/engine/game.ts`（`createGame(rules)` / `playMove(state, r, c, kind, { king })` / `legalCells` / `playableKinds` / `previewMove` / `threatenedPieces` / `canMove` / `judge` / 隠し王の `kingInfo` / `kingCandidates` / `viewFor`）と `cpu.ts`（`chooseLookahead(viewFor(state, turn))`）。設定の型とプリセットは `rules.ts`（`RuleSet` / `PRESETS` / `NO_KING`）

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
