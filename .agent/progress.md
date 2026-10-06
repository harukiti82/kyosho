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

## 2026-10-02

- 方向駒を追加: 設定「挟める方向（全方向／駒ごと）」、駒「横」「角」、駒種ごとの数字（`RuleSet.values`）、プリセット「方向駒」（体力 60・65、`npm run balance` で 2000 局 48.9%）。既存プリセットは旧エンジンと 10,553 手で全手一致
- 方向のアイコン（SVG）・選んだ駒での印・予測・「!」、設定画面の駒の表、URL（既定値と違う項目だけ）、e2e `direction.spec.ts`
- 端の駒の力（攻撃に上乗せ）を追加: 返した列ごとに反対端の自駒の数字をダメージに足す（`damageOf` に集約、CPU・警告も上乗せ込み）、予測の内訳・端の駒の青枠・棋譜の内訳、URL `anc=atk`、プリセット「拠点」（体力 125・130、4000 局で先手 47.3%・平均 31.3 手）。既存 6 プリセットは旧エンジンと 1200 局 41,462 手で全手一致
- 手応えの演出を追加: ダメージ ÷ 受けた側の体力上限で 4 段階（ナイス！／会心！／痛恨！・王を討った！）、揺れ・粒・発光・特大の溜め、CPU からの被弾は赤、Web Audio の効果音と消音、終局の成績。e2e `impact.spec.ts`
- 決着の演出を追加: 終局画面の前に勝利（紙吹雪・暖色の光・ファンファーレ）／敗北（彩度を落として沈む・低い音・接戦の励まし・「再戦」の強調）／引き分け、2 人対戦は勝った側の駒色。タップ／クリック／Enter で飛ばす。`ui/outcome.ts`・e2e `result.spec.ts`

## 2026-10-04

- オンライン対戦サーバーを追加: `server/`（Workers + Durable Objects、1 部屋 = 1 DO、engine を import して手を検証、各自に `viewFor` だけを配信、トークンで再接続、alarm で放置部屋を削除、Origin 許可リスト）。通信仕様 `web/src/net/protocol.ts`・`.agent/online-protocol.md`
- サーバーのテスト 46 件（vitest-pool-workers、隠し王の秘匿・退避からの復帰を含む）、CI `.github/workflows/server.yml`、`wrangler dev` に 2 クライアントで 1 局を通す `server/scripts/play.mjs`

## 2026-10-05

- 画面とサーバーを 1 つの Cloudflare Worker・同一オリジンで配信する構成に: 静的アセット（`web/dist`、`run_worker_first` は `/api` だけ）、API・WebSocket を `/api` の下へ、Origin は同一オリジンのみ（CORS 撤去）、`npm run deploy` / `dev` / `deploy:check`、Vite の `/api` プロキシ、独自ドメイン `kyosho.rukiharukichi.com` の Custom Domain と `ALLOWED_ORIGINS`、CI `deploy.yml`（Secret 未設定ならスキップ）
- 画面にオンライン対戦モードを追加: 設定画面の「オンライン（招待リンク）」（`/api/health` に届く公開先だけ）、招待リンク・待機・参加の確認・エラーのダイアログ（`ui/online.ts`）、通信層 `net/online.ts`（sessionStorage のトークン・自動のつなぎ直し・ping、ユニットテスト 20 件）、隠し王の候補「?」、`npm run e2e:online`（wrangler dev で 2 ブラウザ、desktop / mobile 各 5 本）

## 2026-10-06

- 既定ルールをプリセット「標準」（ユーザー指定の URL の組み合わせ）に変更。URL の差分の基準は v1.0 に固定（`QUERY_BASE`）して共有済みの URL の意味を保ち、変更前の出力との互換テスト・オンラインで標準の 1 局を通す e2e を追加
- CPU 対戦の手番に「ランダム」を追加: 対局を始めるたびに抽選（「新しい対局」・再戦でも引き直す）し、開始時にトーストで先手・後手を知らせる。抽選は `crypto` で CPU の乱数（`Math.random`）に影響しない。e2e `seat.spec.ts`
