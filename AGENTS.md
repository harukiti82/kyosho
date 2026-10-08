# 挟将 — エージェント向けガイド

オセロの盤で、挟んだ相手の駒の数字がダメージになる二人対戦ゲーム。ルール設計（`RULES.md`）、Python のバランス検証（`sim/`）、ルールを組み合わせて遊び比べるブラウザの試遊版（`web/`）、オンライン対戦のサーバー（`server/`）からなる。

> ルールの正は `RULES.md`（v1.0「取った駒が持ち駒になる」）。解釈が曖昧なときは `sim/capture.py` の実装を正とする。
> Web 試遊版の設定項目とプリセット（隠し王・方向駒・拠点・既定の「標準」を含む）は `RULES.md` の「Web 試遊版」節。プリセット v0.4 / v1.0 / v2 案は `sim/kyosho.py` / `sim/capture.py` / `sim/gate.py` と全手一致させる。
> 旧ルール v0.4 は `docs/RULES-v0.4.md` と `sim/kyosho.py` に履歴として残す（変更しない）。
> ユーザー向けの説明は README.md にある。

## 概要

- 目的: ルールを詰め、人間の試遊で面白さを確かめる
- 対象: 作者と試遊する人（ブラウザ版は起動時のメニューから CPU 対戦（強さ 3 段階）・マルチ（同じ端末での 2 人対戦・招待リンクでのオンライン対戦）・遊び方（盤で打ちながら標準ルールを覚えるチュートリアル）。ルールは設定メニューで組み合わせて保存し、変えなければ標準）
- 状況: v0.4 は「難しい」「普通のオセロと変わらない」、v1.0 は「オセロじゃなくてもよくなって悪化」。読み合いを足すため「隠し王」（相手に見えない王）、戦略性を足すため「方向駒」（駒ごとに挟める方向が違う）、駒を置くリスクとリターンを足すため「端の駒の力」（挟んだ端の自分の駒の数字もダメージに足す。プリセット「拠点」）を設定項目とプリセットに追加した。ユーザーが遊び比べて選んだ組み合わせ（方向駒＋端の駒の力＋隠し王−30）をプリセット「標準」として既定にした。その後ユーザーの指定で王の指定期限を 7 手・回復を低い方−1 にし、体力は 2 手読み同士で先手勝率が 50% に最も近い 129・130 にした（経緯は RULES.md「Web 試遊版」節）（RULES.md 本文の改稿はまだ。ルールの決定はユーザーがする）
- 手応え: 手番が抽選のときは対局の始めに盤の石を投げる演出、大ダメージほど段階的に派手な演出・効果音、終局画面の前に勝ち・負け・引き分けの決着の演出、終局画面に成績（ルール上のボーナスではない。`ui/impact.ts` / `ui/outcome.ts` / `ui/fx.ts` / `ui/sound.ts`）
- 最重要要件: **ルールが一目で分かること**。ルールはいつでも 1 タップで見られる（設定から生成するルールカードは引き出しの「ルール 名前」のタブ。見出しは常に表示、PC は開いて始め、スマホは閉じて始める）。盤では返せる駒とダメージ・回復の予測（マスのバッジと吹き出し）・返されうる駒の警告・普通のオセロなら置けるマスの点線の枠（参考）・方向駒のアイコン・端の駒の青枠とダメージの内訳で示す
- 見た目: ペルソナ3風（ユーザーの選択。ユーザーの個人サイト rukiharukichi.com の見た目に揃える）。説明の文を常に出さず、形と動きで伝える（下の「デザイン規約」）

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
    ├── src/ui/       ← 画面の表示と入力（app.ts: 対局画面（CPU・2 人・オンライン）と画面の切り替え / menu.ts: 起動時のメニュー / setup.ts: 設定メニュー（保存は localStorage） / online.ts: オンライン対戦の案内のダイアログ / query.ts: URL ⇔ 設定 / ruletext.ts: ルール文 / diricon.ts: 方向のアイコン / impact.ts: ダメージの段階と成績（DOM なし） / lessons.ts: 遊び方のステップ（局面・正解・誘導・ヒント・進み具合。DOM なし） / coach.ts: 遊び方のコーチ（覚えるルール・課題・ヒント・次へ） / outcome.ts: 決着の演出の中身（DOM なし） / clock.ts: 1 手の制限時間の時計と既定（DOM なし） / fx.ts: 抽選・段階・決着の演出 / sound.ts: 効果音）
    ├── src/net/      ← オンライン対戦（protocol.ts: 通信仕様の型と定数。画面とサーバーが共通で import する / online.ts: 画面の通信層（HTTP・WebSocket・トークン・つなぎ直し。DOM なし））
    ├── test/         ← Vitest（engine・URL・ルール文のユニットテスト + Python 棋譜の再生テスト）
    ├── e2e/          ← Playwright（ヘッドレスで実際に終局まで打つ。king.spec.ts / direction.spec.ts / anchor.spec.ts は種付き乱数の鏡の対局で隠し王・方向駒・拠点を確かめる。impact.spec.ts は段階の演出・効果音・成績、result.spec.ts は決着の演出、seat.spec.ts は CPU 対戦の手番の抽選、othello.spec.ts は普通のオセロなら置けるマスの枠、timer.spec.ts は 1 手の制限時間（page.clock で時間を進める）、online-hidden.spec.ts は /api がない公開先で入口を出さないこと、menu.spec.ts はメニューからの開始・CPU の強さ・設定の保存と反映、toss.spec.ts は手番の抽選の演出（page.clock で止める・CSS の動きは途中で止めて撮る）、tutorial.spec.ts は遊び方の全ステップ（違う手のヒント・正解）と実戦・再開・localStorage なし・CPU と時計が割り込まないこと。e2e/online/ はサーバーを起こして 2 つのブラウザで対局する（`npm run e2e:online`））
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
- 手番の抽選の演出は `App.playToss`（`fx.ts` の `toss` / `tossMs` 最大 1.9 秒・`sound.ts` の `toss`）: 盤の石を投げ、上を向いた色が自分の手番（表の黒 = 先手・裏の白 = 後手、`tossAngle`）。出すのは CPU 対戦の「ランダム」（`App.start` の `drawSeat` の後。再戦・新しい対局でも）と、オンラインで `state.seatDraw` の部屋の 1 局目の始め（`App.claimToss`。結果はサーバーの `you`）だけ。手番を選んだとき・2 人対戦・遊び方・オンラインの再戦では出さない。演出中は `fxLock` で盤・CPU・時計を止め、`App.endToss`（時間・タップ／クリック／Enter・メニューへ）で動かす。動きを減らす設定では回さない。e2e は `helpers.ts` の `skipToss` で確かめて飛ばす
- 終局の流れは「最後の一手の演出 → 決着の演出（`App.playFinale`、`fx.ts` の `finaleMs`、最大 2.5 秒・タップ／クリック／Enter で飛ばす）→ 終局画面」。勝ち・負け・引き分け・副題・接戦の励まし（`CLOSE_PERCENT`）は `ui/outcome.ts` の `outcomeOf`。2 人対戦は敗北にしない
- オンライン対戦の終局後の再戦は同じ部屋で: `rematch` の申し込み（`request`。相手が申し込み済みなら成立）・`cancel`・`decline` をサーバー（`room.ts` の `rematch` / `nextGame`）が受け、成立したら席のトークンと接続の席を入れ替えて（先手と後手を交代）同じルール・同じ制限時間の新しい `GameState` を作る。前の対局の `GameState`（王を含む）は捨てる（`server/test/king.test.ts` が検査する）。画面は `state.gameNo` が増えたら `App.startNextGame`、ボタンは `rematchControls`（`data-rematch`）。部屋を抜けるときは `leave` を送る（`OnlineSession.close`）。通算の戦績は席でなく人（作成者・参加者）ごとに数え（`room.ts` の `tallyOf` / `recordFor`、`host` で席を人に直す）、`state.record` で各自の目線で送る。画面は終局画面の成績表の「通算」と、2 局目からの名札（`.plate-record`）
- オンライン対戦の画面は手を送るだけで、盤はサーバーから届いた `view`（`PlayerView`）で描く（画面で `playMove` しない）。王の情報は `App.kingOf`（オンラインでは `view.myKing` / `view.oppKing`。`kingInfo` は view に使えない）。トークンは `sessionStorage`（`kyosho:token:<roomId>`）。通信層は `net/online.ts` に分け、DOM を入れない
- サーバーは engine をコピーせず `../web/src/engine` を import する。各プレイヤーには `viewFor(state, そのプレイヤー)` だけを送り、`GameState`（`kings` を含む）をそのまま送らない（`server/test/king.test.ts` が検査する）。通信の型を変えたら `web/src/net/protocol.ts` と `.agent/online-protocol.md` を揃える
- API と WebSocket は画面と同じオリジンの `/api` の下（`protocol.ts` の `API_PATH`。変えたら `server/wrangler.jsonc` の `assets.run_worker_first` も）。画面はサーバーの URL を持たず絶対パスで呼ぶ。サーバーは同一オリジン（＋ `ALLOWED_ORIGINS`、本番は `https://kyosho.rukiharukichi.com`）だけを受け、CORS のヘッダーは返さない。静的アセットへのリクエストで Worker・Durable Object を起こさない
- 画面の流れは「メニュー（`ui/menu.ts`）→ 対局」。対局前に設定メニューを挟まない。ルールの優先は URL のクエリ（共有された URL。保存は書き換えない）＞ 設定メニューで保存した設定（localStorage `kyosho:settings`。`ui/setup.ts` の `loadSaved` が検証し、読めなければ標準）＞ 既定（`DEFAULT_PRESET`）。招待リンク（`?room=`）はメニューを出さず部屋へ
- 1 手の制限時間はルール（`RuleSet`）に入れない（URL・`QUERY_BASE`・`PRESETS` に載せない）。対局の設定 `PlaySettings.turnSeconds`（秒、0 は制限なし）で、設定メニューの `Saved.timeCpu`（`auto` = 強さに合わせる `CPU_TURN_SECONDS`: イージー 0・ノーマル 45・ハード 20）・`timeMulti`（既定 45）から決める。選択肢は `net/protocol.ts` の `TURN_SECONDS`。時間切れの手は engine の `playTimeout(state, rng)`（置ける手から一様に 1 つ、棋譜の手に `timeout: true`、王はルールどおりの自動指定だけ）。画面の時計は `ui/clock.ts` の `TurnClock`（`Date.now` の差で数える）を `App.syncClock` が描き直しのたびに合わせ、操作できる手番だけ進める（演出 `fxLock`・決着の演出・メニュー・CPU の手番では止める）。乱数は `cryptoRandom`（`Math.random` は使わない）。オンラインはサーバー（`server/src/room.ts`）が締め切りの alarm で打ち、画面は `state.clock` を見せるだけ（`.agent/online-protocol.md`「1 手の制限時間」）。e2e は `page.clock` で時間を進め、オンラインは `TEST_TURN_SECONDS` の短い秒数を使う
- 遊び方（チュートリアル）のステップは `ui/lessons.ts` の `LESSONS`（DOM なし）。局面は engine の `gameFrom(rules, position)` で作り、ダメージ・回復・王の罰・予測はエンジンの `playMove` / `previewMove` の結果（棋譜の `MoveEvent`）を文にする（チュートリアル側で計算し直さない）。ステップのルールは標準から習っていない要素を外したもの、最後の実戦は標準・CPU イージー・制限時間なし。画面は `App.lesson`（`openLesson` / `inStep`）: ステップ中は CPU・制限時間・トーストを止め、違う手は打たずに `judgeMove` / `illegalHint` のヒントをコーチ（`ui/coach.ts`、`#coach`）に出し、正解なら `solved` で盤を止めて `done` の 1 文と「次へ」。誘導は盤の `.cell.guide`（`.guide-ring` / 1 マスなら `.guide-arrow`）と駒台・王の駒の `.guide`（`nextNeed`）。決着の演出は体力 0 の手だけで、終局画面は出さない。進み具合は localStorage `kyosho:tutorial`（`loadProgress` が検証し、読めなければ「はじめて」）。標準の値を変えたら `test/lesson.test.ts`（局面・文）と `e2e/tutorial.spec.ts` を確かめる
- CPU の強さは `engine/cpu.ts` の `chooseMove(view, level, rng)`（`CpuLevel` = easy / normal / hard。`PlaySettings.level`）。ノーマルは `chooseLookahead` と同じ手（sim と全手一致させる候補手・e2e の鏡の対局はこれを使う）。強さを変えたら `npm run balance -- vs 400 std normal hard` などで勝率を測り、`test/level.test.ts` の下限を確かめる
- `src/ui/` で `Math.random` を使わない（CPU の乱数と共有で、e2e は Math.random を種付きにして CPU の手を再現する。CPU に打たせる e2e は `e2e/helpers.ts` の `seedPage` で種を固定する。種がないと終局の形が実行ごとに変わり、ときどき落ちる）。CPU 対戦の手番の抽選（「ランダム」。設定の既定）は `ui/setup.ts` の `drawSeat`（既定は `crypto.getRandomValues`。e2e は `helpers.ts` の `stubDraws` で crypto を差し替える。`startGame` は CPU 対戦で side を省くと先手を選ぶ）で、`App.start` が対局を始めるたびに引く（`PlaySettings.randomSeat`）。効果音の AudioContext は最初のユーザー操作の後にだけ作る

