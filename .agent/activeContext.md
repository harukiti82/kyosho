# Active Context

> AI が**毎ターン上書き更新**する現在状態のスナップショット。過去ログは `progress.md`。

## 現在の対象

- 何を / どこを: 試遊版（`web/`）に、終局画面の前の決着の演出（勝利・敗北・引き分け・2 人対戦の先手／後手の勝ち）を追加した（ルール計算は不変。https://harukiti82.github.io/kyosho/）。その前に段階的なダメージ演出・効果音・成績、方向駒・拠点・隠し王を追加済み
- ステータス: 演出の手応えと、隠し王・方向駒・拠点のどの組み合わせを採るかのユーザー判断待ち（ルールの決定はユーザーがする）
- 最終更新: 2026-10-02

## 直近の観点・指摘

- 最重要要件は「ルールが一目で分かること」。ルールカードは設定から自動生成（`ui/ruletext.ts`、最大 8 行。7 行以上は `.denser`）。予測の赤枠＋ダメージ・回復、返されうる自駒の「!」、自分の王の赤い「!」、駒の方向アイコン、端の駒の青枠＋左下の「+数字」と内訳（返した駒 ＋ 端の金5 ＝ 7）を崩さない
- 決着の演出: 中身（種類・副題・接戦の励まし）は `ui/outcome.ts` の `outcomeOf`（DOM なし、接戦は自分の体力上限の `CLOSE_PERCENT`=10% 以下）。表示は `fx.ts` の `finale`（画面全体を覆いタップ／クリックで飛ばす）、音は `sound.ts` の `finale`、流れは `App.playFinale` / `endFinale`（Enter / Esc / スペースでも飛ばす）。最大 2.5 秒（`FINALE_MS` 2300）。負けたら終局画面の「再戦」を `.urge` で強調、励ましは `#result-cheer`
- 手応えの演出: 段階は `ui/impact.ts` の `tierOf`（合計（上乗せ・王の罰込み）÷ 受けた側の体力上限。5% / 10% / 20% は `TIER_THRESHOLDS`、王を返した手は特大）。演出は `ui/fx.ts`（`#fx` 層・transform / opacity のみ）、効果音は `ui/sound.ts`（Web Audio 合成・消音は localStorage）。大・特大は `App.fxLock` で入力と CPU を最大 1.5 秒待たせる。`src/ui/` で `Math.random` を使わない（e2e の鏡の対局がずれる）
- 端の駒の力: ダメージは `damageOf` ＝ `baseDamageOf` ＋ `anchorBonusOf`（返した列ごとの反対端 `Line.end` / `endAt`）。予測・警告・CPU はすべてこれを通す。`MoveEvent.anchors` は上乗せがあるときだけ
- プリセット「拠点」は方向駒＋上乗せ、体力 125・130（4000 局で先手 47.3%・平均 31.3 手）。隅の端の上乗せは全体の約 1%、隅を取った側の勝率は同じ手数の方向駒より低い（RULES.md「拠点」）
- 方向駒: 盤上の駒は種類だけを持ち、数字は `RuleSet.values`、方向は `PIECES[kind].reach`。プリセット「方向駒」は体力 60・65
- 既存プリセットは 全方向・既定の数字・横角 0 個・上乗せなし。URL は方向駒・端の駒の項目を既定値と違うときだけ載せる（既存の URL は不変）
- 隠し情報: 相手の王は UI・CPU から見えない API 境界（`viewFor` / `kingInfo`）
- プリセット v0.4 / v1.0 / v2 案は `sim/*.py` と全手一致（`npm test` の replay）。数値は勝手に変えない
- スマホ（幅 375px）で横スクロールなし・盤が最初の画面に収まる・タップ 2 回で確定。盤の左右端の列の着手演出は `.edge-l` / `.edge-r` で内側に寄せる

## 未解決・次の一手

- [ ] ユーザーの試遊で演出の手応え（段階の差・決着の演出の長さと派手さ・音量・テンポ・被弾の赤の強さ）を聞く。実機の音は未確認
- [ ] ユーザーの試遊で方向駒・隠し王・拠点の感想を聞く（青枠と内訳で「端の駒もダメージに効く」が分かるか、強い駒を置くリスクとリターンが感じられるか、人間が隅に金を置く戦術で拠点が強すぎにならないか）
- [ ] 採用する組み合わせが決まったら RULES.md を新版に改稿し、既定プリセットを切り替える

## 現フェーズで Read すべき設計書

- 設定項目・プリセットの変更: `RULES.md` の「Web 試遊版」節 → `web/src/engine/rules.ts` → AGENTS.md の「ルール・設定項目を変えるとき」
- ダメージ・端の駒: `web/src/engine/board.ts`（`damageOf` / `anchorsOf`）, `web/test/anchor.test.ts`。方向駒: `board.ts`（`pieceLines`）, `test/direction.test.ts`。隠し王: `game.ts`（隠し王節）, `cpu.ts`, `test/king.test.ts`
- 演出・効果音・成績: `web/src/ui/impact.ts`, `web/src/ui/fx.ts`, `web/src/ui/sound.ts`, `web/test/impact.test.ts`, `web/e2e/impact.spec.ts`。決着の演出: `web/src/ui/outcome.ts`, `web/test/outcome.test.ts`, `web/e2e/result.spec.ts`
- 画面の修正: `web/src/ui/app.ts`（対局）, `web/src/ui/setup.ts`（設定）, `web/src/style.css`, `web/index.html`

## 関連ファイル / リンク

- E2E のスクリーンショット: `web/screenshots/`（pc-* / sp-* 、隠し王は *-king-*、方向駒は *-dir*、拠点は *-anchor*、演出は *-impact-*、決着は *-result-*）
- デプロイ: `.github/workflows/pages.yml`（PR はテスト+ビルドのみ、main への push でデプロイ）
