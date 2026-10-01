# 挟将（きょうしょう）

オセロの盤で、挟んだ相手の駒を取って自分の持ち駒にする二人対戦ゲーム。取った駒の数字（歩1・金3・飛5）の合計が相手へのダメージになり、体力 20 を先に削り切った方が勝ち。
ルールは [RULES.md](RULES.md)（v1.0）を参照。

1. 持ち駒を空いているマスならどこにでも置ける
2. 置いた駒と自分の駒で挟んだ相手の駒を取って、自分の持ち駒にする
3. 取った駒の数字の合計が相手へのダメージ
4. 体力 0 以下で負け（80 手で終われば体力の多い方の勝ち）

## ブラウザで遊ぶ（`web/`）

公開版: **https://harukiti82.github.io/kyosho/**（main に push すると GitHub Actions で自動デプロイ）

手元で動かす場合:

Node.js 22.12 以上が必要（Vitest 5 の要件。遊ぶだけなら Vite 8 の 20.19 以上でも可）。

```sh
cd web
npm install
npm run dev        # 表示された URL（既定 http://localhost:5173）を開く
```

- モード: CPU 対戦（先手・後手を選べる）／2 人対戦（同じ端末で交互）
- 画面の上（PC は右列）に 4 行ルールを常に表示
- 置く駒を持ち駒から選び（最初は歩）、空いているマスに置く。置くと取れるマスには印が付く
- マスにカーソルを乗せる（スマホは 1 回タップ）と、取れる駒が赤枠で光り、ダメージ数を表示。スマホは同じマスをもう一度タップで確定
- 相手が次の 1 手で取れる自分の駒には「!」の警告が付く
- CPU は `sim/capture.py` の 2 手読みボット（自分のダメージ − 相手の最善応手のダメージ）と同じ考え方で打つ

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

Python 3 のシミュレーター（標準ライブラリのみ）。v1.0 は `sim/capture.py` / `sim/check_capture.py`。
使い方は [RULES.md のシミュレーター節](RULES.md#シミュレーター) を参照。旧ルール v0.4 は [docs/RULES-v0.4.md](docs/RULES-v0.4.md) と `sim/kyosho.py` に残している。
