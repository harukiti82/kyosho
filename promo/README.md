# 投稿用の素材と手順（itch.io・ふりーむ!）

挟将を投稿サイトに載せるための素材と、投稿の手順。アカウント作成と投稿そのものは作者が行う。
素材にはリバーシの商品名（メガハウスの登録商標）を使っていない。盤は「リバーシ」と書く。

## 中身

| ファイル | 大きさ | 使い道 |
|---|---|---|
| `text-ja.md` | | 日本語の紹介文（短い 1 行・本文・ふりーむ! 用の本文・遊び方の要点・操作・説明書） |
| `text-en.md` | | 英語の紹介文（itch.io 用。短い 1 行・本文・遊び方・操作） |
| `images/cover.png` | 630×500 | itch.io のカバー画像（一覧では 315×250 に縮む） |
| `images/icon-512.png` | 512×512 | 正方形のアイコン（ふりーむ! のアイコン・SNS のプロフィールなど） |
| `screenshots/pc-game.png` | 1440×960 | 対局中（予測の吹き出しとダメージ） |
| `screenshots/pc-cards.png` | 1440×960 | 対局の前に 3 枚からカードを選ぶ画面 |
| `screenshots/pc-result.png` | 1440×960 | 終局画面（勝敗と成績） |
| `screenshots/pc-tutorial.png` | 1440×960 | 遊び方（盤で打ちながら覚える） |
| `screenshots/pc-menu.png` | 1440×960 | メニュー |
| `screenshots/sp-game.png` | 780×1688 | スマホの対局中 |
| `screenshots/sp-menu.png` | 780×1688 | スマホのメニュー |
| `video/kyosho-play.mp4` | 1440×960・約 28 秒・無音 | プレイ動画（YouTube・X に上げる） |
| `video/kyosho-play.gif` | 640×427・10 秒 | 序盤の数手の GIF（itch.io のスクリーンショット欄に置ける） |
| `../web/public/ogp.png` | 1200×630 | URL を共有したときのカード（本番の `<head>` が指す） |

スクリーンショットの並べ順のおすすめ: pc-game → pc-cards → sp-game → pc-tutorial → pc-result（→ pc-menu・sp-menu）。

## 素材を作り直す

画面を変えたら撮り直す。CPU の乱数とカードの配りは種で固定しているので、毎回同じ対局になる（CPU イージー相手に勝つ 1 局）。

```sh
cd web
npm run promo              # ビルド → vite preview を起こして撮る（約 3 分）。E2E_PORT で preview のポートを変えられる
../promo/make-video.sh     # 録画した 1 局から見せ場をつないで mp4 と GIF を作る（ffmpeg を使う）
```

- 撮影のスクリプトは `web/capture/promo.spec.ts`（e2e とは別。`npm run e2e` では動かない）
- OGP とカバーの画像は `src/ogp.html` / `src/cover.html`（青い地・格子・挟む石。盤は録画と同じ対局の切り抜き）を撮ったもの
- `src/parts/`（録画の元・区間・盤の切り抜き）はコミットしない
- 録画中にスクリーンショットを撮ると動画が乱れるので、録画用と撮影用に同じ対局を 2 回打つ

## 投稿用の zip を作る

itch.io・ふりーむ! にはビルドした `web/dist` の中身を zip にして上げる（`index.html` が zip の一番上に来るように）。

```sh
cd web
npm run build
cd dist && zip -r ../../promo/kyosho-web.zip . && cd ..
```

`promo/kyosho-web.zip` はコミットしない（`.gitignore` 済み）。ゲームを更新したら作り直して上げ直す。

zip 版は本番（https://kyosho.rukiharukichi.com/ ）と次の点が違う。

- オンライン対戦とエンドレスマッチの入口が出ない（サーバー `/api` がないため。GitHub Pages 版と同じ。CPU 対戦・2 人対戦・遊び方・スキル練習はそのまま動く）
- 設定・進み具合・通算は投稿サイトのドメインのブラウザ保存に入り、本番とは別になる
- アクセス解析（Cloudflare）は数えない（本番のエッジで差し込むものなので zip には入らない）

## itch.io

### HTML ゲームとして上げるか、外部リンクにするか

**zip を HTML ゲームとして上げ、本文に本番の URL を書く**のをすすめる。

- HTML ゲームなら itch.io のページの中でそのまま遊べ、「ブラウザで遊べるゲーム」の一覧と検索に載る。外部リンクだけのページは遊ぶ前にサイトを移る必要があり、ブラウザゲームの一覧にも載らない
- zip 版にはオンライン対戦とエンドレスマッチがないので、本文の「Endless mode at …」「Online play … at https://kyosho.rukiharukichi.com/」で本番に案内する（itch.io は本文に URL を書いてよい）
- 弱み: ゲームを直すたびに zip を上げ直す必要がある（上げ忘れると本番と食い違う）

### 手順（Dashboard → Create new project）

