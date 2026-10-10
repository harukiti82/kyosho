# 挟将 — エージェント向けガイド

オセロの盤で、挟んだ相手の駒の数字がダメージになる二人対戦ゲーム。ルール設計（`RULES.md`）、Python のバランス検証（`sim/`）、ルールを組み合わせて遊び比べるブラウザの試遊版（`web/`）、オンライン対戦のサーバー（`server/`）からなる。

> ルールの正は `RULES.md`（v1.0「取った駒が持ち駒になる」）。解釈が曖昧なときは `sim/capture.py` の実装を正とする。
> Web 試遊版の設定項目とプリセット（隠し王・方向駒・拠点・既定の「標準」を含む）は `RULES.md` の「Web 試遊版」節。プリセット v0.4 / v1.0 / v2 案は `sim/kyosho.py` / `sim/capture.py` / `sim/gate.py` と全手一致させる。
> 旧ルール v0.4 は `docs/RULES-v0.4.md` と `sim/kyosho.py` に履歴として残す（変更しない）。
> ユーザー向けの説明は README.md にある。

## 概要

- 目的: ルールを詰め、人間の試遊で面白さを確かめる
- 対象: 作者と試遊する人（ブラウザ版は起動時のメニューから CPU 対戦（強さ 3 段階）・マルチ（同じ端末での 2 人対戦・招待リンクでのオンライン対戦）・遊び方（盤で打ちながら標準ルールを覚えるチュートリアル）。ルールは設定メニューで組み合わせて保存し、変えなければ標準）
- 状況: v0.4 は「難しい」「普通のオセロと変わらない」、v1.0 は「オセロじゃなくてもよくなって悪化」。読み合いを足すため「隠し王」（相手に見えない王）、戦略性を足すため「方向駒」（駒ごとに挟める方向が違う）、駒を置くリスクとリターンを足すため「端の駒の力」（挟んだ端の自分の駒の数字もダメージに足す。プリセット「拠点」）を設定項目とプリセットに追加した。ユーザーが遊び比べて選んだ組み合わせ（方向駒＋端の駒の力＋隠し王−30）をプリセット「標準」として既定にした。ユーザーの案で、返した枚数でゲージが溜まる「スキル」（タロットカード風の 8 枚。対局の前に 3 枚から 1 枚を選ぶ）を標準＋スキルのプリセット「スキルあり」として足した（値はリポジトリ外のシミュレーター kyosho-skillsim で決めた。RULES.md「スキル」）。その後ユーザーの指定で王の指定期限を 7 手・回復を低い方−1 にし、体力は 2 手読み同士で先手勝率が 50% に最も近い 129・130 にした（経緯は RULES.md「Web 試遊版」節）（RULES.md 本文の改稿はまだ。ルールの決定はユーザーがする）
- 手応え: 手番が抽選のときは対局の始めに盤の石を投げる演出、大ダメージほど段階的に派手な演出・効果音、終局画面の前に勝ち・負け・引き分けの決着の演出、終局画面に成績（ルール上のボーナスではない。`ui/impact.ts` / `ui/outcome.ts` / `ui/fx.ts` / `ui/sound.ts`）
- 最重要要件: **ルールが一目で分かること**。ルールはいつでも 1 タップで見られる（設定から生成するルールカードは引き出しの「ルール 名前」のタブ。見出しは常に表示、PC は開いて始め、スマホは閉じて始める）。盤では返せる駒とダメージ・回復の予測（マスのバッジと吹き出し）・返されうる駒の警告（表示を切り替えられる。既定はオフ）・普通のオセロなら置けるマスの点線の枠（参考）・方向駒のアイコン・端の駒の青枠とダメージの内訳で示す
- 見た目: 青い地と斜めの勢いはユーザーの個人サイト rukiharukichi.com に揃えつつ、挟む石・盤の格子などゲーム独自のモチーフにした（ユーザーが試作 3 案から選んだ G 案）。説明の文を常に出さず、形と動きで伝える（下の「デザイン規約」）

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
    ├── src/engine/   ← ルールエンジン（DOM に依存しない。RuleSet で全組み合わせを扱う。ここだけでゲームが完結する。skills.ts: スキルの定義とゲージ・ダメージの計算 / skillcpu.ts: CPU のスキルの使い方とスキル込みの 2 手読み）
    ├── src/ui/       ← 画面の表示と入力（app.ts: 対局画面（CPU・2 人・オンライン）と画面の切り替え / menu.ts: 起動時のメニュー / setup.ts: 設定メニュー（保存は localStorage） / online.ts: オンライン対戦の案内のダイアログ / query.ts: URL ⇔ 設定 / ruletext.ts: ルール文 / diricon.ts: 方向のアイコン / impact.ts: ダメージの段階と成績（DOM なし） / lessons.ts: 遊び方のステップ（局面・正解・誘導・ヒント・進み具合。DOM なし） / skillui.ts: スキルのカードの面・絵柄・3 枚から選ぶダイアログ（SkillPick） / gauge.ts: スキルのゲージが溜まる演出の中身（増えた量・「+N」・溜めマスの光の出どころ。DOM なし） / coach.ts: 遊び方のコーチ（覚えるルール・課題・ヒント・次へ） / outcome.ts: 決着の演出の中身（DOM なし） / undo.ts: 待った（DOM なし） / record.ts: CPU 対戦・2 人対戦の通算（localStorage。DOM なし） / clock.ts: 1 手の制限時間の時計と既定（DOM なし） / fx.ts: 抽選・段階・決着の演出 / sound.ts: 効果音）
    ├── src/net/      ← オンライン対戦（protocol.ts: 通信仕様の型と定数。画面とサーバーが共通で import する / online.ts: 画面の通信層（HTTP・WebSocket・トークン・つなぎ直し。DOM なし））
    ├── test/         ← Vitest（engine・URL・ルール文のユニットテスト + Python 棋譜の再生テスト）
    ├── e2e/          ← Playwright（ヘッドレスで実際に終局まで打つ。king.spec.ts / direction.spec.ts / anchor.spec.ts は種付き乱数の鏡の対局で隠し王・方向駒・拠点を確かめる。impact.spec.ts は段階の演出・効果音・成績、result.spec.ts は決着の演出、seat.spec.ts は CPU 対戦の手番の抽選、othello.spec.ts は普通のオセロなら置けるマスの枠、timer.spec.ts は 1 手の制限時間（page.clock で時間を進める）、online-hidden.spec.ts は /api がない公開先で入口を出さないこと、menu.spec.ts はメニューからの開始・CPU の強さ・設定の保存と反映、toss.spec.ts は手番の抽選の演出（page.clock で止める・CSS の動きは途中で止めて撮る）、tutorial.spec.ts は遊び方の全ステップ（違う手のヒント・正解）と実戦・再開・localStorage なし・CPU と時計が割り込まないこと、undo.spec.ts は待った（鏡の対局・CPU が先手・王の指定・制限時間・終局後）、skill.spec.ts はスキル（カードの選択・2 人対戦の順・8 枚それぞれを満タンまで溜めて使う。crypto の差し替えで配るカードを決め、page.clock で進める）、skill-gauge.spec.ts はゲージが溜まる演出（「+N」・溜めマスの光・満タン・動きを減らす設定・待った・決着の一手。MutationObserver で出た要素を記録）、threat.spec.ts は「!」の表示の切り替え（既定オフ・保存・対局中・古い保存・遊び方のステップは常にオン・遊び方の実戦は保存した設定）。emphasis.spec.ts は説明文の要点が補足より大きいこと（遊び方・ルールカード・ルール詳細・設定）。record.spec.ts は CPU 対戦・2 人対戦の通算（2 局目から・強さごと・途中でやめた対局・再読み込み・待った・引き分け・「通算を消す」・壊れた保存・localStorage なし）。e2e/online/ はサーバーを起こして 2 つのブラウザで対局する（`npm run e2e:online`。online/skill.spec.ts はスキルの選択・使用・再戦の配り直しと、偵察・王の移し替えの隠し情報））
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
- CPU 対戦と同じ端末の 2 人対戦の通算は `ui/record.ts`（DOM なし）の `RecordBook` で localStorage `kyosho:record` に数える（CPU 対戦は強さごとに人間から見た、2 人対戦は先手から見た `MatchRecord`。`readRecord` が検証し、崩れた項目は 0、読めない・壊れているときは 0 から数えて画面の間はメモリで覚える）。`App.afterChange` が決着した局面で `countResult`（`recordKey` が null のオンライン対戦・遊び方（実戦も）は数えない。`countedGame` で 1 局 1 回。待ったを使った対局も数える）。表示はオンラインと同じ `recordOf` / `plateRecord`（成績表の「通算」と `.plate-record`）で、その強さ・2 人対戦でこの対局より前に 1 局以上終えた 2 局目から。ルールが違っても分けない。設定メニューの「記録」の行（`#record-sum`・`#record-clear` → 画面内の確認 `#record-confirm`）で一覧と「通算を消す」（`confirm()` は使わない。保存を待たずすぐ消す）
- オンライン対戦の画面は手を送るだけで、盤はサーバーから届いた `view`（`PlayerView`）で描く（画面で `playMove` しない）。王の情報は `App.kingOf`（オンラインでは `view.myKing` / `view.oppKing`。`kingInfo` は view に使えない）。トークンは `sessionStorage`（`kyosho:token:<roomId>`）。通信層は `net/online.ts` に分け、DOM を入れない
- サーバーは engine をコピーせず `../web/src/engine` を import する。各プレイヤーには `viewFor(state, そのプレイヤー)` だけを送り、`GameState`（`kings` を含む）をそのまま送らない（`server/test/king.test.ts` が検査する）。通信の型を変えたら `web/src/net/protocol.ts` と `.agent/online-protocol.md` を揃える
- API と WebSocket は画面と同じオリジンの `/api` の下（`protocol.ts` の `API_PATH`。変えたら `server/wrangler.jsonc` の `assets.run_worker_first` も）。画面はサーバーの URL を持たず絶対パスで呼ぶ。サーバーは同一オリジン（＋ `ALLOWED_ORIGINS`、本番は `https://kyosho.rukiharukichi.com`）だけを受け、CORS のヘッダーは返さない。静的アセットへのリクエストで Worker・Durable Object を起こさない
- 画面の流れは「メニュー（`ui/menu.ts`）→ 対局」。対局前に設定メニューを挟まない。ルールの優先は URL のクエリ（共有された URL。保存は書き換えない）＞ 設定メニューで保存した設定（localStorage `kyosho:settings`。`ui/setup.ts` の `loadSaved` が検証し、読めなければ標準）＞ 既定（`DEFAULT_PRESET`）。招待リンク（`?room=`）はメニューを出さず部屋へ
- 1 手の制限時間はルール（`RuleSet`）に入れない（URL・`QUERY_BASE`・`PRESETS` に載せない）。対局の設定 `PlaySettings.turnSeconds`（秒、0 は制限なし）で、設定メニューの `Saved.timeCpu`（`auto` = 強さに合わせる `CPU_TURN_SECONDS`: イージー 0・ノーマル 45・ハード 20）・`timeMulti`（既定 45）から決める。選択肢は `net/protocol.ts` の `TURN_SECONDS`。時間切れの手は engine の `playTimeout(state, rng)`（置ける手から一様に 1 つ、棋譜の手に `timeout: true`、王はルールどおりの自動指定だけ）。画面の時計は `ui/clock.ts` の `TurnClock`（`Date.now` の差で数える）を `App.syncClock` が描き直しのたびに合わせ、操作できる手番だけ進める（演出 `fxLock`・決着の演出・メニュー・CPU の手番では止める）。乱数は `cryptoRandom`（`Math.random` は使わない）。オンラインはサーバー（`server/src/room.ts`）が締め切りの alarm で打ち、画面は `state.clock` を見せるだけ（`.agent/online-protocol.md`「1 手の制限時間」）。e2e は `page.clock` で時間を進め、オンラインは `TEST_TURN_SECONDS` の短い秒数を使う
- 遊び方（チュートリアル）のステップは `ui/lessons.ts` の `LESSONS`（DOM なし）。局面は engine の `gameFrom(rules, position)` で作り、ダメージ・回復・王の罰・予測はエンジンの `playMove` / `previewMove` の結果（棋譜の `MoveEvent`）を文にする（チュートリアル側で計算し直さない）。ステップのルールは標準から習っていない要素を外したもの、最後の実戦は標準・CPU イージー・制限時間なし。画面は `App.lesson`（`openLesson` / `inStep`）: ステップ中は CPU・制限時間・トーストを止め、違う手は打たずに `judgeMove` / `illegalHint` のヒントをコーチ（`ui/coach.ts`、`#coach`）に出し、正解なら `solved` で盤を止めて `done` の 1 文と「次へ」。誘導は盤の `.cell.guide`（`.guide-ring` / 1 マスなら `.guide-arrow`）と駒台・王の駒の `.guide`（`nextNeed`）。決着の演出は体力 0 の手だけで、終局画面は出さない。進み具合は localStorage `kyosho:tutorial`（`loadProgress` が検証し、読めなければ「はじめて」）。標準の値を変えたら `test/lesson.test.ts`（局面・文）と `e2e/tutorial.spec.ts` を確かめる
- 取られる駒の警告「!」（盤の「!」・自分の王の赤い「!」・吹き出しと予測の文の返されうる警告・凡例の「!」）はルールでなく表示の設定。`App.threatOn` で、対局を始めるたびに保存した設定（`Saved.threat`、既定はオフ。項目のない古い保存もオフ）か `PlaySettings.threat` に戻す（`App.initThreat`）。対局中は引き出しのタブの列の右端の `#btn-threat` でその対局の間だけ切り替え、保存は書き換えない（`App.setThreat`）。遊び方のステップは常にオン（「予測を読む」で使う。鍵は出さない）。遊び方の最後の実戦はふつうの対局と同じく保存した設定で、鍵も出す。URL・`QUERY_BASE`・`PRESETS` に載せない。オンラインは各自の画面だけで、サーバーは関わらない。ダメージ・回復の予測と端の駒の枠はオフでも出す。「!」を確かめる e2e は `startGame(page, { threat: true })`
- スキル（`RuleSet.skills`）の状態は `GameState.skills`（スキルなしのルールではキー自体がない＝既存の対局・棋譜は変わらない）: 各自の配られたカード `offer`・選んだカード `card`・ゲージ `gauge`（`GAUGE_UNIT` = 1/20 点の整数）、両者が選んだ `ready`、手番中に使ったスキル `armed`（公開情報。置いた手の `MoveEvent.skill` に移る）、相手の鉄壁 `shielded`。流れは `dealSkills`（乱数は引数。画面は `cryptoRandom`、サーバーは crypto）→ `pickSkill` → 手番の頭に `useSkill`（回復・補充・鉄壁・偵察・王の移し替えはすぐ効き、強打・全方向・偵察の罰はその手番の `playMove` で効く）→ `playMove` がゲージを足す。選び終えるまで `playMove` は例外。使えるかは `skillBlock(view)`（PlayerView でも GameState の viewFor でも）。隠し情報（偵察で分かった王 = `kings[相手].seen`、王の移し替えの先 = `kings[自分].cell`）は `kings` の中だけに持ち、`viewFor` が本人にだけ見せる（偵察した人の `oppKing` は `scouted: true` と 1 マスの候補）。相手の配られたカードは見せず、相手の選んだカードは両者が選ぶまで null。全方向の手番の合法手は `moveRules(state)`、強打・鉄壁のダメージは `skillDamage`（`previewMove` の `plain` / `mods`、棋譜の `plain` / `shielded`）。画面は名札のカード（`App.skillChip`、押せるときは `#skill-use`）・`App.applySkill` / `playSkillCast`（`fx.ts` の `skillCast`、`skillCastMs` の間 `fxLock`）・補充と王の移し替えの指定（`App.aim`）・カードを選ぶダイアログ（`App.syncPick`）。ゲージが溜まる演出は `ui/gauge.ts`（DOM なし）の `gaugeGains`: 名札に最後に描いたゲージ（`App.gaugeSnap`、`renderPlayers` で取る）と、ちょうど 1 手（`ply`。パスは数えない）進んだ局面の engine のゲージの差だけを演出する（待った・使って 0 に戻る・再接続（`App.gaugeQuiet`）・別の対局は値だけ変える。UI で増え方を計算し直さない）。`App.afterChange` が描く前に `startGaugeAnims`（伸び始めの時刻を `App.gaugeAnims` に覚え、名札を描き直しても負の `--grow-at` で途中から続ける）、描いた後に `playGaugeFx`（`fx.ts` の `gaugeGain`: 溜めマスからゲージの先端へ光の粒・「+N」（四捨五入、1 未満は出さない）・満タンの光の輪と `sound.ts` の `gaugeFull`）。`fxLock` は延ばさない。動きを減らす設定では値だけ。CPU は `skillcpu.ts` の `chooseSkillUse`（使う手番の頭に呼ぶ）と、ノーマルは `chooseSkillLookahead`（`chooseMove` がカードを持つ view のときに切り替える。スキルなしの手は変えない）。待ったはスキルを使う前の局面を覚える
- 待った（CPU 対戦のイージーだけ。遊び方の実戦・ノーマル・ハード・2 人対戦・オンラインにはない）は `ui/undo.ts` の `Undo`（DOM なし）。`App.advance` が人間の打つ直前の `GameState` を `record` し（イミュータブルなので写しは要らない。エンジンは変えない）、`App.takeBack` がそれに差し替える（自分の直前の手と CPU の応手をまとめて戻す。戻した局面の手は演出しない・時計は最初から）。1 局 `UNDO_LIMIT` 回、`App.start` で作り直す。鍵は盤の枠の下の縁の左（`#undo-box`。オンラインの `#net` と同じ欄で、駒台には置かない＝スマホで駒台があふれる）。押せるのは `canAct` のとき（CPU の手番・演出中・終局後は押せない）。待ったの後の CPU の手は続きの乱数で決まる（e2e `undo.spec.ts` は鏡の対局で確かめる）
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
| バランス確認 | `cd web && npm run balance -- 400 king`（2 手読み同士。スキルは `npm run balance -- skill 400`。方向駒は `400 dir`、拠点は `400 anchor`、標準は `400 std`。第 3 引数で体力 "先手,後手"）。CPU の強さ同士は `npm run balance -- vs 400 std easy normal`（先手・後手を 1 局ごとに入れ替え） |
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
- 古い時系列（progress.md から移した分。必要時に Read）: `.agent/progress-archive.md`

