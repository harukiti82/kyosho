# オンライン対戦: 通信仕様と設計

オンライン対戦の通信仕様・サーバーの設計・画面側の挙動。型と定数は `web/src/net/protocol.ts`（画面・サーバーが共通で import する）、サーバーは `server/`、画面の通信層は `web/src/net/online.ts`、画面は `web/src/ui/app.ts`（対局）と `web/src/ui/online.ts`（案内のダイアログ）。

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
{ "preset": "king", "hostSeat": "random" }                           // プリセットで作る
{ "rules": { /* RuleSet */ }, "hostSeat": "first", "turnSeconds": 45 } // 設定メニューで保存した組み合わせで作る
```

- `rules` と `preset` はどちらか一方だけ。`rules` は共有 URL と同じ基準（`ui/query.ts` の `decodeRules`）で検証し、型・範囲・列挙の外れ・欠けた項目が 1 つでもあれば 400 `bad_rules`（既定値には戻さない）。余計なキーは捨てる
- `hostSeat`: 作成者の席。`first`（先手）/ `second`（後手）/ `random`（既定。部屋を作るときに決める）
- `turnSeconds`: 1 手ごとの制限時間（秒）。`TURN_SECONDS`（0 / 20 / 45 / 90、0 は制限なし）のどれか。省略は 0（制限時間の入る前の画面・`scripts/play.mjs` と同じ）。それ以外（30・文字列・null など）は 400 `bad_rules`。e2e 用に `wrangler dev --var TEST_TURN_SECONDS:3` を渡したときだけ、その秒数も受ける（本番の `wrangler.jsonc` にはない）
- 応答の `token` は作成者の席のトークン。`you` は作成者の手番（0: 先手 / 1: 後手）
- `GET /api/rooms/:id` の応答 `RoomInfoResponse` は `roomId` / `phase` / `rules` / `turnSeconds` / `open`

## WebSocket のメッセージ

すべて JSON のテキスト 1 つ = 1 メッセージ。型は `protocol.ts` の `ClientMessage` / `ServerMessage`。

### クライアント → サーバー

| type | フィールド | いつ |
|---|---|---|
| `join` | `token?: string` | 接続直後に 1 回。`token` あり = その席に戻る（作成者の最初の接続もこちら）、なし = 空いている席に参加 |
| `move` | `r`, `c`（0〜7 の整数）, `kind`（`PieceKind`）, `king?: boolean`, `seq?: number` | 自分の手番に 1 手。`king: true` で置いた駒を自分の王にする（隠し王）。`seq` は手を考えた局面の棋譜の長さ（`view.history.length`）で、サーバーの局面と違えば `stale_move`（制限時間切れの自動の手と入れ違った手を、次の局面に打たない）。省略すると調べない |
| `pick` | `card`（`SkillId`） | スキルありのルールで、対局の前に 1 回。配られた 3 枚（`view.skills.sides[you].offer`）のどれか。両者が選ぶまで `move` は `illegal_move`。下の「スキル」 |
| `skill` | `id`（`SkillId`）, `kind?`（`PieceKind`。補充で戻す駒）, `to?`（`[行, 列]`。王の移し替えの移す先）, `seq?: number` | 自分の手番の頭（置く前）に 1 回。ゲージが満タンのとき。`seq` は `move` と同じ |
| `rematch` | `action`（`request` / `cancel` / `decline`）, `gameNo`（終わった対局の番号 = `state.gameNo`） | 終局後だけ。`request` は申し込み（相手が申し込み済みなら受けたことになり、次の対局が始まる）、`cancel` は自分の申し込みの取り消し、`decline` は相手の申し込みを断る。下の「再戦」 |
| `leave` | なし | 部屋を抜ける直前（メニューから別の対局を始めた・新しい部屋を作った）。相手に退室を知らせ、再戦の申し込みを取り下げる。送った後に接続を閉じる |
| （ping） | `{"type":"ping"}` という文字列そのもの（`PING_TEXT`） | 任意。`{"type":"pong"}` が返る。部屋の寿命は延びない |

- 1 メッセージは 1024 バイトまで（`MAX_MESSAGE_BYTES`）。バイナリは受け付けない

### サーバー → クライアント

| type | 中身 | いつ |
|---|---|---|
| `joined` | `roomId`, `you`（自分の手番）, `token` | join が通った直後（直後に `state` が続く）。`token` を保存する |
| `state` | `roomId`, `phase`, `gameNo`, `you`, `view`（`PlayerView`）, `opponent: { joined, online, left }`, `rematch`（`{ you, opponent } \| null`）, `record`（`MatchRecord`）, `clock`（`TurnClockInfo \| null`） | 自分の join・相手の参加・どちらかの手（時間切れの自動の手を含む）・相手の切断／復帰／退室・終局・再戦の申し込みと成立のたびに、各自に自分用の内容で |
| `error` | `code`（`WsErrorCode`）, `message` | 送ったメッセージが拒否されたとき（拒否されたメッセージを送った人にだけ） |

- `state` は毎回 `view` の全体を送る（差分ではない）。画面は受け取った `view` で描き直す。新しい手は `view.history` が伸びた分（`lastMoveOf(view)`）で分かるので、演出はそこから出す
- `phase`: `waiting`（相手の参加待ち）/ `playing` / `finished`（`view.result` に勝敗）
- `view` には engine の関数をそのまま使える: 手番は `view.turn === you`、自分の王は `view.myKing`、相手の王の公開情報は `view.oppKing`。合法手・予測（`legalCells` / `previewMove` など `GameState` を受ける関数）は `kings` を読まないので、`view` を渡してよい（型は `as unknown as GameState`。`kingInfo` だけは `kings` を読むので使わず、`view.myKing` を使う）
- パスは自動（engine の `settleTurn`）。相手がパスしたら、`view.history` の末尾に `pass` が入った `state` が届き、続けて自分の手番になる
- `gameNo`: この部屋の何局目か（1 始まり）。再戦が成立すると 1 増え、`you` は入れ替わった席、`view` は新しい対局になる
- `opponent.left`: 相手が `leave` で抜けた（同じトークンで戻ると `false`）。`online: false`（切断）とは別
- `rematch`: 終局中だけ `{ you, opponent }`（それぞれ `none` / `requested`（申し込み中）/ `declined`（相手の申し込みを断った））。対局中・待機中は `null`
- `record`: この部屋での通算の戦績 `{ wins, losses, draws }`（自分から見た数）。今の対局は終局した `state` から入る。再戦で席が入れ替わっても人に紐づく（下の「再戦」）
- `clock`: 制限時間のある部屋の対局中だけ `{ limitMs, remainingMs }`（手番の人の残り。送った時点の値で、猶予 `TURN_GRACE_MS` を含む）。制限なし・待機中・終局後は `null`。時間切れの自動の手は `view.history` の手に `timeout: true` が付く
- `seatDraw`: この対局の先手・後手を抽選で決めた（作成者の `hostSeat` が `random` の部屋の 1 局目）。画面はまだ手がないときに抽選の演出を出す。作成者が手番を指定した部屋と、再戦（`gameNo` 2 以上。抽選でなく入れ替え）は `false`。部屋の記録（`RoomRecord.drawn`）がない古い部屋も `false`

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
| `illegal_move` | engine が拒否した（置けない・持ち駒にない・王を指定できない・スキルのカードを選び終えていない など。`message` は engine の例外文） | 残る |
| `illegal_skill` | engine が拒否したカードの選択・スキルの使用（配られていないカード・選び直し・満タンでない・この手番で使った・補充できない駒・移せないマス など） | 残る |
| `game_over` | 終局後に手を送った | 残る |
| `stale_move` | 締め切りを過ぎてから手が届いた（先に自動の手を打って `state` を配った後に返す）・`seq` がサーバーの局面と違う | 残る |
| `stale_rematch` | 終局していないのに `rematch` を送った・`gameNo` が今の対局と違う（再戦が成立した後に届いた二重押し） | 残る |
| `opponent_left` | 退室した相手に再戦を申し込んだ | 残る |

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

`random` の部屋は `RoomRecord.drawn` を立て、1 局目の `state` に `seatDraw: true` を載せる。画面はそれを見て両者に抽選の演出（盤の石を投げ、上を向いた色が自分の席）を出す（結果は届いた `you` どおりで、画面では引き直さない）。演出の間（最大 1.9 秒）は画面が時計を止めて見せるので、サーバーは対局が始まったとき（2 人目の join）だけ先手の締め切りに `TOSS_GRACE_MS`（2 秒）を足す。

### 3 人目

観戦は作らず、拒否する。席が埋まった部屋にトークンなしで join すると `room_full` を送って閉じる（4003）。観戦にはどちらの王も含まない第三者用の見え方が要り、今回の範囲では作らない。

## 再戦（同じ部屋で次の対局）

終局後（`phase: "finished"`）、両者が同じ部屋のまま次の対局を始められる。

- **成立**: 一方が `request` を送り、もう一方も `request`（画面の「受ける」）を送ると成立する。両者がほぼ同時に申し込んでも、サーバーは 1 つずつ処理するので、後に届いた方が「受けた」ことになって 1 局だけ始まる
- **次の対局**: 同じルール（`rules`）・同じ制限時間（`turnMs`）で `createGame` し直す。**先手と後手を入れ替える**: 席はトークンの添字なので、`tokens` を `[後手, 先手]` に、接続ごとの席（attachment）を相手の席に入れ替え、作成者の席 `host` も入れ替える。トークンは変わらないので、保存したトークンで再接続すれば入れ替わった後の席に戻る（`joined.you` も新しい席）。`gameNo` を 1 増やし、申し込み・退室の印を消し、制限時間があれば新しい先手の時計を始める。両者に新しい `state`（`phase: "playing"`）が届く
- **通算の戦績**: 席でなく人（作成者・参加者）ごとに数える。作成者の席 `host` は再戦のたびに席と一緒に入れ替わるので、席 s の人は `s === host ? 作成者 : 参加者`。`nextGame` で終わった対局を `RoomRecord.record`（`{ wins: [作成者, 参加者], draws }`）に足してから捨て、`state.record` は記録の分に終局した今の対局を足して（`room.ts` の `tallyOf` / `recordFor`）各自の目線で送る。部屋の記録に入るので、切断・再接続・オブジェクトの退避でも残り、部屋が消えれば消える。部屋をまたいだ戦績は持たない
- **取り消す・断る**: `cancel` は自分の申し込みを消す。`decline` は相手の申し込みを消し、自分を `declined` にする（申し込んだ側には `rematch.opponent: "declined"` が届く）。どちらも次に誰かが申し込むまで残り、断った側・断られた側のどちらからでも申し込み直せる（申し込むと相手の `declined` は消える）
- **二重押し**: 申し込み中の `request`・申し込みがないときの `cancel` / `decline`・2 回目の `leave` は何もしない（`state` も届かない）。成立した後に届いた古い `request`（`gameNo` が前の対局）は `stale_rematch`（画面は何も出さない）
- **切断と再接続**: 申し込みは部屋の記録（`RoomRecord.rematch`）に保存するので、切断しても・オブジェクトが退避されても残る。トークンで戻ると、そのままの `rematch` が届く。相手が切断中でも申し込める
- **退室**: 画面は部屋を抜けるとき（メニューから別の対局・新しい部屋）に `leave` を送ってから閉じる。サーバーは `left` の印を付け、両者の申し込みを消して相手に `opponent.left: true` を配る。退室した相手への `request` は `opponent_left`。タブを閉じた・回線が切れただけでは `leave` は届かず、切断（`online: false`）として扱う（戻ってくるかもしれないので申し込みは残す）
- **隠し情報**: 前の対局の `GameState`（王の場所を含む）は新しい対局で置き換えて捨てる。各自に送るのは引き続き `viewFor(新しい対局, 自分)` だけ（`server/test/king.test.ts` が、前の対局と次の対局で相手の王の指定だけ違う 2 部屋で、自分に届くバイト列が一致することを検査）
- **後片付け**: 申し込み・取り消しなどの操作のたびに alarm を張り直す（終局後は 1 時間）。次の対局が始まれば対局中の扱い（24 時間、または手番の締め切り）
- **部屋の情報**: `GET /api/rooms/:id` の `phase` は次の対局が始まれば `playing`。席は埋まったまま（`open: false`）

## スキル

ルールの `skills` が `true` の部屋（プリセット「スキルあり」）。ルールは `RULES.md`「スキル」、engine は `game.ts` の「スキル」節と `skills.ts`。

- **配る**: 対局を作るたび（部屋の作成・再戦の成立）に `dealSkills`（乱数は `crypto.getRandomValues`）で各自に 3 枚。`view.skills.sides[you].offer` が自分の 3 枚。相手の配られたカードは送らない（`offer: []`）
- **選ぶ**: `pick` を engine の `pickSkill` で検証する。相手の選んだカードは、両者が選び終える（`view.skills.ready`）まで `card: null` で送る（後から選ぶ人が見て選べないように）。選び終えるまで手は受けず（`illegal_move`）、制限時間の時計も止める（`clock: null`）。両者が選んだら手番の時計を数え始める。つなぎ直すと、配られたカード・選んだカードがそのまま届く
- **使う**: `skill` を engine の `useSkill` で検証する（ゲージが満タン・この手番でまだ使っていない・効果ごとの条件）。手番は変わらないので時計はそのまま。両者に `state` が届き、`view.skills.armed` に使ったスキル（公開情報）。次の手の棋譜（`MoveEvent.skill`）に残る。強打・相手の鉄壁で変わったダメージは `MoveEvent.plain`（変わる前）と `shielded`
- **隠し情報**: 偵察で分かった相手の王は `GameState.kings[相手].seen` に、王の移し替えで移した先は `kings[自分].cell` に持つだけで、`viewFor` が使った本人にだけ見せる（偵察した人の `view.oppKing` は `{ candidates: [王のマス], scouted: true }`）。王の移し替えの棋譜・`armed` には移す先を入れない（`cands` は使った時点の自分の駒すべて = 公開されている盤の情報）。`server/test/skill.test.ts` が、移す先だけ違う 2 部屋で相手に届くバイト列が一致することを検査する
- **再戦**: 次の対局は配り直す（カード・ゲージは持ち越さない）

## 1 手の制限時間

部屋を作った人の `turnSeconds` で、手番が来るたびに（対局開始・どちらかの手・自動の手の後）サーバーが計り直す。

- **締め切り**: 手番が来た時刻 + 制限時間 + 猶予 `TURN_GRACE_MS`（1.5 秒）（席を抽選した部屋の 1 局目の最初の手番だけ、さらに抽選の演出の分 `TOSS_GRACE_MS`）。猶予は、画面が着手の演出（最大 1.5 秒）の間は時計を止めて見せることと、通信の遅れのため。部屋の記録（`RoomRecord`）に `turnMs` と `deadline`（エポックミリ秒。制限なし・対局中でないなら null）を持つ。制限時間の入る前に作った部屋はどちらもない（= 制限なし）
- **時間切れ**: 締め切りに alarm を張り、発火したら engine の `playTimeout`（手番の人の置ける手（マスと駒種の組）から一様に 1 つ選び、棋譜の手に `timeout: true`）で打って、両者に `state` を配る。乱数は `crypto.getRandomValues`。王は指定しないので、期限の手ならルールどおり置いた駒が自動で王になる（`kings` は送らない）。手が届いた時点で締め切りを過ぎていれば、alarm を待たずに先に自動の手を打ち、届いた手は `stale_move` で拒否する（二重に打たない）
- **alarm の使い分け**: alarm は 1 つしか張れないので、制限時間のある対局中は手番の締め切り、それ以外（待機中・制限なしの対局中・終局後）は放置で消す時刻（24 時間後・1 時間後）に張る。締め切りの前に起きた alarm は張り直すだけ
- **切断中**: 相手や自分が切断していても時間は進み、自動の手で対局が進む。**両者が切断した部屋も止めない**: 自動の手が続いて必ず終局し（毎手 空きマスが 1 つ埋まるので最大 60 手 × (90 + 1.5) 秒 ≒ 92 分）、終局後は既存のとおり 1 時間で消える。待機中（相手がまだいない）は時計がないので、24 時間の放置で消える
- **画面**: `state.clock` の `remainingMs` を受け取った時刻から数え（端末とサーバーの時計のずれを持ち込まない）、手番の人の名札に `min(limitMs, 残り)` を出す（猶予の間は制限時間のまま止まって見え、0 になる頃にサーバーが打つ）。画面では時間切れの手を打たない。`move` には `seq` を付ける。`stale_move` は自動の手の知らせ（棋譜の `timeout` からのトースト）が先に届いているので、重ねて出さない

## 再接続の手順

トークン（`joined.token`、作成者は `CreateRoomResponse.token` も同じ値）が席の鍵。

1. `joined` を受けたら `token` を部屋 ID ごとに保存する。**`sessionStorage` を推奨**（例: キー `kyosho:token:<roomId>`）。再読み込みでは残り、別タブでは共有しないので、作成者が自分の招待リンクを別タブで開いても別人として参加できる。端末をまたいだ復帰は対象外
2. 切断（close code が 4001 / 4003 / 4004 / 4010 以外）したら、少し待って（例: 1 秒・2 秒・4 秒…と最大 30 秒まで延ばす）WebSocket をつなぎ直し、`{type:"join", token}` を送る
3. `joined`（同じ `you`）と、最新の `state` が届く。画面は `state.view` で描き直す。切断中に相手が打っていても、それも反映済み
4. 相手には、切断で `opponent.online: false`、復帰で `true` の `state` が届く（「相手が切断中」の表示に使う）
5. `invalid_token`（4003）なら保存したトークンを捨てる。部屋が消えていれば `room_not_found`（4004）

同じトークンで別の接続が join すると、古い接続は 4001 で閉じる（席には常に 1 接続）。

## 画面側の挙動（`web/src`）

- **通信層** `net/online.ts`（DOM なし。`test/online.test.ts` が偽の WebSocket と時計で検査）: `checkHealth` / `createRoom` / `getRoomInfo`（HTTP）と `OnlineSession`（1 部屋への WebSocket。参加・トークンの保存・つなぎ直し・ping）。画面はイベント（`joined` / `state` / `error` / `conn` / `ended`）で描き直し、手は `sendMove` で送るだけ
- **入口**: 起動時に `GET /api/health` を 3 秒まで待ち、`{"ok":true}` が返ったときだけメニューの「マルチ」に「オンライン」（添え書き「招待リンク」）を、設定メニューの手番に自分の席（「オンライン」の行。部屋を作る側の席で、ランダム（既定）／先手／後手 = `hostSeat`）を出す（GitHub Pages・`vite preview` は 404 や画面の HTML が返るので出ない）。「オンライン」を押すとすぐ部屋を作る
- **部屋の作成**: 設定メニューで保存した組み合わせ（URL のクエリで開いたときはそのルール、どちらもなければ既定の「標準」）を常に `rules` で送る（プリセットと同じでも `preset` は使わない）。`rules` は RuleSet の全項目なので、画面の既定を変えても送る形式・サーバーの検証は変わらない。応答の `token` を保存してから WebSocket で join する。待機中は案内のダイアログに招待リンク（`?room=<id>`、コピー・`navigator.share` があれば共有）・自分の席・ルールを出し、`phase: "playing"` の state で閉じる
- **アドレス**: 部屋に入ったら `?room=<id>` にする（再読み込みで同じ部屋に戻る）。対局中にメニューを開いても部屋の URL のまま（設定メニューで保存してもアドレスを書き換えない。「対局に戻る」で盤・待機中の案内に戻り、接続は保つ）。部屋を抜けたらクエリを外す
- **招待リンクから開いた**: 保存したトークンがあれば（再読み込み）確認なしで席に戻る。なければ `GET /api/rooms/:id` でルールを出して「参加する」を待つ。`open: false` は満員（終局済みならその旨）、404 は部屋が見つからない、届かなければ「この公開先ではオンライン対戦を使えない」。この端末で作った部屋（localStorage `kyosho:created` に部屋 ID を最新 20 件。秘密ではない）なら「ここで参加すると相手の席に座る」と注意を出す
- **トークンの保存先**: `sessionStorage` の `kyosho:token:<roomId>`。再読み込みでは残り、別のタブ・別のウィンドウとは共有しないので、同じブラウザの別タブで招待リンクを開くと別人として参加する（1 台で 2 人分を試せる）。タブを閉じると席に戻れない（同じ部屋に入り直すには、もう一方が新しい部屋を作る）。タブの複製では sessionStorage が写るので同じ席を 2 つのタブで開けるが、後から join した方が残り、古い方は 4001 で閉じて「別のタブで開かれました」と「このタブで続ける」（押すと取り戻す）を出す
- **つなぎ直し**: 4001 / 4003 / 4004 / 4010 以外で切れたら 1・2・4・8・16・30 秒（以後 30 秒）待ってトークン付きで join し直す。画面に戻った（`visibilitychange`）・ネットにつながった（`online`）ときは待たずにつなぐ。25 秒ごとに ping（`PING_TEXT`、サーバーが自動応答するので部屋の寿命・課金は増えない）を送り、10 秒以内に何も届かなければ切れたとみなす。切れている間は盤の枠の下の縁（`#net`）に「再接続中…」、盤は操作できない
- **描画**: 届いた `view` を `GameState` として描く（`legalCells` / `previewMove` / `threatenedPieces` は `kings` を読まない）。棋譜が伸びた state だけ着手の演出・効果音・決着の演出を出し、接続の変化や復帰の state は描き直すだけ。接続・再読み込み直後の最初の state は過去の手を演出せず、終局済みなら決着の演出なしで終局画面を出す。大・特大の演出中に届いた手は演出の後に反映する
- **手**: 自分の手番・対局中・つながっている・前の手の返事待ちでないときだけ盤を操作でき、打ったら `move`（`seq` 付き）を送って「送信中…」。盤は state が届いたときに変わる（画面では手を適用しない）。拒否（`error`）は内容をトースト（`stale_move` は出さない）
- **制限時間**: 部屋を作るときに設定メニューの「1 手の時間」の「マルチ」（既定 45 秒）を `turnSeconds` で送る。招待・参加のダイアログに「1 手 N 秒」（`#room-time`）。対局中は手番の人の名札に時計（`#turn-clock`。相手の手番は相手の名札）。時間切れの手は棋譜に「（時間切れ・自動）」、トーストで「時間切れ。〜の手を（マス）に（駒）で自動で打ちました」
- **取られる駒の警告「!」**: 表示の設定（`Saved.threat`、既定はオフ）で、各自が自分の画面だけで切り替える（引き出しの `#btn-threat`）。サーバー・通信には載らない。待ったはオンラインにはない
- **スキル**: `view.skills.ready` が `false` の間はカードを選ぶダイアログ（`#skill-pick`。自分が選んだら「相手が選んでいます」）。選んだら `pick` を送り、両者が選んだ `state` でカードをトーストで知らせる。名札のカードを押す（`#skill-use`）と `skill` を送り、`armed` が入った `state` で（相手が使ったときも）演出する（`App.playSkillCast`）。補充は戻す駒、王の移し替えは盤で移す先を選んでから送る。偵察で分かった相手の王は盤に金の「王」の印（`.king-cand.scouted`）と名札のマス名
- **隠し王**: 王の情報は `kingInfo` を使わず、自分の王は `view.myKing`、相手の王は `view.oppKing`（返されたか・候補）だけ。相手の王の候補には盤で「?」の印と、相手の名札の王の欄に「候補N」（`#king-cands`、説明は title）を出す
- **接続の表示**: 盤の枠の下の縁の左（`#net`、色の点と短い文字）に「相手: 接続中」（緑）／「相手: 切断中」（赤。手番の表示 `#status` は「相手の接続が切れています」）／「相手を待っています」／「再接続中…」。相手の参加・切断・復帰はトーストでも知らせる
- **終わり方**: 4001 → 別のタブで開かれた、4004 → 部屋が見つからない、4010 → 期限切れ、4003 は直前の `error.code` で満員／席に戻れない（`invalid_token` は保存したトークンを消す）。どれも案内のダイアログに出し、メニューへ戻れる。終局後に部屋が片付けられた（4004 / 4010）ときは何も出さず、盤と結果をそのまま見せる
- **終局後**: 終局画面は CPU 対戦と同じく自分の目線（勝利／敗北の演出・自分の成績）。終局画面の下と、盤面を見ている間の駒台の場所に再戦のボタン（`App.rematchControls`、`data-rematch`）と状態の 1 文（`#result-rematch-note` / `#tray-rematch-note`）: 何もなし →「再戦」／申し込み中 →「再戦の返事待ち」と「取り消し」／申し込まれた →「相手から再戦の申し込み」と「断る」「受ける」／断られた →「再戦を断られました」と「再戦」／相手が退室 →「相手が退室しました」と「新しい部屋で再戦」（同じルール・今の自分の席（先手なら `first`）で部屋を作り直し、招待リンクを出す）。送ってから次の `state` が届くまでと、つながっていない間はボタンを押せない（二重押しを防ぐ）。終局画面を閉じているときは、申し込まれた・断られた・取り消された・退室をトーストでも知らせる
- **通算の戦績**: 終局画面の成績表に「通算」の行（各列はその人から見た「2勝1敗」、引き分けがあれば「1勝1敗1分」。`ui/outcome.ts` の `recordText`）。2 局目からは名札の名前の横にも小さく（`.plate-record`）
- **抽選の演出**: `state.seatDraw` が `true` で、`phase: "playing"`・まだ手がない state を、このタブで初めて受け取ったとき（参加者は最初の state、作成者は待機中から対局中に変わった state）に `App.playToss`。上を向く色は `you`。見たことは `sessionStorage` の `kyosho:toss:<roomId>` に残し、再読み込みでは出し直さない。メニューを開いている間に始まったら出さない。演出中は盤を操作できず、届いた相手の手は演出の後に反映する。相手の参加のトーストには席を書かない（演出で見せる）
- **再戦の成立**: `state.gameNo` が増えたら `App.startNextGame`: 前の対局の演出・終局画面・時計を片付けて、届いた `view` で描き直す（自分の名札は下のまま、席の色が入れ替わる）。トースト「再戦開始　あなたは先手」
- **部屋を抜ける**: `OnlineSession.close()` は参加済みなら `leave` を送ってから閉じる。「メニュー」を開くだけでは抜けない（接続を保ち「対局に戻る」で戻れる）。メニューから別の対局を始めた・新しい部屋を作ったときに抜ける
- **今のサーバーではできないこと**: 終局後の相手の王の答え合わせ（返されなかった相手の王は終局後も送られないので、終局画面では「非公開」）

