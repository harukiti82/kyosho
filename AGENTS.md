# 挟将 — エージェント向けガイド

オセロの盤で、挟んだ相手の駒の数字がダメージになる二人対戦ゲーム。ルール設計（`RULES.md`）、Python のバランス検証（`sim/`）、ルールを組み合わせて遊び比べるブラウザの試遊版（`web/`）、オンライン対戦のサーバー（`server/`）からなる。

> ルールの正は `RULES.md`（v1.0「取った駒が持ち駒になる」）。解釈が曖昧なときは `sim/capture.py` の実装を正とする。
> Web 試遊版の設定項目とプリセット（隠し王・方向駒・拠点・既定の「標準」を含む）は `RULES.md` の「Web 試遊版」節。プリセット v0.4 / v1.0 / v2 案は `sim/kyosho.py` / `sim/capture.py` / `sim/gate.py` と全手一致させる。
> 旧ルール v0.4 は `docs/RULES-v0.4.md` と `sim/kyosho.py` に履歴として残す（変更しない）。
> ユーザー向けの説明は README.md にある。

## 概要

- 目的: ルールを詰め、人間の試遊で面白さを確かめる
- 対象: 作者と試遊する人（ブラウザ版は同じ端末での 2 人対戦・CPU 対戦・招待リンクでのオンライン対戦。ルールは設定画面で組み合わせる）
- 状況: v0.4 は「難しい」「普通のオセロと変わらない」、v1.0 は「オセロじゃなくてもよくなって悪化」。読み合いを足すため「隠し王」（相手に見えない王）、戦略性を足すため「方向駒」（駒ごとに挟める方向が違う）、駒を置くリスクとリターンを足すため「端の駒の力」（挟んだ端の自分の駒の数字もダメージに足す。プリセット「拠点」）を設定項目とプリセットに追加した。ユーザーが遊び比べて選んだ組み合わせ（方向駒＋端の駒の力＋隠し王−30＋回復は平均）をプリセット「標準」として既定にした。体力は 110・130（ユーザーが選んだ先手 125 は 2 手読み同士で先手勝率約 64% だったので、先手だけ下げた）（RULES.md 本文の改稿はまだ。ルールの決定はユーザーがする）
- 手応え: 大ダメージほど段階的に派手な演出・効果音、終局画面の前に勝ち・負け・引き分けの決着の演出、終局画面に成績（ルール上のボーナスではない。`ui/impact.ts` / `ui/outcome.ts` / `ui/fx.ts` / `ui/sound.ts`）
- 最重要要件: **ルールが一目で分かること**（設定から生成するルールカードの常時表示・返せる駒とダメージ・回復の予測・返されうる駒の警告・普通のオセロなら置けるマスの点線の枠（参考）・方向駒のアイコン・端の駒の青枠とダメージの内訳）

## 技術スタック

| 領域 | 採用 | 補足 |
|---|---|---|
| シミュレーター | Python 3.12 | 標準ライブラリのみ |
| ブラウザ版 | TypeScript 7 + Vite 8 | UI フレームワークなし（DOM API 直書き） |
| オンライン対戦サーバー | Cloudflare Workers + Durable Objects + 静的アセット（wrangler 4） | `web/src/engine` を import して手を検証する権威サーバー。テストは vitest 4 + `@cloudflare/vitest-pool-workers` |
| テスト | Vitest 5 / Playwright（chromium ヘッドレス） | |

## ディレクトリ規約

```
kyosho/
├── .github/workflows/pages.yml ← PR でテスト+ビルド、main への push で GitHub Pages にデプロイ
├── .github/workflows/server.yml ← server/ の型チェックとテスト
├── .github/workflows/deploy.yml ← main への push で画面＋サーバーを Cloudflare にデプロイ（Secret CLOUDFLARE_API_TOKEN 未設定ならスキップ）。PR はテストと --dry-run
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
    ├── src/ui/       ← 画面の表示と入力（app.ts: 対局画面（CPU・2 人・オンライン） / setup.ts: 設定画面 / online.ts: オンライン対戦の案内のダイアログ / query.ts: URL ⇔ 設定 / ruletext.ts: ルール文 / diricon.ts: 方向のアイコン / impact.ts: ダメージの段階と成績（DOM なし） / outcome.ts: 決着の演出の中身（DOM なし） / fx.ts: 段階・決着の演出 / sound.ts: 効果音）
    ├── src/net/      ← オンライン対戦（protocol.ts: 通信仕様の型と定数。画面とサーバーが共通で import する / online.ts: 画面の通信層（HTTP・WebSocket・トークン・つなぎ直し。DOM なし））
    ├── test/         ← Vitest（engine・URL・ルール文のユニットテスト + Python 棋譜の再生テスト）
    ├── e2e/          ← Playwright（ヘッドレスで実際に終局まで打つ。king.spec.ts / direction.spec.ts / anchor.spec.ts は種付き乱数の鏡の対局で隠し王・方向駒・拠点を確かめる。impact.spec.ts は段階の演出・効果音・成績、result.spec.ts は決着の演出、seat.spec.ts は CPU 対戦の手番の抽選、othello.spec.ts は普通のオセロなら置けるマスの枠、online-hidden.spec.ts は /api がない公開先で入口を出さないこと。e2e/online/ はサーバーを起こして 2 つのブラウザで対局する（`npm run e2e:online`））
    ├── scripts/      ← バランス確認（balance.ts を Vite の runnerImport で Node 実行。`npm run balance`）
    └── screenshots/  ← e2e が保存するスクリーンショット
server/               ← 画面（web/dist の静的アセット）と /api（オンライン対戦）を同じオリジンで配信する 1 つの Worker（設定 wrangler.jsonc、Worker の入口 src/index.ts、1 部屋 = 1 Durable Object の src/room.ts、入力検証 src/validate.ts、Workers 上のテスト test/、2 クライアントで 1 局を通す scripts/play.mjs）
```

