# オンライン対戦: 通信仕様と設計

画面（`web/src/ui`）からオンライン対戦を実装する人向け。型と定数は `web/src/net/protocol.ts`（画面からそのまま import する）、サーバーは `server/`。

## 全体像

- 1 つの Cloudflare Worker（`server/`、名前 `kyosho`）が、画面（`web/dist` の静的アセット）と API・WebSocket（`/api` の下）を**同じオリジン**で配信する。公開先は https://kyosho.rukiharukichi.com （Custom Domain。`kyosho.<アカウント>.workers.dev` でも同じ）。ルートの `rukiharukichi.com` は使わない
- `/api` と `/api/*` だけ Worker を先に通す（`wrangler.jsonc` の `assets.run_worker_first`）。それ以外は静的アセットが直接返し、Worker も Durable Object も起こさない。アセットにないパスだけ Worker に落ちて 404（テキスト）
- GitHub Pages（https://harukiti82.github.io/kyosho/）の公開版は移行が済むまで残すが、オンライン対戦はつながらない（`/api` がない・別オリジンは拒否）。オンラインモードの画面は、`/api/health` に届かなければオンラインの入口を出さない、などで Pages 版でも壊れないようにする
- 招待リンク方式。ログインなし。1 部屋 = 1 Durable Object（`server/src/room.ts`）
- 権威サーバー: クライアントは手（r, c, kind, king?）だけを送る。サーバーが `web/src/engine` の `playMove` で検証して適用し、各プレイヤーに `viewFor(state, そのプレイヤー)` を送る。engine はコピーせず import している（ルールを変えるとサーバーにも効く）
- 隠し王の真の状態（`GameState.kings`）は WebSocket に流さない。届く `view` は `PlayerView`（自分の王だけ `myKing.cell` で見える）

## エンドポイント

画面と同じオリジンの `/api` の下（`protocol.ts` の `API_PATH`）。画面からは絶対パスで呼ぶ（HTTP は ``fetch(`${API_PATH}/rooms`)``、WebSocket は ``new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PATH}/rooms/${roomId}/ws`)``）。サーバーの URL を設定値として持つ必要はない。末尾のスラッシュはあってもなくても同じ。

| メソッドとパス | 用途 | 成功 | 失敗 |
|---|---|---|---|
| `POST /api/rooms` | 部屋を作る。本文 `CreateRoomRequest`（`Content-Type: application/json`） | 201 `CreateRoomResponse` | 400 `bad_request`（JSON でない）/ 400 `bad_rules` / 413 `too_large`（8 KB 超） |
| `GET /api/rooms/:id` | 参加前にルール・状態を見る | 200 `RoomInfoResponse` | 404 `not_found` |
| `GET /api/rooms/:id/ws` | WebSocket（`wss://<画面のホスト>/api/rooms/:id/ws`） | 101 | 426 `upgrade_required`（WebSocket 以外） |
| `GET /api/health` | 死活確認 | 200 `{"ok":true}` | |
| `/api` の下のそれ以外 | | | 404 `not_found`（JSON） |

- HTTP のエラー本文は `HttpErrorBody`（`{ "error": { "code", "message" } }`）。`message` は日本語の説明で、画面の分岐には `code` を使う
- 存在しない部屋に WebSocket でつないだ場合も 101 で受けてから `error`（`room_not_found`）を送って閉じる（ブラウザの WebSocket は HTTP の応答コードを読めないため）
- Origin はリクエスト自身のオリジン（同一オリジン）を常に許可し、それ以外は `server/wrangler.jsonc` の `ALLOWED_ORIGINS`（本番は `https://kyosho.rukiharukichi.com` だけ。公開先を明示しているが、同一オリジンの判定でも通る）にあるものだけ。許可していない Origin は 403 `forbidden_origin`（WebSocket も）。Origin を付けないクライアント（スクリプト・curl）は通す。ローカルの `npm run dev` は `--var` でこれを `http://localhost:*` / `http://127.0.0.1:*` に置き換える（Vite の :5173 からプロキシ経由で来るため）
- CORS のヘッダーは返さない（同一オリジンなので要らない）。OPTIONS は 405

### POST /api/rooms の本文

```jsonc
{ "preset": "king", "hostSeat": "random" }         // プリセットで作る
{ "rules": { /* RuleSet */ }, "hostSeat": "first" } // 設定画面の組み合わせで作る
```

- `rules` と `preset` はどちらか一方だけ。`rules` は共有 URL と同じ基準（`ui/query.ts` の `decodeRules`）で検証し、型・範囲・列挙の外れ・欠けた項目が 1 つでもあれば 400 `bad_rules`（既定値には戻さない）。余計なキーは捨てる
- `hostSeat`: 作成者の席。`first`（先手）/ `second`（後手）/ `random`（既定。部屋を作るときに決める）
- 応答の `token` は作成者の席のトークン。`you` は作成者の手番（0: 先手 / 1: 後手）

