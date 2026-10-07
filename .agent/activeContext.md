# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: 画面の流れを「メニュー → 対局」に作り直し、CPU の強さを 3 段階にする（依頼元セッション経由のユーザー要望「メニューで CPU対戦かマルチ」「設定画面を出さず標準で」「設定は別メニュー」「CPU はイージー・ノーマル・ハード」）。ブランチ `feat/menu-cpu-level`
- ステータス: PR #20 でマージ・本番デプロイ済み（2026-10-08。本番でメニュー → CPU対戦（イージー）で標準が始まること・マルチにオンラインの入口が出ることをヘッドレスで確認）
- 王の指定期限 7 手（標準）は依頼元の方針変更でこの PR から外した（revert 済み。2 手読み同士の先手勝率が 49.5% → 30.4% に下がるため、体力・回復の再調整と合わせて別ワーカーが担当）
- 最終更新: 2026-10-08

## メニューと CPU の強さの要点

- メニュー（`ui/menu.ts`、`#menu`）: CPU対戦 → 強さ（`data-level`）でそのまま開始 / マルチ → この端末で 2 人・オンライン（`/api/health` が通るときだけ）/ 設定 / 下の「ルール 名前」でルール詳細。対局中は右上の `#btn-menu` でメニューへ、`#menu-resume`「対局に戻る」で続き（終局後・オンラインの部屋も）
- 設定メニュー（`ui/setup.ts` の `SetupDialog`、`#setup`）: フォームは下書きで「保存」で `localStorage` `kyosho:settings`（`loadSaved` / `storeSaved`。読めなければ標準）。ルールの優先は URL のクエリ ＞ 保存 ＞ `DEFAULT_PRESET`。URL への反映は保存時と対局開始時だけ。手番（CPU 対戦の side・オンラインの host）もここ
- CPU の強さ: `engine/cpu.ts` の `chooseMove(view, level, rng)`。normal = `chooseLookahead`（sim と一致）、easy = 1 手読み＋35% で適当な手、hard = 2 手読み上位 8 手 × 相手の応手上位 6 手 × 自分の最善手を 2 手読み＋決着の読み。勝率は `npm run balance -- vs 400 std normal hard`、下限は `test/level.test.ts`
- e2e は `e2e/helpers.ts` の `openSettings` / `saveSettings` / `startGame({ mode, side, preset, level })`。メニューの流れは `e2e/menu.spec.ts`

## 新デザインの要点（デザイン規約は AGENTS.md）

- 対局画面: 名札（`#seat-top` / `#seat-bottom`、`App.placeSeats`。自分が下、2 人対戦は先手が下）・木枠の下の縁に手番（`#status` は「あなたの番」など短く）・手数（`#ply`「N 手」）・接続（`#net`）。手番の側の縁が光る（`.board-frame.turn-top` / `turn-bottom` / `turn-act`）
- 名札: 短い名前（`shortName`。正式名は aria-label・title）・王の駒の形とマス名（`kingTag`。返されたら取り消し線 `.lost`、オンラインの相手は「候補N」で `#king-cands`）・持ち駒（駒台に出ている人の分は省く）・体力ゲージ（`.hp-gauge`、減った分は `.hp-ghost`）
- 駒台（`.tray`）: 残り数は `.piece-count`、置けない駒は `.blocked` の斜線、隠し王は右端の王の駒（`#king-toggle`「あと N 手」、2 人対戦の `#king-peek`）。説明の文は sr-only の `#king-note`
- 予測: マスのバッジ（`.dmg-badge` / `.heal-badge`）＋吹き出し（`App.bubble`。返す駒・端の駒がない側に出し、上下両方にあれば盤の外の縁 `.edge-top` / `.edge-bottom`）。文の詳細は引き出しの「予測」タブ（`#preview`、閉じても `.tab-off` で読み上げに残す）
- 引き出し（`#drawer`、`setTab`）: 「ルール — 名前」「予測」「棋譜」「印」。PC は盤の横でルールを開いて始め、スマホは閉じて始める
- 設定メニュー: ルール（名前だけのプリセットの札＋選んだ設定のルール文 `#setup-rules4`）→「ルールを細かく変える」（`#rule-details`、プリセットと違う設定なら開いて始める）→ 手番 → やめる／保存。e2e は `openRuleFields` / `openTab`（`e2e/helpers.ts`）
- 終局画面: 見出し（明朝、勝ちは琥珀）・理由の 1 文・成績表（`#result-detail` の `.score`。対局者が列、体力・石数・王が行、下に「N 手・ルール 名前」）・成績（`.stats`）
- オンラインのダイアログ: 対戦待ちのように 2 つの席を VS で並べる（`.lobby`、空いた席は脈打つ）。ルールは「ルール — 名前」の折りたたみ

## 直近の観点・指摘