- `src/engine/` に DOM・タイマー・乱数の直接参照を入れない（CPU の乱数は引数で受ける）
- `src/ui/` に取り・ダメージなどのルール計算を書かない（予測・警告もエンジンの `previewMove` / `threatenedPieces`、オセロの合法手の参考表示は `board.ts` の `othelloCells` を使う）
- 隠し王の真の場所（`GameState.kings`）は隠し情報。`src/ui/` と `engine/cpu.ts` からは直接読まず、CPU は `viewFor(state, 自分)`、UI は `kingInfo(state, 見せてよい人)` を使う（`test/king.test.ts` がソースを検査する）
- URL クエリは外部入力。`ui/query.ts` の `decodeRules` で型・範囲を検証し、不正な項目は基準の値に戻す。クエリは v1.0 を基準にした差分（`QUERY_BASE`。固定で変えない）で、方向駒・端の駒の力の項目は基準と違うときだけ載せる（既存プリセット・共有済みの URL の意味を変えない・古い URL は全方向・上乗せなしとして読む）。ルールのキーがないときだけ画面の既定（`DEFAULT_PRESET` = 標準）
- 盤上の駒は種類だけを持ち、数字は `RuleSet.values[kind]`、方向は `PIECES[kind].reach`（種類で固定）。数字を `PIECES[kind].value`（既定値）から直接読まない
- ダメージは `board.ts` の `damageOf`（返した駒の `baseDamageOf` ＋ 端の駒の `anchorBonusOf`）に集約する。予測・警告・CPU はこれを通すので、ダメージの計算を別に書かない
- 動的な文字列は `textContent` / `ui/dom.ts` の `h()` で入れる。`innerHTML` は使わない
- 演出の段階は `ui/impact.ts` の `tierOf`（閾値は `TIER_THRESHOLDS` の 1 か所。合計 ÷ 受けた側の `RuleSet.hp`、王を返した手は特大）。成績は `statsOf` で棋譜から集計する。演出は transform / opacity と画面固定の `#fx` 層だけで、レイアウトを動かさない。大・特大の演出中は `App.fxLock` で入力と CPU を待たせる（`fx.ts` の `fxTiming`、最大 1.5 秒）
- 終局の流れは「最後の一手の演出 → 決着の演出（`App.playFinale`、`fx.ts` の `finaleMs`、最大 2.5 秒・タップ／クリック／Enter で飛ばす）→ 終局画面」。勝ち・負け・引き分け・副題・接戦の励まし（`CLOSE_PERCENT`）は `ui/outcome.ts` の `outcomeOf`。2 人対戦は敗北にしない
- オンライン対戦の画面は手を送るだけで、盤はサーバーから届いた `view`（`PlayerView`）で描く（画面で `playMove` しない）。王の情報は `App.kingOf`（オンラインでは `view.myKing` / `view.oppKing`。`kingInfo` は view に使えない）。トークンは `sessionStorage`（`kyosho:token:<roomId>`）。通信層は `net/online.ts` に分け、DOM を入れない
- サーバーは engine をコピーせず `../web/src/engine` を import する。各プレイヤーには `viewFor(state, そのプレイヤー)` だけを送り、`GameState`（`kings` を含む）をそのまま送らない（`server/test/king.test.ts` が検査する）。通信の型を変えたら `web/src/net/protocol.ts` と `.agent/online-protocol.md` を揃える
- API と WebSocket は画面と同じオリジンの `/api` の下（`protocol.ts` の `API_PATH`。変えたら `server/wrangler.jsonc` の `assets.run_worker_first` も）。画面はサーバーの URL を持たず絶対パスで呼ぶ。サーバーは同一オリジン（＋ `ALLOWED_ORIGINS`、本番は `https://kyosho.rukiharukichi.com`）だけを受け、CORS のヘッダーは返さない。静的アセットへのリクエストで Worker・Durable Object を起こさない
- `src/ui/` で `Math.random` を使わない（CPU の乱数と共有で、e2e は Math.random を種付きにして CPU の手を再現する）。CPU 対戦の手番の抽選（「ランダム」）は `ui/setup.ts` の `drawSeat`（既定は `crypto.getRandomValues`。e2e `seat.spec.ts` は crypto を差し替える）で、`App.start` が対局を始めるたびに引く（`PlaySettings.randomSeat`）。効果音の AudioContext は最初のユーザー操作の後にだけ作る