| 画面の項目 | 入れる内容 |
|---|---|
| Title | `Kyosho` か `挟将（きょうしょう）`。英語圏にも見せるなら `Kyosho` |
| Project URL | `kyosho`（ページの URL になる） |
| Short description or tagline | `text-en.md` の「Short description」 |
| Classification | Games |
| Kind of project | HTML |
| Release status | Released（まだ調整中なら In development） |
| Pricing | No payments（無料。投げ銭を受けるなら Donate） |
| Uploads | `kyosho-web.zip` を上げ、「This file will be played in the browser」に印 |
| Embed options | 「Click to launch in fullscreen」を選ぶ（PC の画面は縦に約 900px 要るので、ページ内の小さな枠では窮屈になる。画面の大きさに合わせて並びが変わる作り）。Mobile friendly に印、Orientation は Portrait |
| Details → Description | `text-en.md` の Description・How to play・Controls。日本語も載せるなら下に `text-ja.md` の本文を続ける |
| Genre | Strategy |
| Tags | `board-game`, `strategy`, `turn-based`, `2-player`, `local-multiplayer`, `singleplayer`, `japanese`, `card-game`（10 個まで） |
| AI generation disclosure | 正直に答える（コードと紹介文は AI の手を借りて書いた。画像はゲーム画面と自作の SVG・CSS から作ったもので、生成 AI の画像ではない） |
| Custom noun | 空欄のまま |
| Community | Comments（感想を集めるなら） |
| Visibility & access | 最初は Draft で保存し、プレビューで遊べることを確かめてから Public |
| Cover image | `images/cover.png` |
| Gameplay video or trailer | `video/kyosho-play.mp4` を YouTube に上げ、その URL（itch.io は YouTube か Vimeo の URL だけ） |
| Screenshots | `screenshots/` から 3〜5 枚と `video/kyosho-play.gif`（並べ順は上のおすすめ） |

保存したら「View page」で開き、「Run game」で起動 → メニュー → CPU対戦 → カードを選んで数手打つ、をスマホでも確かめる。

## ふりーむ!

### 先に確かめること

- **自作の HTML5 ゲームを「ブラウザゲーム」で受け付けているか**。ふりーむ! の案内ページ（https://www.freem.ne.jp/special/project/24 ）には「RPGツクールMV・ティラノスクリプト・ティラノビルダーのブラウザ出力に対応。他のツールや完全オリジナルのプログラムは未対応」とある（掲載日は書かれていない）。クリエイターズセントラルの投稿画面か問い合わせで、今も同じかを確かめてから進める。受け付けていなければ、ふりーむ! への投稿は見送る
- **紹介文に URL や他のサイトへの誘導を書けない**（コンテンツガイドライン https://www.freem.ne.jp/information/policy_contents_guideline ）。本文は `text-ja.md` の「ふりーむ! 用」（本番の URL とオンライン対戦の項を外したもの）を使う
- **外部と通信するブラウザゲームは載らない**。zip 版は外部のサーバーと通信しない（フォントも CDN を使わない）。ただしオンライン対戦の入口を出すかを決めるため、起動時に置かれたサーバーの `/api/health` を 1 回だけ確かめる（ふりーむ! のサーバーでは 404 になり、入口は出ない）。審査で問われたらそう答える

### 手順（クリエイターズセントラル → ゲーム登録）

ログインしないと投稿画面を見られないため、下の項目名は公開されている案内から拾ったもの。画面の表記が違えば読み替える。

| 画面の項目（推定） | 入れる内容 |
|---|---|
| 種類（プラットフォーム） | ブラウザゲーム |
| タイトル | 挟将（きょうしょう）。ゲームの画面の表記「挟将」と揃える |
| バージョン | 1.0 |
| レーティング | 全年齢 |
| ジャンル | テーブルゲーム（なければボードゲーム・その他） |
| キャッチコピー | `text-ja.md` の「短い 1 行」 |
| ゲーム紹介文 | `text-ja.md` の「本文（ふりーむ! 用）」（URL を入れない） |
| 説明書（ReadMe） | `text-ja.md` の「説明書」のコードブロックの中身（制作者名とゲーム名を必ず書く決まり。制作者名は個人サイトのハンドル rukiharukichi にしてある。変えるならここも） |
| ゲームファイル | `kyosho-web.zip`（ファイル名は半角英数字・`-`・`_`・`.` で 50 字まで） |
| アイコン | `images/icon-512.png` |
| スクリーンショット | `screenshots/` から pc-game・pc-cards・sp-game・pc-tutorial（刺激の少ない画像に限る決まりがあるが、どれも盤と文字だけ） |
| サムネイル | 求められたら `images/cover.png`（大きさの指定があれば合わせて撮り直す。`src/cover.html` の大きさを変えて `npm run promo`） |

登録 → 確認画面 → 完了の後、審査がある。通るまで数日かかることがある。

## 共有のカード（OGP）

本番の `<head>` に og:title・og:description・og:image（`https://kyosho.rukiharukichi.com/ogp.png`、1200×630）・og:url・twitter:card（summary_large_image）がある。
GitHub Pages 版（https://harukiti82.github.io/kyosho/ ）も同じ `<head>` で、カードの画像と URL は本番を指す（共有されたら本番に案内する）。

X に URL を貼ったときのカードは、投稿の下書きに URL を貼るとプレビューで見られる。画像を差し替えた直後は X 側のキャッシュで古い画像が出ることがある。