## コマンド

| 用途 | コマンド |
|---|---|
| dev | `cd web && npm run dev` |
| build | `cd web && npm run build`（`tsc --noEmit` 込み、`base: "./"`） |
| typecheck | `cd web && npm run typecheck` |
| test | `cd web && npm test` |
| e2e | `cd web && npm run e2e`（ビルド → `vite preview :4179` を自動起動。`/api` なし。別の作業ツリーと並べるなら `E2E_PORT=4189`） |
| オンライン対戦の e2e | `cd web && npm run e2e:online`（ビルド → `wrangler dev :8790`（server/ の依存が要る。`E2E_ONLINE_PORT` で変更可。`--var TEST_TURN_SECONDS:3` 付き）を自動起動し、2 つのブラウザコンテキストで対局。desktop / mobile） |
| バランス確認 | `cd web && npm run balance -- 400 king`（2 手読み同士。方向駒は `400 dir`、拠点は `400 anchor`、標準は `400 std`。第 3 引数で体力 "先手,後手"）。CPU の強さ同士は `npm run balance -- vs 400 std easy normal`（先手・後手を 1 局ごとに入れ替え） |
| 棋譜の再生成 | `python3 sim/export_replays.py`（v0.4 / v1.0 / v2 案、約 30 秒） |
| 公開 | main への merge で自動デプロイ → https://harukiti82.github.io/kyosho/ （GitHub Pages、移行が済むまで残す）と Cloudflare https://kyosho.rukiharukichi.com/ （`deploy.yml`、Secret 登録後。手順は README「独自ドメイン（kyosho.rukiharukichi.com）」。ルートの rukiharukichi.com は使わない）。workflow は main 直 push せず PR 経由で変更 |
| シミュレーター | `RULES.md` のシミュレーター節を参照 |
| サーバー | `cd server && npm run dev`（web をビルドして :8787 で画面と `/api`。画面を直しながらなら併せて `cd web && npm run dev` の :5173 が `/api` をプロキシ）/ `npm run typecheck` / `npm test` / `node scripts/play.mjs http://localhost:8787`（2 クライアントで 1 局。第 2 引数でプリセット、既定は std）。`npm run deploy:check`（dry-run）/ `npm run deploy`（web のビルド → wrangler deploy。Cloudflare へのログインが必要） |