## コマンド

| 用途 | コマンド |
|---|---|
| dev | `cd web && npm run dev` |
| build | `cd web && npm run build`（`tsc --noEmit` 込み、`base: "./"`） |
| typecheck | `cd web && npm run typecheck` |
| test | `cd web && npm test` |
| e2e | `cd web && npm run e2e`（ビルド → `vite preview :4179` を自動起動。`/api` なし） |
| オンライン対戦の e2e | `cd web && npm run e2e:online`（ビルド → `wrangler dev :8790`（server/ の依存が要る）を自動起動し、2 つのブラウザコンテキストで対局。desktop / mobile） |
| バランス確認 | `cd web && npm run balance -- 400 king`（2 手読み同士。方向駒は `400 dir`、拠点は `400 anchor`、標準は `400 std`。第 3 引数で体力 "先手,後手"） |
| 棋譜の再生成 | `python3 sim/export_replays.py`（v0.4 / v1.0 / v2 案、約 30 秒） |
| 公開 | main への merge で自動デプロイ → https://harukiti82.github.io/kyosho/ （GitHub Pages、移行が済むまで残す）と Cloudflare https://kyosho.rukiharukichi.com/ （`deploy.yml`、Secret 登録後。手順は README「独自ドメイン（kyosho.rukiharukichi.com）」。ルートの rukiharukichi.com は使わない）。workflow は main 直 push せず PR 経由で変更 |
| シミュレーター | `RULES.md` のシミュレーター節を参照 |
| サーバー | `cd server && npm run dev`（web をビルドして :8787 で画面と `/api`。画面を直しながらなら併せて `cd web && npm run dev` の :5173 が `/api` をプロキシ）/ `npm run typecheck` / `npm test` / `node scripts/play.mjs http://localhost:8787`（2 クライアントで 1 局。第 2 引数でプリセット、既定は std）。`npm run deploy:check`（dry-run）/ `npm run deploy`（web のビルド → wrangler deploy。Cloudflare へのログインが必要） |

## ルール・設定項目を変えるとき

- 既定を変える: `web/src/engine/rules.ts` の `DEFAULT_PRESET` だけ（`ui/query.ts` の `QUERY_BASE` は変えない。変えると共有済みの URL の意味が変わる）
- プリセットの値を変える: `web/src/engine/rules.ts` の `PRESETS` と `RULES.md` の「Web 試遊版」節。v0.4 / v1.0 / v2 案は対応するシミュレーターの `Rules`（`sim/export_replays.py` が渡す値）も揃える
- 設定項目を足す: `RuleSet`（`engine/rules.ts`）→ エンジン（`board.ts` / `game.ts` / `cpu.ts`）→ `ui/query.ts`（URL の検証）→ `ui/ruletext.ts`（ルールカード・詳細の文）→ `index.html` の設定フォームと `ui/setup.ts`
- シミュレーターのルールを変えたら `python3 sim/export_replays.py` で棋譜を作り直し、`npm test` で Python と TS の一致を確認
- 対局画面のルールカード・ルール詳細は設定から自動生成する（`index.html` に固定の文は書かない）

## AI 向け詳細仕様

- ルール: `RULES.md`（必要時に Read）
- オンライン対戦の通信仕様と設計（エンドポイント・メッセージ・流れ・エラー・再接続）: `.agent/online-protocol.md`（必要時に Read）
- エンジンの公開関数: `web/src/engine/game.ts`（`createGame(rules)` / `playMove(state, r, c, kind, { king })` / `legalCells` / `playableKinds` / `previewMove`（`base` / `anchors` で内訳） / `threatenedPieces` / `canMove` / `judge` / 隠し王の `kingInfo` / `kingCandidates` / `viewFor`）と `cpu.ts`（`chooseLookahead(viewFor(state, turn))`）。返せる列は `board.ts` の `rawLines`（8 方向。反対端の自駒 `end` / `endAt` を持つ）→ `pieceLines`（駒の方向 `dirs` と強さ制限で絞る）。設定の型とプリセットは `rules.ts`（`RuleSet`（`dirs` / `values` / `anchor` を含む） / `PRESETS` / `NO_KING` / `KIND_ORDER` / `kindsByValue`）

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
