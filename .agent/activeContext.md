# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: 全画面の「AI っぽさ」を取る（ユーザー要望「設定画面とか随所にAIっぽさが残ってるからどうにかして」。依頼元セッション経由）。文言（括弧・ダッシュの補足・感嘆符・長いトーストをやめる）、メニュー・設定メニューの配置、遊び方のコーチ、回復の課題の「+5」とダメージ数の重なり。ブランチ `style/less-ai-ui`
- ステータス: 実装済み、テスト・PR・本番デプロイの確認中。判断基準は AGENTS.md「デザイン規約」の「文言」「配置」
- 最終更新: 2026-10-08

## 遊び方（チュートリアル）の要点

- ステップは `ui/lessons.ts` の `LESSONS`（挟む → ダメージ → 駒の向き → 持ち駒 → 端の駒 → 回復 → 王を決める → 王を返す → 予測を読む → 実戦）。局面は engine の `gameFrom`、文はエンジンの棋譜の値。画面は `App.lesson`（`openLesson` / `inStep` / `lessonNeed`）と `ui/coach.ts`（`#coach`、引き出しの先頭 = スマホは駒台の下・PC は盤の横の上）。進み具合は localStorage `kyosho:tutorial`
- 「予測を読む」より前のステップは始めの局面で自分の駒に「!」が出ない（`test/lesson.test.ts`）。e2e は `tutorial.spec.ts`（スクリーンショット *-tutorial-*）

## 1 手の制限時間の要点

- ルールではなく `PlaySettings.turnSeconds`（URL に載せない）。CPU 対戦 `Saved.timeCpu`（`auto` = イージー 0・ノーマル 45・ハード 20）、マルチ `timeMulti`（既定 45）。時間切れは engine の `playTimeout`。画面は `ui/clock.ts` の `TurnClock` を `App.syncClock` が合わせる（遊び方は常に 0）。オンラインはサーバーの alarm（`.agent/online-protocol.md`「1 手の制限時間」）

## メニューと CPU の強さの要点

- メニュー（`ui/menu.ts`、`#menu`）: CPU対戦 → 強さ（`data-level`）でそのまま開始 / マルチ → この端末で 2 人・オンライン（`/api/health` が通るときだけ）/ 設定 / 下の「ルール 名前」でルール詳細。対局中は右上の `#btn-menu` でメニューへ、`#menu-resume`「対局に戻る」で続き（終局後・オンラインの部屋も）
- 設定メニュー（`ui/setup.ts` の `SetupDialog`、`#setup`）: フォームは下書きで「保存」で `localStorage` `kyosho:settings`（`loadSaved` / `storeSaved`。読めなければ標準）。ルールの優先は URL のクエリ ＞ 保存 ＞ `DEFAULT_PRESET`。URL への反映は保存時と対局開始時だけ。手番（CPU 対戦の side・オンラインの host）もここ
- CPU の強さ: `engine/cpu.ts` の `chooseMove(view, level, rng)`。normal = `chooseLookahead`（sim と一致）、easy = 1 手読み＋35% で適当な手、hard = 2 手読み上位 8 手 × 相手の応手上位 6 手 × 自分の最善手を 2 手読み＋決着の読み。勝率は `npm run balance -- vs 400 std normal hard`、下限は `test/level.test.ts`

## 新デザインの要点（デザイン規約は AGENTS.md）

