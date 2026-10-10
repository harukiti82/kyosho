# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: 説明文の「要点の一言」を大きく太く、補足を小さく（試遊の声「重要な文は大きいフォントに。駒によって挟める所が変わるよのところとか」）。遊び方（`lessons.ts` の `point` / `note`、`coach.ts`）・ルールカード・設定のルール一覧・ルール詳細（`ruletext.ts` の `{ point, note }`）。G 案（PR #35）はマージ済み。依頼元セッション経由
- ステータス: ブランチ `feat/emphasis`（worktree `../kyosho-emph`）。PR → CI → squash merge → 本番デプロイまで
- 最終更新: 2026-10-09

## 待った・「!」の切り替えの要点

- 待った: `ui/undo.ts` の `Undo`（人間が打つ前の `GameState` を積むだけ。エンジンは不変）。`App.advance` で `record`、`App.takeBack` で戻す。鍵は盤の枠の下の縁の左 `#undo-box`（駒台に置くとスマホであふれた）。成績に「待った N 回」。e2e `undo.spec.ts`
- 「!」: 表示の設定 `Saved.threat`（既定 false・古い保存も false）→ `PlaySettings.threat` → `App.threatOn`（`initThreat` で対局ごとに戻す）。対局中は引き出しのタブの列の右端 `#btn-threat`（保存は変えない）。遊び方のステップは常にオンで鍵なし、最後の実戦はふつうの対局と同じく保存した設定で鍵あり（`initThreat` / `inStep`）。「!」を確かめる e2e は `startGame(page, { threat: true })`。e2e `threat.spec.ts`

## 遊び方（チュートリアル）の要点

- ステップは `ui/lessons.ts` の `LESSONS`（挟む → ダメージ → 駒の向き → 持ち駒 → 反対側の駒 → 回復 → 王を決める → 自動で王に → 王を裏返す → 予測を読む → 実戦）。「自動で王に」は `start()` で双方 6 手ずつ `playMove` した局面（手数 12）から自分の 7 手目。局面は engine の `gameFrom`、文はエンジンの棋譜の値。画面は `App.lesson`（`openLesson` / `inStep` / `lessonNeed`）と `ui/coach.ts`（`#coach`、引き出しの先頭 = スマホは駒台の下・PC は盤の横の上）。進み具合は localStorage `kyosho:tutorial`
- 文の書き方: 内部の用語（端の駒・上乗せ・期限・低い方−1・返す）を使わず、盤の物を指して言う（「置いた駒の反対側にある自分の駒」）。できたの文はそのとき盤で起きた数字（「飛3と金5で挟んだ。小さいほうの 3 から 1 を引いた 2 だけ…」）。覚えるルールは要点の一言 `point`（句点なし・22 字まで、大きく表示）と補足 `note`（なくてもよい）で 2 文まで・課題と合わせて 3 文まで。`test/lesson.test.ts` が用語・文の数を検査する。足し算の＋は `PLUS`（WORD JOINER で折り返さない）
- 「予測を読む」より前のステップは始めの局面で自分の駒に「!」が出ない（`test/lesson.test.ts`）。e2e は `tutorial.spec.ts`（スクリーンショット *-tutorial-*）

## メニューと CPU の強さの要点

- メニュー（`ui/menu.ts`、`#menu`）: CPU対戦 → 強さ（`data-level`）でそのまま開始 / マルチ → この端末で 2 人・オンライン（`/api/health` が通るときだけ）/ 設定 / 下の「ルール 名前」でルール詳細。対局中は右上の `#btn-menu` でメニューへ、`#menu-resume`「対局に戻る」で続き（終局後・オンラインの部屋も）
- 設定メニュー（`ui/setup.ts` の `SetupDialog`、`#setup`）: フォームは下書きで「保存」で `localStorage` `kyosho:settings`（`loadSaved` / `storeSaved`。読めなければ標準）。ルールの優先は URL のクエリ ＞ 保存 ＞ `DEFAULT_PRESET`。URL への反映は保存時と対局開始時だけ。手番（CPU 対戦の side・オンラインの host）もここ
- CPU の強さ: `engine/cpu.ts` の `chooseMove(view, level, rng)`。normal = `chooseLookahead`（sim と一致）、easy = 1 手読み＋35% で適当な手、hard = 2 手読み上位 8 手 × 相手の応手上位 6 手 × 自分の最善手を 2 手読み＋決着の読み。勝率は `npm run balance -- vs 400 std normal hard`、下限は `test/level.test.ts`