## サーバーの設計

- **部屋 ID**: 16 バイトの乱数の base64url（22 文字、`ROOM_ID_PATTERN`）。Durable Object は `idFromName(roomId)` で引く。形式の違う ID では Durable Object を作らない
- **トークン**: 32 バイトの乱数の base64url（43 文字）。Durable Object の storage にだけ置き、比較は `crypto.subtle.timingSafeEqual`
- **保存**: 部屋の状態（ルール・`GameState`・席のトークン・作成者の席）を storage の `"room"` に 1 件で保存し、参加・手のたびに書く。オブジェクトが退避されてもコンストラクタで読み直す（`blockConcurrencyWhile`）。WebSocket は Hibernation API（`acceptWebSocket`）で受けるので、待っている間は課金されず、退避後も接続は残る。接続ごとの席は `serializeAttachment` に入れる
- **手の直列化**: 手の処理は storage の書き込みしか待たないので、Durable Object の入力ゲートで 1 手ずつ処理される（同時に届いた手が混ざらない）
- **後片付け**: 参加・手・復帰のたびに alarm を張り直す（待機中・対局中は 24 時間後 `ROOM_TTL_MS`、終局後は 1 時間後 `FINISHED_TTL_MS`。制限時間のある対局中は手番の締め切り。上の「1 手の制限時間」）。放置の alarm が発火した = それだけ放置されたので、接続を 4010 で閉じて storage を消す。ping では延びない
- **不正な入力**: 本文は 8 KB、WebSocket は 1024 バイトまで。JSON・形・範囲を検証してから engine に渡す（engine の例外は `illegal_move`、カードの選択・スキルの使用は `illegal_skill` に変える）。Worker の想定外の例外は 500 `internal`。join せずに待つ接続は 1 部屋 4 つまで（超えたら古いものから閉じる）
- **Origin**: 画面と同じオリジンだけを受ける（CSRF・他サイトからの WebSocket 乗っ取りの対策）。CORS のヘッダーは返さない
- **静的アセット**: `/api` の外は Workers の静的アセットが返す（無料・無制限で、Worker のリクエスト数にも数えない）。Worker の `fetch` は `/api` の外を受けたら Durable Object に触れずに 404 を返す

