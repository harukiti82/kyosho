# 挟将（きょうしょう）

オセロの盤と挟み方を使い、数値の違う持ち駒（歩1・銀2・金3・飛5）で体力を削り合う二人対戦ゲーム。
ルールは [RULES.md](RULES.md)（v0.4）を参照。

## ブラウザで遊ぶ（`web/`）

Node.js 22.12 以上が必要（Vitest 5 の要件。遊ぶだけなら Vite 8 の 20.19 以上でも可）。

```sh
cd web
npm install
npm run dev        # 表示された URL（既定 http://localhost:5173）を開く
```

- モード: CPU 対戦（先手・後手を選べる）／2 人対戦（同じ端末で交互）
- 追加ルール「角」は対局開始時の設定で ON/OFF
- 置けるマスにカーソルを乗せる（スマホは 1 回タップ）と、その手の攻撃・回復と返る駒を予測表示する。スマホは同じマスをもう一度タップで確定
- CPU は `sim/` の 2 手読みボット（自分の攻撃+回復 − 相手の最善応手の攻撃+回復）と同じ考え方で打つ

### 開発用コマンド

| 用途 | コマンド（`web/` で実行） |
|---|---|
| 本番ビルド（`web/dist/`、相対パスなのでどの静的ホスティングにも置ける） | `npm run build` |
| ビルド結果の確認 | `npm run preview` |
| 型チェック | `npm run typecheck` |
| ユニットテスト + Python エンジンとの整合テスト | `npm test` |
| ヘッドレスブラウザでの対局テスト（初回は `npx playwright install chromium`） | `npm run e2e` |

整合テストの棋譜（`web/test/fixtures/replays.json`）は `python3 sim/export_replays.py` で再生成できる。
ルールを変えたら Python と TypeScript の両方を直し、棋譜を作り直してから `npm test` を通す。

## バランス検証（`sim/`）

Python 3 のシミュレーター。使い方は [RULES.md のシミュレーター節](RULES.md#シミュレーター) を参照。
