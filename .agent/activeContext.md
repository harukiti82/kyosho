# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。
> 機能ごとの規約（通算・待った・「!」・遊び方・メニュー・CPU の強さ・見た目・抽選・オンライン）は AGENTS.md に集約。ここには AGENTS.md にない現在の要点だけを書く。

## 現在の対象

- 何を / どこを: アクセス解析。PR #47 で入れた読み込み（`ui/analytics.ts`）は外し、Cloudflare Web Analytics の自動セットアップ（エッジで差し込む・トークン `40c7c4c1…`）だけにした（ユーザーの判断。ダッシュボードは変えない）。README・AGENTS.md に「計測のコードを足さない」の注記。依頼元セッション（master）経由
- ステータス: 外す PR をマージ・本番反映。本番の計測スクリプトは自動セットアップの 1 つだけ
- 最終更新: 2026-10-13
- 前の対象: スキル練習（PR #46、本番反映済み）。入口の置き場所・一覧の札・運命の輪を補充に決めたことはユーザーの試遊の感想待ち
- メインの遊び方の流れ: 挟む〜予測を読む（スキルなしの要素）→ カードを選ぶ（配り直し）→ ゲージ → 強打を使う → 副将を置く → 副将を裏返す → 標準の実戦。カードごとの効果はスキル練習で教える
- 保存した設定: 旧標準のまま保存した設定は新しい標準に読み替える（保存の版 `v` のない保存だけ。PR #45、RULES.md に記載）

## スキルの要点

- 状態は `GameState.skills`（スキルなしのルールではキーなし）。隠し情報は `kings` の中（偵察 = `kings[相手].seen`、移し替えの先 = `kings[自分].cell`、巻き戻しで戻された王の指定 = `kings[相手].kept`）と `skills.undo`（巻き戻しで戻す局面。`viewFor` が消して `undoable` だけ見せる）
- 値: 偵察 24（罰 2 倍なし。Web 版の skill 2000 で決めた）・連続行動 42（2 手目半分）・運命の輪 36・巻き戻し 30・副将の罰 15（偵察で特定されていても同じ。罰 2 倍はユーザーの判断でやめた）・期限 7 手は sim.ts の final14b.json（偵察以外）。回復量（+4・+20）と溜めマス点（4・20）は final15.json、長さ（応急手当 40・大回復 180・補充 66）は Web 版の `skill 2000` で 52〜56% に入る最短（RULES.md「回復系の強化」）
- 副将（置き直し。2026-10-12 ユーザーの指示）: 王を決めた手から 7 手ごとの固定の窓で置き直す（`ViceState.list` の最後が今の副将、前の副将はふつうの駒）。相手に「いる」を見せるのは窓 k の分を「王の期限 ＋ 7k 手目」の後（置いた時期を漏らさない仮決め）。偵察（副将）は使った時点の今の副将を見せる（ユーザーの判断。置き直したかは偵察した人に分かる）。印は写しで、その副将の窓より後の窓を見せるまで残り、置き直された駒を返しても罰なし。CPU は返されないマスにしか副将を置かないので、特定した副将を返すのは 0.02 回/局。巻き戻しで相手の置き直しを戻したら前の副将に戻り、相手の次の駒が副将（kept）
- 仮置き（前から）: 巻き戻しで戻した応手で相手が王を決めていたら「相手が次に置く駒が王」。運命の輪は隠し王なしのルールでは 8 枚から引く
- 配り直しの仮置き（ユーザーに確認）: 鍵は選ぶ画面の見出しの行の右端に小さく（スマホで下の鍵が 2 行にならないよう）。相手が先に選んだ後も配り直せる。CPU の「弱いカード」は skillmix 2000 で 48.5% 未満の 5 枚（巻き戻し・大回復・偵察・鉄壁・応急手当）
- 運命の輪 10 枚: 長さは 36 のまま（skill 2000 で 32: 57.1% / 36: 55.2% / 40: 54.7%、52〜56% の最短）。skillmix 2000 は先手 46.7%。表は RULES.md「スキル」
- バランス（置き直し・体力 136・134）: `skillmix 2000` は先手 50.6%・平均 37.6 手。`skill 2000` はスキル側 51.2〜56.8%（全方向 56.8・鉄壁 56.4 が少し上、偵察 51.4・巻き戻し 51.2 が少し下）。体力の候補の表は RULES.md「スキルありの体力」

## 直近の観点・指摘