## ファイル

| ファイル | 中身 |
|---|---|
| `web/src/net/protocol.ts` | 通信仕様の型と定数（画面・サーバー共通） |
| `web/src/net/online.ts` | 画面の通信層（HTTP・WebSocket の接続・参加・トークン・つなぎ直し・ping）。テストは `web/test/online.test.ts` |
| `web/src/ui/online.ts` | 案内のダイアログ（作成中・招待リンクと待機・参加の確認・エラー） |
| `web/e2e/online/` | 2 つのブラウザで作成 → 参加 → 終局・再読み込み・隠し王の秘匿・エラー・切断・制限時間（`timer.spec.ts`）・同じ部屋での再戦（`rematch.spec.ts`）の e2e（`cd web && npm run e2e:online`、設定 `web/playwright.online.config.ts` が wrangler dev を :8790（`E2E_ONLINE_PORT` で変更可）で、`TEST_TURN_SECONDS` 付きで起こす） |
| `server/wrangler.jsonc` | Worker の設定: 静的アセット（`../web/dist`、`run_worker_first`）・Durable Object・`ALLOWED_ORIGINS`・独自ドメイン（`routes` の Custom Domain `kyosho.rukiharukichi.com`） |
| `server/src/index.ts` | Worker: `/api` の下のルーティング・Origin・部屋の作成 |
| `server/src/room.ts` | Durable Object `Room`: 参加・手の検証・配信・再接続・1 手の制限時間（締め切りと自動の手）・再戦（申し込み・成立で席の入れ替え）・退室・alarm |
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