## WebSocket のメッセージ

すべて JSON のテキスト 1 つ = 1 メッセージ。型は `protocol.ts` の `ClientMessage` / `ServerMessage`。

### クライアント → サーバー

| type | フィールド | いつ |
|---|---|---|
| `join` | `token?: string` | 接続直後に 1 回。`token` あり = その席に戻る（作成者の最初の接続もこちら）、なし = 空いている席に参加 |
| `move` | `r`, `c`（0〜7 の整数）, `kind`（`PieceKind`）, `king?: boolean` | 自分の手番に 1 手。`king: true` で置いた駒を自分の王にする（隠し王） |
| （ping） | `{"type":"ping"}` という文字列そのもの（`PING_TEXT`） | 任意。`{"type":"pong"}` が返る。部屋の寿命は延びない |

- 1 メッセージは 1024 バイトまで（`MAX_MESSAGE_BYTES`）。バイナリは受け付けない

### サーバー → クライアント

| type | 中身 | いつ |
|---|---|---|
| `joined` | `roomId`, `you`（自分の手番）, `token` | join が通った直後（直後に `state` が続く）。`token` を保存する |
| `state` | `roomId`, `phase`, `you`, `view`（`PlayerView`）, `opponent: { joined, online }` | 自分の join・相手の参加・どちらかの手・相手の切断／復帰・終局のたびに、各自に自分用の内容で |
| `error` | `code`（`WsErrorCode`）, `message` | 送ったメッセージが拒否されたとき（拒否されたメッセージを送った人にだけ） |

- `state` は毎回 `view` の全体を送る（差分ではない）。画面は受け取った `view` で描き直す。新しい手は `view.history` が伸びた分（`lastMoveOf(view)`）で分かるので、演出はそこから出す
- `phase`: `waiting`（相手の参加待ち）/ `playing` / `finished`（`view.result` に勝敗）
- `view` には engine の関数をそのまま使える: 手番は `view.turn === you`、自分の王は `view.myKing`、相手の王の公開情報は `view.oppKing`。合法手・予測（`legalCells` / `previewMove` など `GameState` を受ける関数）は `kings` を読まないので、`view` を渡してよい（型は `as unknown as GameState`。`kingInfo` だけは `kings` を読むので使わず、`view.myKing` を使う）
- パスは自動（engine の `settleTurn`）。相手がパスしたら、`view.history` の末尾に `pass` が入った `state` が届き、続けて自分の手番になる

### エラーの種類（`WsErrorCode`）

| code | 原因 | 接続 |
|---|---|---|
| `bad_json` | JSON として読めない | join 前なら閉じる |
| `bad_message` | 形が違う（type・型・範囲）、バイナリ | join 前なら閉じる |
| `too_large` | 1024 バイト超 | join 前なら閉じる |
| `not_joined` | join の前に join 以外を送った | 閉じる（4003） |
| `already_joined` | join 済みでもう一度 join | 残る |
| `room_not_found` | 部屋がない（期限切れで消えた・ID 違い） | 閉じる（4004） |
| `room_full` | 席が 2 つとも埋まっている（3 人目） | 閉じる（4003） |
| `invalid_token` | トークンがこの部屋の席と合わない | 閉じる（4003） |
| `waiting_opponent` | 相手の参加前に手を送った | 残る |
| `not_your_turn` | 相手の手番に手を送った | 残る |
| `illegal_move` | engine が拒否した（置けない・持ち駒にない・王を指定できない など。`message` は engine の例外文） | 残る |
| `game_over` | 終局後に手を送った | 残る |

拒否されたとき、部屋の状態は変わらない（`state` も届かない）。

### close code（`CLOSE`）

| code | 意味 | 画面の対応の例 |
|---|---|---|
| 4001 `replaced` | 同じ席に別の接続（別タブ・再読み込み）が join した。古い方を閉じる | 「別のタブで開かれました」。自動で再接続しない |
| 4003 `rejected` | join の失敗（`room_full` / `invalid_token` / `not_joined`）。直前に `error` が届く | `error.code` で表示を分ける |
| 4004 `notFound` | 部屋がない | 「部屋が見つかりません」 |
| 4010 `expired` | 放置で部屋が消えた | 「部屋の期限が切れました」 |
| それ以外（1006 など） | 通信が切れた | 再接続の手順へ |

## 接続から終局までの流れ