## ルール・設定項目を変えるとき

- 標準（`std`）の値を変える: `PRESETS` と RULES.md に加え、遊び方の局面・文（`ui/lessons.ts`。`npm test` の `test/lesson.test.ts` が確かめる）
- 既定を変える: `web/src/engine/rules.ts` の `DEFAULT_PRESET` だけ（`ui/query.ts` の `QUERY_BASE` は変えない。変えると共有済みの URL の意味が変わる）
- プリセットの値を変える: `web/src/engine/rules.ts` の `PRESETS` と `RULES.md` の「Web 試遊版」節。v0.4 / v1.0 / v2 案は対応するシミュレーターの `Rules`（`sim/export_replays.py` が渡す値）も揃える
- 設定項目を足す: `RuleSet`（`engine/rules.ts`）→ エンジン（`board.ts` / `game.ts` / `cpu.ts`）→ `ui/query.ts`（URL の検証）→ `ui/ruletext.ts`（ルールカード・詳細の文）→ `index.html` の設定フォームと `ui/setup.ts`
- シミュレーターのルールを変えたら `python3 sim/export_replays.py` で棋譜を作り直し、`npm test` で Python と TS の一致を確認
- 対局画面のルールカード・ルール詳細は設定から自動生成する（`index.html` に固定の文は書かない）