セッション開始時に必ず両方読み、応答終了前に `activeContext` は最新状態で**上書き**、
作業が一段落していれば `progress` の末尾に**1〜3 行で追記**する。
スキップ可能なターン（単発質問への回答、タイポ修正のみ）では更新しない。

## デザイン規約

青い地と斜めの勢いはユーザーの個人サイト rukiharukichi.com（`/Users/numataharu/repos/rukiharukichi.com`）の配色・斜めに揃えつつ、挟む石・盤の格子などゲーム独自のモチーフにした（ユーザーが試作 E・F・G から選んだ G 案）。トークンは `web/src/style.css` の `:root` に集約。既存の作品のロゴ・キャラクター・画像・専用書体は使わない（ロゴは自作の SVG）。

- 考え方: 文ではなく形と動きで伝える。常に出る説明の文・ダッシュや括弧でつないだ案内文・ピル型のバッジ・同じ形の枠付きカードを縦に積む構成・半透明のガラス風パネル・パステルの配色は使わない。詳しい文は「?」（ルール詳細）・引き出しのタブ・title・読み上げ（`.sr-only`）に置き、情報は消さない
- 地: 深い青。`:root` の `background`（html）に縦のグラデーション（`#1270DC` → `#0C4FD2` → `#0A2C9F`）・-7° に傾いた深い色の帯・盤の格子（3.25rem 角の細い線）・下へ深くする幕。光の筋・水面・月・時計は描かない。どれも内容の後ろで控えめに
- 面と文字: 紺 `--navy-950`〜`--navy-700`、面は `--surface`（紺）/ `--surface-2` / `--surface-3`、線は `--line`（シアンの半透明）、細い縁は `--rim`、光は `--glow`、合わせたときの地は `--hover`。文字は `--ink` `#F2FAFF` / `--ink-muted` / `--ink-dim`
- 操作の色: 手番はシアン `--go` `#2FD3FF`、選んだもの（駒・狙ったマス・フォーカス・選んだ札・選んだタブ）は白（`--amber` は白）。選んだ・合わせた項目は白い斜めの板に紺の字へ反転し、黒と白の石で挟む: メニューの項目は両端から石（`--pinch-black` / `--pinch-white`）が寄り、押すともう一歩寄る。決定のボタンは両端に黒と白の石の縁（白は紺の線で板と分ける）、手番の名札・選んだタブ・トーストは左端に黒の帯。赤い破片は使わない。盤の上の印の色は変えない: 返す駒は赤 `--danger`、回復は `--heal`、警告の「!」は `--warn`、王は金 `--gold`、端の駒は青い盤で沈まない水色 `--anchor`
- 斜め: 帯・鍵・札・名札・駒台・体力ゲージ・時計は -12° の平行四辺形（`--slant` / `--slant-sm` の clip-path。skew で横幅を広げない＝スマホで横スクロールを出さない）。見出し・ロゴ・メニューの並びは傾けない。角は丸めない（`--radius: 0`）
- 見出し: 直立の太字の白（`--font-display`）にやわらかい影（`--soft-shadow`）。硬い影・斜体は使わない。ダイアログの見出しは右へ伸びる罫線（先頭 2rem だけ白、残りは半透明の白）。小見出しは白の斜めの帯に紺の字（`.label`）、読みは白の細い枠の帯（`.title-sub`・`.logo-kicker`）
- 盤: 角を斜めに落とした紺の枠（`.board-frame::before`。枠そのものを clip-path で切ると盤の外に出る吹き出しまで切れる）に座標（a〜h・1〜8、白の直立）、マスは深い青（`--cell`）、石は立体の黒白、b・c と f・g の列と 2・3 と 6・7 の行の交わる点に星（`.board::after`）。枠の下の縁に手番・手数・接続。手番の側の縁に線（操作できる手番は白、待つ手番はシアン）。直前の手はマスを明るい青に染め、ほかの印は枠・角のバッジにして重ねても見分ける。盤（`.board-frame`、`z-index: 2`）は名札・駒台（`isolation` で重ねた斜めの帯）より上に置き、盤の外に出る吹き出しを隠させない
- 書体: システムフォントのみ（CDN なし）。見出し・名前・鍵・数字は `--font-display`（直立の太いゴシック）、駒の漢字は明朝（`--font-piece`）、ほかはゴシック
- 部品: 名札（紺の斜めの帯。手番の人は白に反転して左端に黒の帯。石・短い名前・王の駒の形とマス名・斜めに切った体力ゲージ）、時計（紺の斜めの札にシアンの数字、残りの割合は白、減った分は黒の文字盤）、駒台（紺の斜めの帯に石、残り数は白い角、選んだ駒は持ち上がって白い縁）、吹き出し（紺の小窓に狙ったマスの内訳・警告）、引き出し（今いるタブは白の斜めの板）、メニュー（大きな直立の項目を左揃えの 1 列に並べ、選んだ・合わせた項目を白い板に反転して両端から石で挟む。タッチ端末では最初の項目が選ばれた状態）、ロゴ（斜めの盤の 2×2 マスに黒石・白石と白の駒の自作 SVG（`.brand-mark` / `.logo-mark`）・読みの帯・名前）、抽選の演出（石の着地は白と黒の輪、結果は直立の太字）、スキルのカード（タロットカード風。名前と意味の対応だけ借り、絵柄は石・駒・盤の格子の自作 SVG（`skillui.ts` の `tarotArt`）。角を落とした紺の札に二重の細い枠・明朝のローマ数字・名前の白い斜めの帯。選んだカードは持ち上がり、両端から黒と白の石が挟む。既存作品（特にペルソナ）を連想させる意匠は使わない）、名札のスキル（紺の斜めの帯にゲージ。溜まるとバーが横の拡大で伸びて先端が光り、「+N」が先端から浮かぶ。溜めマスの分はそのマスの菱形の輪から光の粒がゲージへ飛ぶ。満タンになった瞬間に札が白く光って周りに光の輪、満タンの間は白いバーが明滅し光の筋がときどき横切る。手番で使えるときはシアンの板に反転して押せる）、溜めマス（菱形の細い枠）
- 文言（市販の対局アプリに並べて違和感がないか、で判断する）: ボタン・見出し・トーストは体言止めか命令形の短い語（「再試行」「参加しない」「CPU 思考中…」「抽選で後手になりました」）。説明は 1 文まで。括弧・ダッシュの補足、感嘆符、絵文字は使わない（例外は着手の演出の掛け声 `TIER_TEXT`）。「あなた」は名札・勝敗・王の指定など誰のことか要る所だけ。補足は title・読み上げ・「?」に移し、ルール文の補足は `ruletext.ts` の `note`（要点の下の薄い字の `.rule-note`）。見出しと名前は記号でつながず字の太さで分ける（`.tab-sub`、例「ルール 標準」「標準のルール」）。先手・後手の色は文字でなく石で示す（`.seg-stone` / 名札・成績表の石）。端の駒の力（`anchor`）は画面では遊び方と同じく「反対側」と言う（設定名「反対側の駒の力」、吹き出し「1 ＋ 反対側5 ＝ 6」、予測・棋譜「反対側の金5」）。「端の駒」「端5」は画面に出さない（`test/anchor.test.ts` がルール文を検査する。コード・コメントの呼び名は「端の駒」のまま）
- 配置: 同じ形・同じ大きさの鍵や札を縦に積まない。主な選択を大きく、ほかを小さく（メニューは `.menu-big` を大きく `.menu-small` を小さくする、強さは丸の数 `.lv-stars`、設定のプリセットは標準を大きな札 `.preset-main`）。設定は「左に名前・右に選択」の行を細い線で区切る（`.set-row`）。遊び方のコーチは覚えるルールの要点（`point`）・補足（`note`）と白の三角の付いた課題（`task`）
- 要点と補足: 説明は「要点の一言」と「補足」に分け、要点は本文の 1.35 倍の太字の白（`--point-size` / `--point-weight`）、補足はその下に小さく薄い字（`--note-size`）。大きくするのは 1 つの説明で要点の 1 か所だけ（全部を大きくしない）。ルールカード・設定のルール一覧・ルール詳細は `ruletext.ts` の `{ point, note }` を `fillSentences` で描き（`.rule-point` / `.rule-note`）、遊び方は `lessons.ts` の `point` / `note`（`#coach-point` / `#coach-note`）。補足・ヒント・できたの文の数字と「金5」のような駒の数字は太字の白（`coach.ts` の `keyParts`、`.coach-key`）にし、盤の印の色は使わない

## コミット規約

グローバル CLAUDE.md（`~/.claude/CLAUDE.md`）の「Git コミット」節に従う。