- 対局画面: 名札（`#seat-top` / `#seat-bottom`、`App.placeSeats`。自分が下、2 人対戦は先手が下）・木枠の下の縁に手番（`#status` は「あなたの番」など短く）・手数（`#ply`「N 手」）・接続（`#net`）。手番の側の縁が光る（`.board-frame.turn-top` / `turn-bottom` / `turn-act`）
- 名札: 短い名前（`shortName`。正式名は aria-label・title）・王の駒の形とマス名（`kingTag`。返されたら取り消し線 `.lost`、オンラインの相手は「候補N」で `#king-cands`）・持ち駒（駒台に出ている人の分は省く）・体力ゲージ（`.hp-gauge`、減った分は `.hp-ghost`）
- 駒台（`.tray`）: 残り数は `.piece-count`、置けない駒は `.blocked` の斜線、隠し王は右端の王の駒（`#king-toggle`「あと N 手」、2 人対戦の `#king-peek`）。説明の文は sr-only の `#king-note`
- 予測: マスのバッジ（`.dmg-badge` / `.heal-badge`）＋吹き出し（`App.bubble`。返す駒・端の駒がない側に出し、上下両方にあれば盤の外の縁 `.edge-top` / `.edge-bottom`）。文の詳細は引き出しの「予測」タブ（`#preview`、閉じても `.tab-off` で読み上げに残す）
- 引き出し（`#drawer`、`setTab`）: 「ルール 名前」（名前は `.tab-sub`）「予測」「棋譜」「印」。PC は盤の横でルールを開いて始め、スマホは閉じて始める
- 設定メニュー: プリセットの札（標準は大きな `.preset-main`、ほかは名前の長さなりの小さな札）＋ルール文 `#setup-rules4` →「詳細設定」（`#rule-details`）→ 手番・1 手の時間（`.set-row` の行）→ やめる／保存（e2e は `openRuleFields` / `openTab`）。終局画面は見出し・理由・成績表（`.score`）・成績（`.stats`）。オンラインのダイアログは 2 つの席を VS で並べる（`.lobby`）

## 直近の観点・指摘

- 既定ルール: 既定は `rules.ts` の `DEFAULT_PRESET`（= `std`、標準: 方向駒＋端の駒の力＋隠し王（期限 7 手・−30）＋回復は低い方−1、体力 129・130、歩10 横10 角4 飛3 金2）。URL のクエリは `QUERY_BASE`（v1.0）からの差分で、欠けた項目・不正な項目も v1.0 の値（変えない）。ルールのキーがないときだけ既定。互換は `web/test/fixtures/query-compat.json`（変更前の main の出力）で検査。2 手読み同士の先手勝率は 49.5 ± 1.1%（8000 局。走査表は RULES.md「Web 試遊版」節）。旧標準（平均・110・期限 5）を明記した URL・保存済みの設定（localStorage）は旧の値のままカスタムとして読む
- CPU 対戦の手番: 設定の `side` は `random` / `0` / `1`（既定は `random`。手番は URL に載らず、設定メニューの保存（localStorage）に載る。保存済みの `0` / `1` はそのまま）。`random` は `PlaySettings.randomSeat` で、`App.start` が対局ごとに `drawSeat`（`crypto.getRandomValues`。`Math.random` は CPU と共有なので使わない）で引き直し、トーストで知らせる。e2e は `seat.spec.ts`・`menu.spec.ts`（`helpers.ts` の `stubDraws` で crypto を差し替え）。`startGame` は CPU 対戦で side を省くと先手を選ぶ（種付きの鏡の対局は人間が先手の前提。設定の手番のままなら `side: "saved"`）
- オンラインの画面: 通信層は `net/online.ts`（DOM なし・`test/online.test.ts`）、案内のダイアログは `ui/online.ts`、対局は `ui/app.ts`（`settings.mode === "online"`）。手は送るだけで、盤は届いた `view` で描く。王は `App.kingOf`（view の `myKing` / `oppKing`）。トークンは sessionStorage `kyosho:token:<roomId>`（別タブは別人）。入口は `/api/health` が `{"ok":true}` のときだけ。e2e は `npm run e2e:online`（wrangler dev :8790）。画面側の挙動の詳細は `.agent/online-protocol.md`「画面側の挙動」
- サーバーの不足（直していない）: 終局後も返されなかった相手の王が届かない（終局画面は「非公開」）・同じ部屋での再戦の申し込みがない（「新しい部屋で再戦」は招待リンクを送り直す）