## 見た目の要点（G 案。デザイン規約は AGENTS.md）

- 青と斜めはユーザーの個人サイト rukiharukichi.com（`/Users/numataharu/repos/rukiharukichi.com`）に揃える（あちらのファイルは変えない）。見出しは直立、選んだ項目は白い板を黒と白の石が挟む（`--pinch-black` / `--pinch-white`）、地は盤の格子。ロゴは自作の SVG（斜めの盤の 2×2 マスに黒石・白石と白の駒、`index.html` の `.brand-mark` / `.logo-mark`）。斜体・硬い影・赤い破片・段々・時計・水面・月は使わない
- 重なり: 盤（`.board-frame`、`z-index: 2`）は名札・駒台（`isolation` の斜めの帯）より上。枠の斜めの角は `::before` だけ（枠を clip-path で切ると盤の外の吹き出しが切れる）。詳細度の低い本体の規則を後ろの `@media (max-width: 400px)` が上書きしやすいので、狭い画面の指定を足すときはメニューの項目（`.menu-btn`）を巻き込まない

- 対局画面: 名札（`#seat-top` / `#seat-bottom`、`App.placeSeats`。自分が下、2 人対戦は先手が下）・盤の枠の下の縁に手番（`#status` は「あなたの番」など短く）・手数（`#ply`「N 手」）・接続（`#net`）。手番の側の縁に線（`.board-frame.turn-top` / `turn-bottom` / `turn-act`）
- 名札: 短い名前（`shortName`。正式名は aria-label・title）・王の駒の形とマス名（`kingTag`。返されたら取り消し線 `.lost`、オンラインの相手は「候補N」で `#king-cands`）・持ち駒（駒台に出ている人の分は省く）・体力ゲージ（`.hp-gauge`、減った分は `.hp-ghost`）
- 駒台（`.tray`）: 残り数は `.piece-count`、置けない駒は `.blocked` の斜線、隠し王は右端の王の駒（`#king-toggle`「あと N 手」、2 人対戦の `#king-peek`）。説明の文は sr-only の `#king-note`
- 予測: マスのバッジ（`.dmg-badge` / `.heal-badge`）＋吹き出し（`App.bubble`。返す駒・端の駒がない側に出し、上下両方にあれば盤の外の縁 `.edge-top` / `.edge-bottom`）。文の詳細は引き出しの「予測」タブ（`#preview`、閉じても `.tab-off` で読み上げに残す）
- 引き出し（`#drawer`、`setTab`）: 「ルール 名前」（名前は `.tab-sub`）「予測」「棋譜」「印」。PC は盤の横でルールを開いて始め、スマホは閉じて始める
- 設定メニュー: プリセットの札（標準は大きな `.preset-main`、ほかは名前の長さなりの小さな札）＋ルール文 `#setup-rules4` →「詳細設定」（`#rule-details`）→ 手番・1 手の時間（`.set-row` の行）→ やめる／保存（e2e は `openRuleFields` / `openTab`）。終局画面は見出し・理由・成績表（`.score`）・成績（`.stats`）。オンラインのダイアログは 2 つの席を VS で並べる（`.lobby`）

## 直近の観点・指摘