- 既定ルール: `DEFAULT_PRESET` = `skill`（表示名「標準」）。URL は `QUERY_BASE`（v1.0）からの差分で変えない（互換は `web/test/fixtures/query-compat.json`）。スキルなし（id `std`）の 2 手読み同士の先手勝率 49.5 ± 1.1%（RULES.md「Web 試遊版」節）。e2e はスキルを前提にしないなら `preset: "std"` を明示（`startGame` は選ぶ画面が黙って出たら例外）
- サーバーの不足（直していない。足すかはユーザーの判断）: 終局後も返されなかった相手の王が届かない（終局画面は「非公開」）
- オンラインの再戦: 同じ部屋で申し込み・受ける・断る・取り消し（`rematch`、`state.gameNo` / `state.rematch` / `opponent.left`）。成立で席のトークンを入れ替える（トークンは同じ）。相手が `leave` で抜けたら「新しい部屋で再戦」。タブを閉じただけ・回線切れは切断扱いで、申し込みは残る。通算（`state.record`）は人（作成者・参加者）ごとに数え、`host` で席を人に直す
- 体力の表示: エンジンの `hp` は決着の一手で負になる（sim と同じ。replay が突き合わせる）。画面に出す体力は `shownHp` を通す
- server/ は vitest 4（pool-workers の要件）。npm 11.4 は install で落ちるので `npx npm@11.21.0 install`。`worker-configuration.d.ts` は生成物（`npm run typecheck` / `test` の前に `wrangler types`）
- プリセット「拠点」は方向駒＋上乗せ、体力 125・130（RULES.md「拠点」）。v0.4 / v1.0 / v2 案は `sim/*.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・タップ 2 回で確定。盤の左右端の列の着手演出は `.edge-l` / `.edge-r` で内側に寄せる

## 未解決・次の一手

- [ ] アクセス解析: ダッシュボードの Web Analytics（自動セットアップのサイト）に本番の PV が出るかをユーザーに見てもらう
- [ ] スキル練習をユーザーに見てもらう（入口の置き場所・一覧の札の大きさ・1 枚 1 ステップで足りるか・運命の輪を補充に決めたこと）
- [ ] 遊び方の 1 本の流れ（16 ステップ）をユーザーに見てもらう。長さ（16 は多いか）・章を選ぶ段をなくしたこと・カードを選ぶステップは配り直しを必須にしたことを確認
- [ ] progress.md が 30 件を超えた: `progress-archive.md` への移送をユーザーに提案する

- [ ] スキル PR B（#43）はマージ済み。副将の見せ方（期限の後に「いる」だけ）と巻き戻しの仮置き・回復系の長さ（sim の 32・160・48 より長い）をユーザーに確認。巻き戻しの長さ 30 は試遊で調整
- [ ] ユーザーの試遊で待った（イージーだけ・3 回）と「!」の既定オフの手応えを聞く。既定オフで「ルールが一目で分かる」が損なわれていないか
- [ ] ユーザーにスマホの実機で G 案の見た目（直立の見出しの読みやすさ・挟む石・盤の格子と星）と、要点を大きくした説明文の読みやすさ（言い回し・補足の小ささ・ルールカードの長さ）を見てもらう
- [ ] ユーザーの試遊で「自動で王に」のステップ（手数 12 の局面から始まる・「数えるのは自分の手だけ」）と「反対側」の表記（吹き出しが 2 行になる場面）の手応えと、遊び方の分かりやすさ（ステップの順・目標の文・光と矢印の誘導・最後の実戦）の感想を聞く。初回にメニューで勧める強さ（今は「遊び方」の横のシアンの「おすすめ」だけ）もユーザー判断
- [ ] ユーザーの試遊で制限時間の長さ（ノーマル 45 秒・ハード 20 秒・マルチ 45 秒）と時計の見やすさ、CPU の強さの手応え（イージーで勝てるか・ハードが強すぎないか）とメニューの流れの感想を聞く。スマホ 2 台でオンラインの作成 → 参加も実機で確かめる
- [ ] ユーザーの試遊で 期限 7 手・回復 低い方−1 の標準の手応えを聞く（CPU の強さの差: ハード対ノーマル 72.0%・ノーマル対イージー 85.8%）
- [ ] 本番 https://kyosho.rukiharukichi.com/ でメニューの「マルチ」に「オンライン」が出ること、スマホ 2 台で作成 → 参加 → 終局・再読み込み・再戦と通算を確かめる。確かめたら別タスクで GitHub Pages（`pages.yml`）を止める。CPU 対戦・2 人対戦の通算（端末ごと）の見え方も試遊で聞く
- [ ] ユーザーの試遊で演出の手応え・方向駒・隠し王・拠点・オセロの枠の見やすさの感想を聞く。RULES.md 本文を標準で新版に改稿するかはユーザー判断

## 現フェーズで Read すべき設計書

- スキル: `RULES.md`「スキル」「副将」, `web/src/engine/skills.ts`, `web/src/engine/game.ts`（「副将」節・「スキル」節 `useSkill` / `applyEffect` / `takeBack` / `skillsAfterMove`）, `web/src/engine/skillcpu.ts`, `web/src/ui/skillui.ts`, `web/src/ui/app.ts`（「スキル」節）, `server/src/room.ts`（pick / skill）, `.agent/online-protocol.md`「スキル」, `web/test/skills.test.ts`, `server/test/skill.test.ts`, `web/e2e/skill.spec.ts`, `web/e2e/skill-vice.spec.ts`, `web/e2e/online/skill.spec.ts`
- 通算（CPU 対戦・2 人対戦）: `web/src/ui/record.ts`, `web/src/ui/app.ts`（`countResult` / `recordOf` / `plateRecord`）, `web/src/ui/setup.ts`（`showRecord`）, `web/test/record.test.ts`, `web/e2e/record.spec.ts`
- スキル練習: `web/src/ui/skilllessons.ts`（`SKILL_LESSONS` / `wheelRng` / `loadSkillDone`）, `web/src/ui/lessons.ts`（`Lesson` の `aim` / `wheel` / `then` / `reply`・`judgeUse`）, `web/src/ui/app.ts`（`openSkillLesson` / `lessonSolved` / `playReply`）, `web/src/ui/menu.ts`（`setSkillLessons`）, `web/test/skilllesson.test.ts`, `web/e2e/skill-tutorial.spec.ts`
- 遊び方: `web/src/ui/lessons.ts`（`LESSONS` / `readLegacy`）, `web/src/ui/coach.ts`, `web/src/ui/app.ts`（「遊び方（チュートリアル）」節 `openLesson` / `inStep`、`onCellClick`・`renderBoard` の誘導）, `web/test/lesson.test.ts`, `web/e2e/tutorial.spec.ts`
- 待った・「!」・制限時間: `web/src/ui/undo.ts`, `web/src/ui/app.ts`（`takeBack` / `initThreat` / `setThreat` / `syncClock` / `checkTimeout`）, `web/src/ui/setup.ts`（`Saved.threat`）, `web/src/ui/clock.ts`, `web/src/engine/game.ts`（`playTimeout`）, `server/src/room.ts`
- メニュー・設定メニュー・CPU の強さ: `web/src/ui/menu.ts`, `web/src/ui/setup.ts`, `web/src/ui/app.ts`（`showMenu` / `resume` / `leaveToMenu`）, `web/src/engine/cpu.ts`（`chooseMove`）
- 画面の見た目を直す: AGENTS.md の「デザイン規約」→ `web/src/style.css`（`:root` のトークン）, `web/index.html`, `web/src/ui/app.ts`（`placeSeats` / `renderPlayers` / `kingTag` / `bubble` / `setTab` / `renderScore`）, `web/src/ui/setup.ts`, `web/src/ui/menu.ts`
- オンライン対戦の画面の修正: `.agent/online-protocol.md`（「画面側の挙動」「再戦」）→ `web/src/net/online.ts` → `web/src/ui/app.ts`（「オンライン対戦」節）, `web/src/ui/online.ts`, `web/e2e/online/`
- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」。ダメージ・端の駒: `web/src/engine/board.ts`（`damageOf` / `anchorsOf`）, `web/test/anchor.test.ts`。方向駒: `board.ts`（`pieceLines`）, `test/direction.test.ts`。隠し王: `game.ts`（隠し王節）, `cpu.ts`, `test/king.test.ts`
- 演出・効果音・成績: `web/src/ui/impact.ts`, `web/src/ui/fx.ts`, `web/src/ui/sound.ts`, `web/test/impact.test.ts`, `web/e2e/impact.spec.ts`。決着の演出: `web/src/ui/outcome.ts`, `web/test/outcome.test.ts`, `web/e2e/result.spec.ts`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-* / sp-* 、隠し王は *-king-*、方向駒は *-dir*、拠点は *-anchor*、演出は *-impact-*、決着は *-result-*、オンラインは *-online-*、遊び方は *-tutorial-*、待ったは *-undo-*、「!」は *-threat-*、通算は *-record-*）。デプロイ: `.github/workflows/pages.yml`（GitHub Pages。PR はテスト+ビルドのみ、main への push でデプロイ）、`.github/workflows/deploy.yml`（Cloudflare。Secret 登録済み = main へのマージで本番デプロイ）、`server/wrangler.jsonc`