```
作成者                         サーバー                         参加者
POST /api/rooms {preset} ───▶ 201 {roomId, token, you}
（招待 URL に roomId を載せて相手に送る。token は作成者の端末にだけ保存）
WS /api/rooms/:id/ws
{type:join, token} ─────────▶ joined{you} → state{phase:waiting}
                                                    ◀──── GET /api/rooms/:id（ルールの確認。open=true）
                                                    ◀──── WS /api/rooms/:id/ws, {type:join}
                              joined{you, token} ────────▶（token を保存）
state{phase:playing} ◀─────── state{phase:playing} ──────▶
{type:move,…}（手番の人）───▶ playMove で検証
state（相手の手も入った view）◀─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶ state
…
state{phase:finished, view.result} ◀────────────────────────▶ 両者に届く
```

1. 作成者: `POST /api/rooms` → `roomId` と `token` を受け取り、`token` を保存する。招待 URL（例: `https://kyosho.rukiharukichi.com/?room=<roomId>`。`location.origin` から作る）を作って相手に送る
2. 作成者: WebSocket をつなぎ、`{type:"join", token}`。`joined` → `state`（`phase: "waiting"`、`opponent.joined: false`）
3. 参加者: 招待 URL を開いたら、`GET /api/rooms/:id` でルールを表示（`open: false` なら満員、404 なら部屋がない）。参加するなら WebSocket をつなぎ `{type:"join"}`。`joined` の `token` を保存する
4. 両者に `state`（`phase: "playing"`）が届く。手番の人（`view.turn === you`）が `move` を送り、両者に新しい `state` が届く
5. 終局すると、両者に `phase: "finished"` と `view.result`（`winner` / `reason` / `byDiscs`）入りの `state` が届く。以後の `move` は `game_over`

### 先手・後手の決め方

作成者の `hostSeat` で決める（既定は `random`: 部屋を作った時点でサーバーが乱数で決める）。参加者は残りの席。体力の初期値はプリセットで先手・後手が非対称なことがある（`rules.hp`）。

### 3 人目

観戦は作らず、拒否する。席が埋まった部屋にトークンなしで join すると `room_full` を送って閉じる（4003）。観戦にはどちらの王も含まない第三者用の見え方が要り、今回の範囲では作らない。

## 再接続の手順

トークン（`joined.token`、作成者は `CreateRoomResponse.token` も同じ値）が席の鍵。

1. `joined` を受けたら `token` を部屋 ID ごとに保存する。**`sessionStorage` を推奨**（例: キー `kyosho:token:<roomId>`）。再読み込みでは残り、別タブでは共有しないので、作成者が自分の招待リンクを別タブで開いても別人として参加できる。端末をまたいだ復帰は対象外
2. 切断（close code が 4001 / 4003 / 4004 / 4010 以外）したら、少し待って（例: 1 秒・2 秒・4 秒…と最大 30 秒まで延ばす）WebSocket をつなぎ直し、`{type:"join", token}` を送る
3. `joined`（同じ `you`）と、最新の `state` が届く。画面は `state.view` で描き直す。切断中に相手が打っていても、それも反映済み
4. 相手には、切断で `opponent.online: false`、復帰で `true` の `state` が届く（「相手が切断中」の表示に使う）
5. `invalid_token`（4003）なら保存したトークンを捨てる。部屋が消えていれば `room_not_found`（4004）

同じトークンで別の接続が join すると、古い接続は 4001 で閉じる（席には常に 1 接続）。

## サーバーの設計

- **部屋 ID**: 16 バイトの乱数の base64url（22 文字、`ROOM_ID_PATTERN`）。Durable Object は `idFromName(roomId)` で引く。形式の違う ID では Durable Object を作らない
- **トークン**: 32 バイトの乱数の base64url（43 文字）。Durable Object の storage にだけ置き、比較は `crypto.subtle.timingSafeEqual`
- **保存**: 部屋の状態（ルール・`GameState`・席のトークン・作成者の席）を storage の `"room"` に 1 件で保存し、参加・手のたびに書く。オブジェクトが退避されてもコンストラクタで読み直す（`blockConcurrencyWhile`）。WebSocket は Hibernation API（`acceptWebSocket`）で受けるので、待っている間は課金されず、退避後も接続は残る。接続ごとの席は `serializeAttachment` に入れる
- **手の直列化**: 手の処理は storage の書き込みしか待たないので、Durable Object の入力ゲートで 1 手ずつ処理される（同時に届いた手が混ざらない）
- **後片付け**: 参加・手・復帰のたびに alarm を張り直す（待機中・対局中は 24 時間後 `ROOM_TTL_MS`、終局後は 1 時間後 `FINISHED_TTL_MS`）。alarm が発火した = それだけ放置されたので、接続を 4010 で閉じて storage を消す。ping では延びない
- **不正な入力**: 本文は 8 KB、WebSocket は 1024 バイトまで。JSON・形・範囲を検証してから engine に渡す（engine の例外は `illegal_move` に変える）。Worker の想定外の例外は 500 `internal`。join せずに待つ接続は 1 部屋 4 つまで（超えたら古いものから閉じる）
- **Origin**: 画面と同じオリジンだけを受ける（CSRF・他サイトからの WebSocket 乗っ取りの対策）。CORS のヘッダーは返さない
- **静的アセット**: `/api` の外は Workers の静的アセットが返す（無料・無制限で、Worker のリクエスト数にも数えない）。Worker の `fetch` は `/api` の外を受けたら Durable Object に触れずに 404 を返す