- 既定ルール: 既定は `rules.ts` の `DEFAULT_PRESET`（= `std`、標準: 方向駒＋端の駒の力＋隠し王−30＋回復は平均、体力 110・130、歩10 横10 角4 飛3 金2）。URL のクエリは `QUERY_BASE`（v1.0）からの差分で、欠けた項目・不正な項目も v1.0 の値（変えない）。ルールのキーがないときだけ既定。互換は `web/test/fixtures/query-compat.json`（変更前の main の出力）で検査。2 手読み同士の先手勝率は 49.5 ± 1.1%（8000 局。先手 125 のときは約 64% だったので 110 に下げた）
- CPU 対戦の手番: 設定の `side` は `random` / `0` / `1`（既定は `0` = 先手。手番は URL・保存設定に載らない）。`random` は `PlaySettings.randomSeat` で、`App.start` が対局ごとに `drawSeat`（`crypto.getRandomValues`。`Math.random` は CPU と共有なので使わない）で引き直し、トーストで知らせる。e2e は `seat.spec.ts`（crypto を差し替え）
- オンラインの画面: 通信層は `net/online.ts`（DOM なし・`test/online.test.ts`）、案内のダイアログは `ui/online.ts`、対局は `ui/app.ts`（`settings.mode === "online"`）。手は送るだけで、盤は届いた `view` で描く。王は `App.kingOf`（view の `myKing` / `oppKing`）。トークンは sessionStorage `kyosho:token:<roomId>`（別タブは別人）。入口は `/api/health` が `{"ok":true}` のときだけ。e2e は `npm run e2e:online`（wrangler dev :8790）。画面側の挙動の詳細は `.agent/online-protocol.md`「画面側の挙動」
- サーバーの不足（直していない）: 終局後も返されなかった相手の王が届かない（終局画面は「？（明かされない）」）・同じ部屋での再戦の申し込みがない（「新しい部屋で再戦」は招待リンクを送り直す）