## AI 向け詳細仕様

- ルール: `RULES.md`（必要時に Read）
- オンライン対戦の通信仕様と設計（エンドポイント・メッセージ・流れ・エラー・再接続）: `.agent/online-protocol.md`（必要時に Read）
- エンジンの公開関数: `web/src/engine/game.ts`（`createGame(rules)` / 指定した局面から始める `gameFrom(rules, position)`（チュートリアル） / `playMove(state, r, c, kind, { king })` / 時間切れの `randomMove` / `playTimeout(state, rng)` / `legalCells` / `playableKinds` / `previewMove`（`base` / `anchors` で内訳） / `threatenedPieces` / `canMove` / `judge` / 隠し王の `kingInfo` / `kingCandidates` / `viewFor`）と `cpu.ts`（`chooseLookahead(viewFor(state, turn))`）。返せる列は `board.ts` の `rawLines`（8 方向。反対端の自駒 `end` / `endAt` を持つ）→ `pieceLines`（駒の方向 `dirs` と強さ制限で絞る）。設定の型とプリセットは `rules.ts`（`RuleSet`（`dirs` / `values` / `anchor` を含む） / `PRESETS` / `NO_KING` / `KIND_ORDER` / `kindsByValue`）

### 作業履歴メモ（毎ターン参照・更新）