## ファイル

| ファイル | 中身 |
|---|---|
| `web/src/net/protocol.ts` | 通信仕様の型と定数（画面・サーバー共通） |
| `server/wrangler.jsonc` | Worker の設定: 静的アセット（`../web/dist`、`run_worker_first`）・Durable Object・`ALLOWED_ORIGINS`・独自ドメイン（`routes` の Custom Domain `kyosho.rukiharukichi.com`） |
| `server/src/index.ts` | Worker: `/api` の下のルーティング・Origin・部屋の作成 |
| `server/src/room.ts` | Durable Object `Room`: 参加・手の検証・配信・再接続・alarm |
| `server/src/validate.ts` | 外部入力の検証（ルールは `ui/query.ts` の `encodeRules` / `decodeRules` を再利用） |
| `server/test/` | Workers ランタイム上のテスト（`@cloudflare/vitest-pool-workers`） |
| `server/scripts/play.mjs` | 動いている Worker に 2 クライアントで 1 局を通すスクリプト（引数はサイトのオリジン。`/` の画面も確かめる） |
| `web/vite.config.ts` | 開発時に Vite（:5173）が `/api` を wrangler dev（:8787）に渡すプロキシ |
| `.github/workflows/deploy.yml` | main への push で Cloudflare にデプロイ（Secret が未設定なら飛ばす）。PR はテストと `--dry-run` |

## コマンド（`server/` で実行）

| 用途 | コマンド |
|---|---|
| 依存のインストール | `npm ci` |
| 本番と同じ構成でローカル起動（web をビルドしてから :8787 で画面と `/api`） | `npm run dev` |
| 画面を直しながら開発（上を動かしたまま、別の端末で） | `cd ../web && npm run dev`（:5173、`/api` は :8787 へプロキシ） |
| 2 クライアントで 1 局を通す | `node scripts/play.mjs http://localhost:8787 king`（Vite 経由なら `http://localhost:5173`） |
| 型チェック（`wrangler types` で `worker-configuration.d.ts` を生成してから） | `npm run typecheck` |
| テスト | `npm test` |
| デプロイの確認（何も送らない） | `npm run deploy:check`（web のビルド → `wrangler deploy --dry-run`） |
| 本番デプロイ（Cloudflare へのログインが必要） | `npx wrangler login` → `npm run deploy`（web のビルド → `wrangler deploy`） |

- テストは vitest 4 で動かす（`@cloudflare/vitest-pool-workers` が vitest ^4.1 を要求するため。web は vitest 5 のまま）
- npm 11.4 では `npm install` が `Cannot read properties of null (reading 'edgesOut')` で落ちることがある。新しい npm（`npx npm@11.21.0 install …`）で入れる。`npm ci` は問題ない

## デプロイと無料枠の注意

- 独自ドメイン: `server/wrangler.jsonc` の `routes` に `kyosho.rukiharukichi.com`（`custom_domain: true`）を設定済み。次の本番デプロイで DNS レコードと証明書ができる。手順は README の「独自ドメイン（kyosho.rukiharukichi.com）」。ドメインを変えるときは `routes` と `ALLOWED_ORIGINS` の 2 か所
- CI（`deploy.yml`）の Secret: `CLOUDFLARE_API_TOKEN`（テンプレート「Edit Cloudflare Workers」、アカウントとゾーン `rukiharukichi.com` に絞る）、`CLOUDFLARE_ACCOUNT_ID`（任意）
- Durable Object は SQLite 版（`new_sqlite_classes`）。Workers の無料プランで使える
- 無料枠（2026 年時点の目安。最新は Cloudflare の料金表を確認）: Workers のリクエスト 10 万／日、Durable Object のリクエストと稼働時間・storage の行の書き込みにも日ごとの上限がある。1 局 = 手の数 ×（メッセージ 1 + storage 書き込み 2）程度なので、試遊の規模では収まる。WebSocket は Hibernation で待つので、つないだままでも待ち時間は課金されない
- 本番のログに URL が残っても困る情報は入れていない（トークンは WebSocket の本文で送る）