- 配信: 1 つの Worker（`server/wrangler.jsonc`）が `web/dist` を静的アセットで、`/api` を Worker で返す（`run_worker_first: ["/api", "/api/*"]`。静的アセットでは Worker も DO も起きない）。Origin は同一オリジン＋`ALLOWED_ORIGINS`（本番は `https://kyosho.rukiharukichi.com`、`npm run dev` が `--var` で localhost に置き換える）。CORS なし。画面はサーバー URL を持たず `API_PATH`（`/api`）の絶対パスで呼ぶ。GitHub Pages 版ではオンラインがつながらないので、画面は `/api/health` に届かなければ入口を出さない
- 独自ドメイン: `server/wrangler.jsonc` の `routes`（`kyosho.rukiharukichi.com`、`custom_domain: true`）。ドメインを変えるなら `routes` と `ALLOWED_ORIGINS` の 2 か所（手順は README「独自ドメイン（kyosho.rukiharukichi.com）」）
- オンライン対戦: サーバーは engine を import する権威サーバー。各自には `viewFor` だけを送る（`server/test/king.test.ts` が、相手の王の指定だけ違う 2 部屋で自分に届くバイト列が一致することを検査）。3 人目は拒否（観戦なし）。先手・後手は作成者の `hostSeat`（既定 random）。再接続はトークン（`sessionStorage` 推奨）。放置した部屋は alarm で削除（24 時間・終局後 1 時間）
- server/ は vitest 4（pool-workers の要件）。npm 11.4 は install で落ちるので `npx npm@11.21.0 install`。`worker-configuration.d.ts` は生成物（`npm run typecheck` / `test` の前に `wrangler types`）
- 普通のオセロなら置けるマス: `board.ts` の `othelloCells`（石の色だけ・8 方向。駒の方向・強さ・持ち駒を見ない参考表示で、合法手の判定には使わない）。盤は操作できる手番だけ `.cell.othello`（点線の枠、`--othello`）、凡例 `.key-othello`。e2e `othello.spec.ts`・オンラインは `online.spec.ts`
- 最重要要件は「ルールが一目で分かること」＝ルールはいつでも 1 タップで見られる。ルールカードは設定から自動生成（`ui/ruletext.ts`、最大 8 行）して引き出しの「ルール — 名前」のタブ（見出しは常に表示、PC は開いて始める）。予測の赤枠＋ダメージ・回復、返されうる自駒の「!」、自分の王の赤い「!」、駒の方向アイコン、端の駒の青枠＋左下の「+数字」と内訳（返した駒 ＋ 端の金5 ＝ 7）を崩さない
- 決着の演出: 中身（種類・副題・接戦の励まし）は `ui/outcome.ts` の `outcomeOf`（DOM なし、接戦は自分の体力上限の `CLOSE_PERCENT`=10% 以下）。表示は `fx.ts` の `finale`（画面全体を覆いタップ／クリックで飛ばす）、音は `sound.ts` の `finale`、流れは `App.playFinale` / `endFinale`（Enter / Esc / スペースでも飛ばす）。最大 2.5 秒（`FINALE_MS` 2300）。負けたら終局画面の「再戦」を `.urge` で強調、励ましは `#result-cheer`
- 手応えの演出: 段階は `ui/impact.ts` の `tierOf`（合計（上乗せ・王の罰込み）÷ 受けた側の体力上限。5% / 10% / 20% は `TIER_THRESHOLDS`、王を返した手は特大）。演出は `ui/fx.ts`（`#fx` 層・transform / opacity のみ）、効果音は `ui/sound.ts`（Web Audio 合成・消音は localStorage）。大・特大は `App.fxLock` で入力と CPU を最大 1.5 秒待たせる。`src/ui/` で `Math.random` を使わない（e2e の鏡の対局がずれる）
- 端の駒の力: ダメージは `damageOf` ＝ `baseDamageOf` ＋ `anchorBonusOf`（返した列ごとの反対端 `Line.end` / `endAt`）。予測・警告・CPU はすべてこれを通す。`MoveEvent.anchors` は上乗せがあるときだけ
- プリセット「拠点」は方向駒＋上乗せ、体力 125・130（4000 局で先手 47.3%・平均 31.3 手）。隅の端の上乗せは全体の約 1%、隅を取った側の勝率は同じ手数の方向駒より低い（RULES.md「拠点」）
- 方向駒: 盤上の駒は種類だけを持ち、数字は `RuleSet.values`、方向は `PIECES[kind].reach`。プリセット「方向駒」は体力 60・65
- 既存プリセットは 全方向・既定の数字・横角 0 個・上乗せなし。URL は方向駒・端の駒の項目を基準（v1.0）と違うときだけ載せる（既存の URL は不変）
- 隠し情報: 相手の王は UI・CPU から見えない API 境界（`viewFor` / `kingInfo`）
- プリセット v0.4 / v1.0 / v2 案は `sim/*.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・タップ 2 回で確定。盤の左右端の列の着手演出は `.edge-l` / `.edge-r` で内側に寄せる

## 未解決・次の一手

- [ ] ユーザーの試遊で CPU の強さの手応え（イージーで勝てるか・ハードが強すぎないか）とメニューの流れの感想を聞く。スマホ 2 台でオンラインの作成 → 参加も実機で確かめる
- [ ] 標準の王の指定期限 7 手（別ワーカー。体力・回復の再調整と合わせて）
- [ ] 本番 https://kyosho.rukiharukichi.com/ でメニューの「マルチ」に「オンライン（招待リンク）」が出ること、スマホ 2 台で作成 → 参加 → 終局・再読み込みを確かめる。確かめたら別タスクで GitHub Pages（`pages.yml`）を止める
- [ ] 必要ならサーバーに「終局後の相手の王の公開」「同じ部屋での再戦」を足す（ユーザーの判断）
- [ ] ユーザーの試遊で演出の手応え・方向駒・隠し王・拠点・オセロの枠の見やすさの感想を聞く。RULES.md 本文を標準で新版に改稿するかはユーザー判断

## 現フェーズで Read すべき設計書

- メニュー・設定メニュー・CPU の強さ: `web/src/ui/menu.ts`, `web/src/ui/setup.ts`, `web/src/ui/app.ts`（`showMenu` / `resume` / `leaveToMenu`）, `web/src/engine/cpu.ts`（`chooseMove`）

- 画面の見た目を直す: AGENTS.md の「デザイン規約」→ `web/src/style.css`（`:root` のトークン）, `web/index.html`, `web/src/ui/app.ts`（`placeSeats` / `renderPlayers` / `kingTag` / `bubble` / `setTab` / `renderScore`）

- オンライン対戦の画面の修正: `.agent/online-protocol.md`（「画面側の挙動」）→ `web/src/net/online.ts` → `web/src/ui/app.ts`（「オンライン対戦」節）, `web/src/ui/online.ts`, `web/e2e/online/`
- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」
- ダメージ・端の駒: `web/src/engine/board.ts`（`damageOf` / `anchorsOf`）, `web/test/anchor.test.ts`。方向駒: `board.ts`（`pieceLines`）, `test/direction.test.ts`。隠し王: `game.ts`（隠し王節）, `cpu.ts`, `test/king.test.ts`
- 演出・効果音・成績: `web/src/ui/impact.ts`, `web/src/ui/fx.ts`, `web/src/ui/sound.ts`, `web/test/impact.test.ts`, `web/e2e/impact.spec.ts`。決着の演出: `web/src/ui/outcome.ts`, `web/test/outcome.test.ts`, `web/e2e/result.spec.ts`
- 画面の修正: `web/src/ui/app.ts`（対局）, `web/src/ui/setup.ts`（設定メニュー）, `web/src/ui/menu.ts`（メニュー）, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-* / sp-* 、隠し王は *-king-*、方向駒は *-dir*、拠点は *-anchor*、演出は *-impact-*、決着は *-result-*、オンラインは *-online-*）
- デプロイ: `.github/workflows/pages.yml`（GitHub Pages。PR はテスト+ビルドのみ、main への push でデプロイ）、`.github/workflows/deploy.yml`（Cloudflare。Secret 登録済み = main へのマージで本番デプロイ）、`server/wrangler.jsonc`