- 現在の作業状況（毎ターン上書き）: @.agent/activeContext.md
- 完了タスクの時系列（毎ターン追記）: @.agent/progress.md

セッション開始時に必ず両方読み、応答終了前に `activeContext` は最新状態で**上書き**、
作業が一段落していれば `progress` の末尾に**1〜3 行で追記**する。
スキップ可能なターン（単発質問への回答、タイポ修正のみ）では更新しない。

## デザイン規約

ペルソナ3風（ユーザーが試作 4 案から選んだ。ユーザーの個人サイト rukiharukichi.com（`/Users/numataharu/repos/rukiharukichi.com`、P3R 風）の配色・斜め・見出しに揃える）。トークンは `web/src/style.css` の `:root` に集約。ATLUS／ペルソナのロゴ・キャラクター・画像・専用書体は使わない（ロゴは自作の SVG）。

- 考え方: 文ではなく形と動きで伝える。常に出る説明の文・ダッシュや括弧でつないだ案内文・ピル型のバッジ・同じ形の枠付きカードを縦に積む構成・半透明のガラス風パネル・パステルの配色は使わない。詳しい文は「?」（ルール詳細）・引き出しのタブ・title・読み上げ（`.sr-only`）に置き、情報は消さない
- 地: 深い青の水中。`:root` の `background`（html）に縦のグラデーション（`#1270DC` → `#0C4FD2` → `#0A2C9F`）・-7° に傾いた深い水の帯・下の端の水面のさざ波、`body::after` に上から差し込む光の筋。月は描かない（ユーザーの指定）。どれも内容の後ろで控えめに
- 面と文字: 紺 `--navy-950`〜`--navy-700`、面は `--surface`（紺）/ `--surface-2` / `--surface-3`、線は `--line`（シアンの半透明）。文字は `--ink` `#F2FAFF` / `--ink-muted` / `--ink-dim`
- 操作の色: 手番・決定はシアン `--go` `#2FD3FF`、選んだもの（駒・狙ったマス・フォーカス・選んだ札）は白（`--amber` は白）。選んだ・合わせた項目は白い斜めの板に紺の字へ反転し、決定のボタン・選んだメニューの項目・手番の名札は後ろに赤 `--red-500` の破片をずらして重ねる（赤はこの演出だけ）。盤の上の印の色は変えない: 返す駒は赤 `--danger`、回復は `--heal`、警告の「!」は `--warn`、王は金 `--gold`、端の駒は青い盤で沈まない水色 `--anchor`
- 斜め: 帯・鍵・札・名札・駒台・体力ゲージ・時計は -12° の平行四辺形（`--slant` / `--slant-sm` の clip-path。skew で横幅を広げない＝スマホで横スクロールを出さない）、見出し・ロゴ・メニューの並びは -7° に傾ける（`--tilt`）。角は丸めない（`--radius: 0`）
- 見出し: 太い斜体の白（`--font-display`）に紺の硬い影を 1 枚（0.05em ずらす）。ダイアログの見出しは右へ伸びる罫線（先頭 2rem だけ白、残りはシアン）。小見出し・読みは白やシアンの斜めの帯に紺の字（`.label`・`.title-sub`・`.logo-kicker`）
- 盤: 角を斜めに落とした紺の枠（`.board-frame::before`。枠そのものを clip-path で切ると盤の外に出る吹き出しまで切れる）に座標（a〜h・1〜8、シアンの斜体）、マスは深い水の色（`--cell`）、石は立体の黒白。枠の下の縁に手番・手数・接続。手番の側の縁に線（操作できる手番は白、待つ手番はシアン）。直前の手はマスを明るい青に染め、ほかの印は枠・角のバッジにして重ねても見分ける。盤（`.board-frame`、`z-index: 2`）は名札・駒台（`isolation` で重ねた斜めの帯）より上に置き、盤の外に出る吹き出しを隠させない
- 書体: システムフォントのみ（CDN なし）。見出し・名前・鍵・数字は `--font-display`（細身の英字の書体の太い斜体。和文は斜めにしたゴシック）、駒の漢字は明朝（`--font-piece`）、ほかはゴシック
- 部品: 名札（紺の斜めの帯。手番の人は白に反転して赤い破片。石・短い名前・王の駒の形とマス名・斜めに切った体力ゲージ）、時計（紺の斜めの札にシアンの数字）、駒台（紺の斜めの帯に石、残り数は白い角、選んだ駒は持ち上がって白い縁）、吹き出し（紺の小窓に狙ったマスの内訳・警告）、引き出し（今いるタブはシアンの斜めの板）、メニュー（大きな斜体の項目を段々に右へずらし、選んだ・合わせた項目を白い板に反転。タッチ端末では最初の項目が選ばれた状態）、ロゴ（時計の文字盤と水面の自作 SVG・読みの帯・名前）、抽選の演出（石の着地は白とシアンの輪、結果は太い斜体）
- 文言（市販の対局アプリに並べて違和感がないか、で判断する）: ボタン・見出し・トーストは体言止めか命令形の短い語（「再試行」「参加しない」「CPU 思考中…」「抽選で後手になりました」）。説明は 1 文まで。括弧・ダッシュの補足、感嘆符、絵文字は使わない（例外は着手の演出の掛け声 `TIER_TEXT`）。「あなた」は名札・勝敗・王の指定など誰のことか要る所だけ。補足は title・読み上げ・「?」に移し、ルール文の行末の補足は `ruletext.ts` の `{ note }`（薄い字の `.rule-note`）。見出しと名前は記号でつながず字の太さで分ける（`.tab-sub`、例「ルール 標準」「標準のルール」）。先手・後手の色は文字でなく石で示す（`.seg-stone` / 名札・成績表の石）
- 配置: 同じ形・同じ大きさの鍵や札を縦に積まない。主な選択を大きく、ほかを小さく（メニューは `.menu-big` を大きく `.menu-small` を小さくして段々に右へずらす、強さは菱 `.lv-stars`、設定のプリセットは標準を大きな札 `.preset-main`）。設定は「左に名前・右に選択」の行を細い線で区切る（`.set-row`）。遊び方のコーチは覚えるルールの 1 文（`lead`）と白の三角の付いた課題（`task`）

## コミット規約

グローバル CLAUDE.md（`~/.claude/CLAUDE.md`）の「Git コミット」節に従う。