- 配信（詳細は AGENTS.md）: 1 つの Worker（`server/wrangler.jsonc`）が `web/dist` を静的アセットで、`/api` を Worker で返す（`run_worker_first: ["/api", "/api/*"]`。静的アセットでは Worker も DO も起きない）。Origin は同一オリジン＋`ALLOWED_ORIGINS`（本番は `https://kyosho.rukiharukichi.com`、`npm run dev` が `--var` で localhost に置き換える）。CORS なし。画面はサーバー URL を持たず `API_PATH`（`/api`）の絶対パスで呼ぶ。GitHub Pages 版ではオンラインがつながらないので、画面は `/api/health` に届かなければ入口を出さない
- オンライン対戦: サーバーは engine を import する権威サーバー。各自には `viewFor` だけを送る（`server/test/king.test.ts` が、相手の王の指定だけ違う 2 部屋で自分に届くバイト列が一致することを検査）。3 人目は拒否（観戦なし）。先手・後手は作成者の `hostSeat`（既定 random）。再接続はトークン（`sessionStorage` 推奨）。放置した部屋は alarm で削除（24 時間・終局後 1 時間）
- server/ は vitest 4（pool-workers の要件）。npm 11.4 は install で落ちるので `npx npm@11.21.0 install`。`worker-configuration.d.ts` は生成物（`npm run typecheck` / `test` の前に `wrangler types`）
- 普通のオセロなら置けるマス: `board.ts` の `othelloCells`（石の色だけ・8 方向。駒の方向・強さ・持ち駒を見ない参考表示で、合法手の判定には使わない）。盤は操作できる手番だけ `.cell.othello`（点線の枠、`--othello`）、凡例 `.key-othello`。e2e `othello.spec.ts`・オンラインは `online.spec.ts`
- 最重要要件は「ルールが一目で分かること」＝ルールはいつでも 1 タップで見られる。ルールカードは設定から自動生成（`ui/ruletext.ts`、最大 8 行）して引き出しの「ルール 名前」のタブ（見出しは常に表示、PC は開いて始める）。予測の赤枠＋ダメージ・回復、返されうる自駒の「!」、自分の王の赤い「!」、駒の方向アイコン、端の駒の青枠＋左下の「+数字」と内訳（返した駒 ＋ 端の金5 ＝ 7）を崩さない
- 決着の演出: 中身（種類・副題・接戦の励まし）は `ui/outcome.ts` の `outcomeOf`（DOM なし、接戦は自分の体力上限の `CLOSE_PERCENT`=10% 以下）。表示は `fx.ts` の `finale`（画面全体を覆いタップ／クリックで飛ばす）、音は `sound.ts` の `finale`、流れは `App.playFinale` / `endFinale`（Enter / Esc / スペースでも飛ばす）。最大 2.5 秒（`FINALE_MS` 2300）。負けたら終局画面の「再戦」を `.urge` で強調、励ましは `#result-cheer`
- 手応えの演出: 段階は `ui/impact.ts` の `tierOf`（合計（上乗せ・王の罰込み）÷ 受けた側の体力上限。5% / 10% / 20% は `TIER_THRESHOLDS`、王を返した手は特大）。演出は `ui/fx.ts`（`#fx` 層・transform / opacity のみ）、効果音は `ui/sound.ts`（Web Audio 合成・消音は localStorage）。大・特大は `App.fxLock` で入力と CPU を最大 1.5 秒待たせる。`src/ui/` で `Math.random` を使わない（e2e の鏡の対局がずれる）
- プリセット「拠点」は方向駒＋上乗せ、体力 125・130（4000 局で先手 47.3%・平均 31.3 手）。隅の端の上乗せは全体の約 1%、隅を取った側の勝率は同じ手数の方向駒より低い（RULES.md「拠点」）
- プリセット v0.4 / v1.0 / v2 案は `sim/*.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・タップ 2 回で確定。盤の左右端の列の着手演出は `.edge-l` / `.edge-r` で内側に寄せる

## 未解決・次の一手

- [ ] ユーザーの試遊で遊び方の分かりやすさ（ステップの順・目標の文・光と矢印の誘導・最後の実戦）の感想を聞く。初回にメニューで勧める強さ（今は「遊び方」の下の琥珀の「おすすめ」だけ）もユーザー判断
- [ ] 数字と単位の間の半角空白（「45 秒」「6 手」）はアプリ全体・棋譜・テストで統一しているので今回は残した。市販のアプリに寄せて詰めるかはユーザー判断（メニューの強さ・設定の時間の鍵は詰めた表記）
- [ ] progress.md が 30 件を超えた。`progress-archive.md` への移送をユーザーに提案する
- [ ] ユーザーの試遊で制限時間の長さ（ノーマル 45 秒・ハード 20 秒・マルチ 45 秒）と時計の見やすさの感想を聞く
- [ ] ユーザーの試遊で CPU の強さの手応え（イージーで勝てるか・ハードが強すぎないか）とメニューの流れの感想を聞く。スマホ 2 台でオンラインの作成 → 参加も実機で確かめる
- [ ] ユーザーの試遊で 期限 7 手・回復 低い方−1 の標準の手応えを聞く（CPU の強さの差: ハード対ノーマル 72.0%・ノーマル対イージー 85.8%）
- [ ] 本番 https://kyosho.rukiharukichi.com/ でメニューの「マルチ」に「オンライン」が出ること、スマホ 2 台で作成 → 参加 → 終局・再読み込みを確かめる。確かめたら別タスクで GitHub Pages（`pages.yml`）を止める
- [ ] 必要ならサーバーに「終局後の相手の王の公開」「同じ部屋での再戦」を足す（ユーザーの判断）
- [ ] ユーザーの試遊で演出の手応え・方向駒・隠し王・拠点・オセロの枠の見やすさの感想を聞く。RULES.md 本文を標準で新版に改稿するかはユーザー判断

## 現フェーズで Read すべき設計書

- 遊び方: `web/src/ui/lessons.ts`, `web/src/ui/coach.ts`, `web/src/ui/app.ts`（「遊び方（チュートリアル）」節 `openLesson` / `inStep`、`onCellClick`・`renderBoard` の誘導）, `web/test/lesson.test.ts`, `web/e2e/tutorial.spec.ts`
- 制限時間: `web/src/ui/clock.ts`, `web/src/ui/app.ts`（「制限時間」節 `syncClock` / `checkTimeout`）, `web/src/engine/game.ts`（`playTimeout`）, `server/src/room.ts`
- メニュー・設定メニュー・CPU の強さ: `web/src/ui/menu.ts`, `web/src/ui/setup.ts`, `web/src/ui/app.ts`（`showMenu` / `resume` / `leaveToMenu`）, `web/src/engine/cpu.ts`（`chooseMove`）
- 画面の見た目を直す: AGENTS.md の「デザイン規約」→ `web/src/style.css`（`:root` のトークン）, `web/index.html`, `web/src/ui/app.ts`（`placeSeats` / `renderPlayers` / `kingTag` / `bubble` / `setTab` / `renderScore`）
- オンライン対戦の画面の修正: `.agent/online-protocol.md`（「画面側の挙動」）→ `web/src/net/online.ts` → `web/src/ui/app.ts`（「オンライン対戦」節）, `web/src/ui/online.ts`, `web/e2e/online/`
- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」
- ダメージ・端の駒: `web/src/engine/board.ts`（`damageOf` / `anchorsOf`）, `web/test/anchor.test.ts`。方向駒: `board.ts`（`pieceLines`）, `test/direction.test.ts`。隠し王: `game.ts`（隠し王節）, `cpu.ts`, `test/king.test.ts`
- 演出・効果音・成績: `web/src/ui/impact.ts`, `web/src/ui/fx.ts`, `web/src/ui/sound.ts`, `web/test/impact.test.ts`, `web/e2e/impact.spec.ts`。決着の演出: `web/src/ui/outcome.ts`, `web/test/outcome.test.ts`, `web/e2e/result.spec.ts`
- 画面の修正: `web/src/ui/app.ts`（対局）, `web/src/ui/setup.ts`（設定メニュー）, `web/src/ui/menu.ts`（メニュー）, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-* / sp-* 、隠し王は *-king-*、方向駒は *-dir*、拠点は *-anchor*、演出は *-impact-*、決着は *-result-*、オンラインは *-online-*、遊び方は *-tutorial-*）
- デプロイ: `.github/workflows/pages.yml`（GitHub Pages。PR はテスト+ビルドのみ、main への push でデプロイ）、`.github/workflows/deploy.yml`（Cloudflare。Secret 登録済み = main へのマージで本番デプロイ）、`server/wrangler.jsonc`