- 抽選の演出: `App.playToss` / `endToss`（`fx.ts` の `toss`・`tossMs` 1.9 秒・`tossAngle`、`sound.ts` の `toss`、CSS `.fx-toss`）。CPU 対戦の「ランダム」は `App.start`、オンラインは `state.seatDraw`（サーバーの `RoomRecord.drawn`、1 局目だけ）を `App.claimToss` が見る（sessionStorage `kyosho:toss:<roomId>` で再読み込みでは出し直さない）。演出中は `fxLock`。サーバーは最初の締め切りに `TOSS_GRACE_MS`。e2e は `toss.spec.ts`・`online/toss.spec.ts`・`helpers.ts` の `skipToss`
- 既定ルール: 既定は `rules.ts` の `DEFAULT_PRESET`（= `std`、標準: 方向駒＋端の駒の力＋隠し王（期限 7 手・−30）＋回復は低い方−1、体力 129・130、歩10 横10 角4 飛3 金2）。URL のクエリは `QUERY_BASE`（v1.0）からの差分で、欠けた項目・不正な項目も v1.0 の値（変えない）。ルールのキーがないときだけ既定。互換は `web/test/fixtures/query-compat.json`（変更前の main の出力）で検査。2 手読み同士の先手勝率は 49.5 ± 1.1%（8000 局。走査表は RULES.md「Web 試遊版」節）。旧標準（平均・110・期限 5）を明記した URL・保存済みの設定（localStorage）は旧の値のままカスタムとして読む
- CPU 対戦の手番: 設定の `side` は `random` / `0` / `1`（既定は `random`。手番は URL に載らず、設定メニューの保存（localStorage）に載る。保存済みの `0` / `1` はそのまま）。`random` は `PlaySettings.randomSeat` で、`App.start` が対局ごとに `drawSeat`（`crypto.getRandomValues`。`Math.random` は CPU と共有なので使わない）で引き直し、トーストで知らせる。e2e は `seat.spec.ts`・`menu.spec.ts`（`helpers.ts` の `stubDraws` で crypto を差し替え）。`startGame` は CPU 対戦で side を省くと先手を選ぶ（種付きの鏡の対局は人間が先手の前提。設定の手番のままなら `side: "saved"`）
- オンラインの画面: 通信層は `net/online.ts`（DOM なし・`test/online.test.ts`）、案内のダイアログは `ui/online.ts`、対局は `ui/app.ts`（`settings.mode === "online"`）。手は送るだけで、盤は届いた `view` で描く。王は `App.kingOf`（view の `myKing` / `oppKing`）。トークンは sessionStorage `kyosho:token:<roomId>`（別タブは別人）。入口は `/api/health` が `{"ok":true}` のときだけ。e2e は `npm run e2e:online`（wrangler dev :8790）。画面側の挙動の詳細は `.agent/online-protocol.md`「画面側の挙動」
- サーバーの不足（直していない。足すかはユーザーの判断）: 終局後も返されなかった相手の王が届かない（終局画面は「非公開」）
- オンラインの再戦: 同じ部屋で申し込み・受ける・断る・取り消し（`rematch`、`state.gameNo` / `state.rematch` / `opponent.left`）。成立で席のトークンを入れ替える（トークンは同じ）。相手が `leave` で抜けたら「新しい部屋で再戦」。タブを閉じただけ・回線切れは切断扱いで、申し込みは残る。通算（`state.record`）は人（作成者・参加者）ごとに数え、`host` で席を人に直す
- 体力の表示: エンジンの `hp` は決着の一手で負になる（sim と同じ。replay が突き合わせる）。画面に出す体力は `shownHp` を通す
- server/ は vitest 4（pool-workers の要件）。npm 11.4 は install で落ちるので `npx npm@11.21.0 install`。`worker-configuration.d.ts` は生成物（`npm run typecheck` / `test` の前に `wrangler types`）
- 演出（詳細は AGENTS.md）: 段階は `ui/impact.ts` の `tierOf`、決着は `ui/outcome.ts` の `outcomeOf` と `App.playFinale`、抽選は `App.playToss`。どれも `#fx` 層の transform / opacity だけで、`App.fxLock` で入力・CPU・時計を待たせる。`src/ui/` で `Math.random` を使わない（e2e の鏡の対局がずれる）
- プリセット「拠点」は方向駒＋上乗せ、体力 125・130（RULES.md「拠点」）。v0.4 / v1.0 / v2 案は `sim/*.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・タップ 2 回で確定。盤の左右端の列の着手演出は `.edge-l` / `.edge-r` で内側に寄せる

## 未解決・次の一手

- [ ] ユーザーの試遊で待った（イージーだけ・3 回）と「!」の既定オフの手応えを聞く。既定オフで「ルールが一目で分かる」が損なわれていないか
- [ ] ユーザーにスマホの実機で G 案の見た目（直立の見出しの読みやすさ・挟む石・盤の格子と星）を見てもらう
- [ ] ユーザーの試遊で、要点を大きくした説明文の読みやすさ（要点の言い回し・補足の小ささ・スマホのルールカードの長さ）の感想を聞く
- [ ] ユーザーの試遊で遊び方の分かりやすさ（ステップの順・目標の文・光と矢印の誘導・最後の実戦）の感想を聞く。初回にメニューで勧める強さ（今は「遊び方」の横のシアンの「おすすめ」だけ）もユーザー判断
- [ ] progress.md が 30 件を超えた（40 件）。`progress-archive.md` への移送をユーザーに提案する
- [ ] ユーザーの試遊で制限時間の長さ（ノーマル 45 秒・ハード 20 秒・マルチ 45 秒）と時計の見やすさの感想を聞く
- [ ] ユーザーの試遊で CPU の強さの手応え（イージーで勝てるか・ハードが強すぎないか）とメニューの流れの感想を聞く。スマホ 2 台でオンラインの作成 → 参加も実機で確かめる
- [ ] ユーザーの試遊で 期限 7 手・回復 低い方−1 の標準の手応えを聞く（CPU の強さの差: ハード対ノーマル 72.0%・ノーマル対イージー 85.8%）
- [ ] 本番 https://kyosho.rukiharukichi.com/ でメニューの「マルチ」に「オンライン」が出ること、スマホ 2 台で作成 → 参加 → 終局・再読み込みを確かめる。確かめたら別タスクで GitHub Pages（`pages.yml`）を止める
- [ ] 本番のスマホ 2 台で再戦の流れと通算の表示を確かめる。CPU 対戦・同じ端末の 2 人対戦にも通算を出すかはユーザー判断（今はオンラインだけ）
- [ ] ユーザーの試遊で演出の手応え・方向駒・隠し王・拠点・オセロの枠の見やすさの感想を聞く。RULES.md 本文を標準で新版に改稿するかはユーザー判断

## 現フェーズで Read すべき設計書

- 遊び方: `web/src/ui/lessons.ts`, `web/src/ui/coach.ts`, `web/src/ui/app.ts`（「遊び方（チュートリアル）」節 `openLesson` / `inStep`、`onCellClick`・`renderBoard` の誘導）, `web/test/lesson.test.ts`, `web/e2e/tutorial.spec.ts`
- 待った・「!」・制限時間: `web/src/ui/undo.ts`, `web/src/ui/app.ts`（`takeBack` / `initThreat` / `setThreat` / `syncClock` / `checkTimeout`）, `web/src/ui/setup.ts`（`Saved.threat`）, `web/src/ui/clock.ts`, `web/src/engine/game.ts`（`playTimeout`）, `server/src/room.ts`
- メニュー・設定メニュー・CPU の強さ: `web/src/ui/menu.ts`, `web/src/ui/setup.ts`, `web/src/ui/app.ts`（`showMenu` / `resume` / `leaveToMenu`）, `web/src/engine/cpu.ts`（`chooseMove`）
- 画面の見た目を直す: AGENTS.md の「デザイン規約」→ `web/src/style.css`（`:root` のトークン）, `web/index.html`, `web/src/ui/app.ts`（`placeSeats` / `renderPlayers` / `kingTag` / `bubble` / `setTab` / `renderScore`）, `web/src/ui/setup.ts`, `web/src/ui/menu.ts`
- オンライン対戦の画面の修正: `.agent/online-protocol.md`（「画面側の挙動」「再戦」）→ `web/src/net/online.ts` → `web/src/ui/app.ts`（「オンライン対戦」節）, `web/src/ui/online.ts`, `web/e2e/online/`
- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」。ダメージ・端の駒: `web/src/engine/board.ts`（`damageOf` / `anchorsOf`）, `web/test/anchor.test.ts`。方向駒: `board.ts`（`pieceLines`）, `test/direction.test.ts`。隠し王: `game.ts`（隠し王節）, `cpu.ts`, `test/king.test.ts`
- 演出・効果音・成績: `web/src/ui/impact.ts`, `web/src/ui/fx.ts`, `web/src/ui/sound.ts`, `web/test/impact.test.ts`, `web/e2e/impact.spec.ts`。決着の演出: `web/src/ui/outcome.ts`, `web/test/outcome.test.ts`, `web/e2e/result.spec.ts`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-* / sp-* 、隠し王は *-king-*、方向駒は *-dir*、拠点は *-anchor*、演出は *-impact-*、決着は *-result-*、オンラインは *-online-*、遊び方は *-tutorial-*、待ったは *-undo-*、「!」は *-threat-*）。デプロイ: `.github/workflows/pages.yml`（GitHub Pages。PR はテスト+ビルドのみ、main への push でデプロイ）、`.github/workflows/deploy.yml`（Cloudflare。Secret 登録済み = main へのマージで本番デプロイ）、`server/wrangler.jsonc`
