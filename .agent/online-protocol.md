# オンライン対戦: 通信仕様と設計

オンライン対戦の通信仕様・サーバーの設計・画面側の挙動。型と定数は `web/src/net/protocol.ts`（画面・サーバーが共通で import する）、サーバーは `server/`、画面の通信層は `web/src/net/online.ts`、画面は `web/src/ui/app.ts`（対局）と `web/src/ui/online.ts`（案内のダイアログ）。

## 全体像

- 1 つの Cloudflare Worker（`server/`、名前 `kyosho`）が、画面（`web/dist` の静的アセット）と API・WebSocket（`/api` の下）を**同じオリジン**で配信する。公開先は https://kyosho.rukiharukichi.com （Custom Domain。`kyosho.<アカウント>.workers.dev` でも同じ）。ルートの `rukiharukichi.com` は使わない
- `/api` と `/api/*` だけ Worker を先に通す（`wrangler.jsonc` の `assets.run_worker_first`）。それ以外は静的アセットが直接返し、Worker も Durable Object も起こさない。アセットにないパスだけ Worker に落ちて 404（テキスト）
- GitHub Pages（https://harukiti82.github.io/kyosho/）の公開版は移行が済むまで残すが、オンライン対戦はつながらない（`/api` がない・別オリジンは拒否）。オンラインモードの画面は、`/api/health` に届かなければオンラインの入口を出さない、などで Pages 版でも壊れないようにする
- 招待リンク方式と合言葉（同じ合言葉を入れた 2 人を同じ部屋にする。下の「合言葉」）。ログインなし。1 部屋 = 1 Durable Object（`server/src/room.ts`）、合言葉の受付は合言葉ごとに 1 つの Durable Object（`server/src/lobby.ts`）
- 権威サーバー: クライアントは手（r, c, kind, king?）だけを送る。サーバーが `web/src/engine` の `playMove` で検証して適用し、各プレイヤーに `viewFor(state, そのプレイヤー)` を送る。engine はコピーせず import している（ルールを変えるとサーバーにも効く）
- 隠し王の真の状態（`GameState.kings`）は WebSocket に流さない。届く `view` は `PlayerView`（自分の王だけ `myKing.cell` で見える）

## エンドポイント

画面と同じオリジンの `/api` の下（`protocol.ts` の `API_PATH`）。画面からは絶対パスで呼ぶ（HTTP は ``fetch(`${API_PATH}/rooms`)``、WebSocket は ``new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PATH}/rooms/${roomId}/ws`)``）。サーバーの URL を設定値として持つ必要はない。末尾のスラッシュはあってもなくても同じ。

| メソッドとパス | 用途 | 成功 | 失敗 |
|---|---|---|---|
| `POST /api/rooms` | 部屋を作る。本文 `CreateRoomRequest`（`Content-Type: application/json`） | 201 `CreateRoomResponse` | 400 `bad_request`（JSON でない）/ 400 `bad_rules` / 413 `too_large`（8 KB 超） |
| `POST /api/match` | 合言葉で待っている部屋を探し、なければ作る。本文 `MatchRequest`（`CreateRoomRequest` ＋ `phrase`） | 201 `MatchResponse`（`status: "wait"`。作った）/ 200（`status: "join"`。待っている部屋がある） | 400 `bad_phrase` / 400 `bad_rules` / 400 `bad_request` / 413 `too_large` / 429 `too_many_requests` |
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

### 合言葉（POST /api/match）

```jsonc
{ "phrase": "あいことば", "rules": { /* RuleSet */ }, "hostSeat": "random", "turnSeconds": 45 }
// 201: { "status": "wait", "roomId": "…", "token": "…", "you": 0 }     待っている部屋がなかったので作った（作成者）
// 200: { "status": "join", "roomId": "…", "rules": { … }, "turnSeconds": 45 }  待っている部屋がある（ルールを見せてからトークンなしで join）
```

- **正規化**（`web/src/net/phrase.ts` の `normalizePhrase`。画面とサーバーが共通で使う）: NFKC → 制御文字・書式文字（ゼロ幅の空白など）・単独のサロゲート・行と段落の区切りがあれば不正 → 英字を小文字 → 連続する空白を 1 つ → 前後の空白を除く。正規化した後の長さが 1〜20 字（`PHRASE_MAX`。サロゲートペアは 1 字）。全角と半角、大文字と小文字、空白の数の違いは同じ合言葉。外れたら 400 `bad_phrase`。ほかの項目は `POST /api/rooms` と同じ検証（`bad_rules`）
- **受付**: Worker が正規化した合言葉の SHA-256（`kyosho:phrase:` を前に付けた 16 進）から `idFromName` で受付の Durable Object（`Lobby`）を引く。受付は待っている部屋の ID を 1 つだけ storage に持つ（合言葉そのものは持たない）
- **最初の人**: 待っている部屋がなければ、送られたルール・`hostSeat`・`turnSeconds` で部屋を作り（`Room.create` の `phrase: true`）、その ID を覚えて 201 `wait`。応答は `CreateRoomResponse` と同じ（トークンを保存して join する）
- **2 人目**: 覚えた部屋が待っていれば（部屋の `matchInfo`）、その部屋のルールと制限時間を 200 `join` で返す。画面は招待リンクと同じ参加の確認を出し、トークンなしの join で参加する
- **待っている**とは: 合言葉の部屋（`RoomRecord.phrase`）・席が空いている（`phase: "waiting"`）・作成者が `leave` で抜けていない・作成者の WebSocket がつながっている。部屋を作ってから作成者が一度もつないでいない間は `PHRASE_CONNECT_GRACE_MS`（10 秒）だけ、つながっていなくても待っているとみなす（作成の応答から join までの間に来た人を別の部屋に分けない）
- **空く**: 2 人がそろった・作成者が抜けた・閉じた（切断）・部屋が消えた部屋は待っていないので、次に来た人は新しい部屋を作って待つ（受付の覚える部屋が置き換わる）。そろったかどうかは次の人が来たときに部屋へ聞くので、部屋から受付へは何も送らない。受付の記録は最後に部屋を作ってから 24 時間（`ROOM_TTL_MS`）の alarm で消す
- **同時**: 受付は要求を 1 件ずつ順に処理する（部屋への問い合わせ・作成は別の Durable Object への呼び出しで、その間は入力ゲートが開いて次の要求が割り込めるので、メモリの Promise の列で直列にする）。ほぼ同時に来た 2 人は、先の 1 人が部屋を作り、後の人はその部屋への `join` を受け取る
- **参加の確認の間に席が埋まった・作成者がいなくなった**: 同じ部屋の `join` を受け取った人が複数いれば、先に join した人が座り、後の人は `room_full`（4003）。合言葉の部屋で作成者がいない（上の「待っている」でない）ときのトークンなしの join は `room_not_found`（4004）で断る（ひとりの部屋に座らせない）。画面はどちらも同じ合言葉で探し直す（最大 2 回）
- **自分自身**: 同じブラウザの別のタブで同じ合言葉を入れるとつながる（トークンは sessionStorage でタブごとなので別人として参加する。招待リンクを自分で開いたときと同じ）。参加の確認に「このブラウザで待っている部屋」の注意（`#join-own`）を出す
- **送りすぎ**: 接続元（`CF-Connecting-IP`）ごとに `MATCH_WINDOW_MS`（1 分）に `MATCH_LIMIT`（20）回まで。超えると 429 `too_many_requests`。合言葉が不正な要求も数える。Worker のインスタンスのメモリで数える軽い制限で、インスタンスをまたいだ合計は数えない（覚える接続元は 1 万まで）。`CF-Connecting-IP` がない（テスト）なら数えない。wrangler dev ではどのブラウザも同じ接続元になるので、オンラインの e2e は `--var TEST_MATCH_LIMIT:1000` で上限を上げる（本番の `wrangler.jsonc` にはない）。受付・部屋の Durable Object は検証と制限を通った要求でだけ起こす
- **合言葉を外に出さない**: 合言葉は本文だけで送り（URL に載せない）、サーバーはログ・storage・応答・WebSocket のメッセージに入れない（`server/test/phrase.test.ts` が検査する）。待っている本人の画面は合言葉を `sessionStorage` の `kyosho:phrase:<roomId>` に残して出す（再読み込みしても出る）

## 名前

設定メニュー・メニューの名札・オンライン対戦の前の案内で決めた名前（`Saved.name`。画面の仕組みは AGENTS.md の「プレイヤーの名前」）を、部屋に入るときの `join` に付けて送る。アカウントはない。

- **検証**（`web/src/net/name.ts` の `normalizeName`。画面とサーバーが共通で使う）: NFC → 合言葉と同じ使えない文字（制御文字・書式文字＝ゼロ幅の空白や右から左の書式・単独のサロゲート・行と段落の区切り。`phrase.ts` の `FORBIDDEN`）と、4 つ以上続く結合文字があれば不正 → 連続する空白を 1 つの半角の空白 → 前後の空白を除く。長さは 0〜10 字（`NAME_MAX`。サロゲートペアは 1 字）。空は名前なし。合言葉と違って NFKC・小文字にはしない（決めた字のまま見せる）
- **サーバー**（`server/src/validate.ts`）: `join` の `name` を `normalizeName` で検証し、通った空でない名前だけを `JoinMessage.name` に載せる。不正な名前（長すぎる・使えない文字・文字列でない）は**エラーにせず名前なし**として参加させる（参加を断ると、前の画面や壊れた保存の人が入れなくなる）。名前を送らない古い画面もそのまま参加できる
- **部屋の中**（`server/src/room.ts`）: 名前は人（作成者・参加者）ごとに `RoomRecord.names`（`[作成者, 参加者]`、名前の入る前の部屋にはない）に持ち、その人が最初に名前を送った `join` で決める。つなぎ直しで別の名前を送っても変えない（設定で名前を変えたら次の部屋から）。再戦で席が入れ替わっても人に付いて回る（`host` で席を人に直す）。部屋ごとの Durable Object にだけあるので、別の部屋に漏れない。部屋が消えるときに一緒に消える
- **届け方**: `state.name`（自分の名前。相手の画面に出る名前）と `state.opponent.name`（相手の名前。相手が参加するまで null）。画面は名札・終局画面に `textContent` でだけ出す（HTML として読まない）。名前なしは今までどおり「あなた」「相手」

## WebSocket のメッセージ

すべて JSON のテキスト 1 つ = 1 メッセージ。型は `protocol.ts` の `ClientMessage` / `ServerMessage`。

### クライアント → サーバー

| type | フィールド | いつ |
|---|---|---|
| `join` | `token?: string`, `name?: string` | 接続直後に 1 回。`token` あり = その席に戻る（作成者の最初の接続もこちら）、なし = 空いている席に参加。`name` は自分の名前（下の「名前」。省略は名前なし） |
| `move` | `r`, `c`（0〜7 の整数）, `kind`（`PieceKind`）, `king?: boolean`, `vice?: boolean`, `seq?: number` | 自分の手番に 1 手。`king: true` で置いた駒を自分の王にする（隠し王）。`vice: true` で置いた駒を自分の副将にする（スキルありで隠し王ありの部屋の、副将を出す期間。下の「スキル」）。`seq` は手を考えた局面の棋譜の長さ（`view.history.length`）で、サーバーの局面と違えば `stale_move`（制限時間切れの自動の手と入れ違った手を、次の局面に打たない）。省略すると調べない |
| `pick` | `card`（`SkillId`） | スキルありのルールで、対局の前に 1 回。配られた 3 枚（`view.skills.sides[you].offer`）のどれか。両者が選ぶまで `move` は `illegal_move`。下の「スキル」 |
| `reroll` | なし | スキルありのルールで、選ぶ前に 1 局 1 回。配られた 3 枚を配り直す（新しい `state` は送り主にだけ届く）。下の「スキル」の「配り直し」 |
| `skill` | `id`（`SkillId`）, `kind?`（`PieceKind`。補充で戻す駒）, `to?`（`[行, 列]`。王の移し替えの移す先）, `seq?: number` | 自分の手番の頭（置く前）に 1 回。ゲージが満タンのとき。`seq` は `move` と同じ |
| `rematch` | `action`（`request` / `cancel` / `decline`）, `gameNo`（終わった対局の番号 = `state.gameNo`） | 終局後だけ。`request` は申し込み（相手が申し込み済みなら受けたことになり、次の対局が始まる）、`cancel` は自分の申し込みの取り消し、`decline` は相手の申し込みを断る。下の「再戦」 |
| `leave` | なし | 部屋を抜ける直前（メニューから別の対局を始めた・新しい部屋を作った）。相手に退室を知らせ、再戦の申し込みを取り下げる。送った後に接続を閉じる |
| （ping） | `{"type":"ping"}` という文字列そのもの（`PING_TEXT`） | 任意。`{"type":"pong"}` が返る。部屋の寿命は延びない |

- 1 メッセージは 1024 バイトまで（`MAX_MESSAGE_BYTES`）。バイナリは受け付けない

### サーバー → クライアント

| type | 中身 | いつ |
|---|---|---|
| `joined` | `roomId`, `you`（自分の手番）, `token` | join が通った直後（直後に `state` が続く）。`token` を保存する |
| `state` | `roomId`, `phase`, `gameNo`, `you`, `name`（サーバーが受け付けた自分の名前 \| null）, `view`（`PlayerView`）, `opponent: { joined, online, left, name }`（`name` は相手の名前 \| null）, `rematch`（`{ you, opponent } \| null`）, `record`（`MatchRecord`）, `clock`（`TurnClockInfo \| null`） | 自分の join・相手の参加・どちらかの手（時間切れの自動の手を含む）・相手の切断／復帰／退室・終局・再戦の申し込みと成立のたびに、各自に自分用の内容で |
| `error` | `code`（`WsErrorCode`）, `message` | 送ったメッセージが拒否されたとき（拒否されたメッセージを送った人にだけ） |

- `state` は毎回 `view` の全体を送る（差分ではない）。画面は受け取った `view` で描き直す。新しい手は `view.history` が伸びた分（`lastMoveOf(view)`）で分かるので、演出はそこから出す
- `phase`: `waiting`（相手の参加待ち）/ `playing` / `finished`（`view.result` に勝敗）
- `view` には engine の関数をそのまま使える: 手番は `view.turn === you`、自分の王は `view.myKing`、相手の王の公開情報は `view.oppKing`、自分の副将は `view.myVice`、相手の副将について分かることは `view.oppVice`。合法手・予測（`legalCells` / `previewMove` など `GameState` を受ける関数）は `kings` を読まないので、`view` を渡してよい（型は `as unknown as GameState`。`kingInfo` だけは `kings` を読むので使わず、`view.myKing` を使う）
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
| `illegal_skill` | engine が拒否したカードの選択・スキルの使用（配られていないカード・選び直し・満タンでない・この手番で使った・補充できない駒・移せないマス・戻す手がない（巻き戻し）・相手の副将が未定か特定済み（偵察） など） | 残る |
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
- **使う**: `skill` を engine の `useSkill` で検証する（ゲージが満タン・この手番でまだ使っていない・効果ごとの条件）。手番は変わらないので時計はそのまま。両者に `state` が届き、`view.skills.armed` に使ったスキル（公開情報）。次の手の棋譜（`MoveEvent.skill`）に残る。強打・相手の鉄壁・連続行動の 2 手目で変わったダメージは `MoveEvent.plain`（変わる前）と `shielded` / `second`
- **配り直し**: 選ぶ前に `{ "type": "reroll" }` を送ると、サーバーの crypto で配られていた 3 枚を除いた残りから 3 枚を引き直す（engine の `rerollSkills`。1 局 1 回で、2 回目・選んだ後・スキルなしの部屋は `illegal_skill`）。新しい `state` は送り主にだけ送り（`broadcast` の `only`）、相手には何も送らない（配り直したことを知らせない）。自分の view の `skills.sides[自分].rerolled: true` で、相手の view には出ない。再接続しても新しい 3 枚と配り直し済みは残る
- **運命の輪**: 引く効果はサーバーの `crypto.getRandomValues` で決める（`useSkill` の第 3 引数。画面は id だけを送り、効果を選べない）。`armed.effect` が引いた効果（運命の輪以外の 10 枚のどれか）、`armed.fizzle` は不発。巻き戻しが出たらその場で戻した局面が届き（`armed.back` / `redo`）、連続行動が出たらカードと同じに 2 手目を打つ。補充・王の移し替えが出たら `armed.aim: true` で、同じ人がもう一度 `skill`（`id: "wheel"` と `kind` / `to`）を送って指定する。指定するまで `move` は `illegal_move`。指定を待つ間に時間切れなら、`playTimeout` が指定も一様に選んでから打つ
- **連続行動**: 1 手目の後に置ける手があれば手番は同じ人のまま（`view.skills.second: true`）。サーバーは手番が来たときと同じく時計を数え直す。2 手目に `skill` は `illegal_skill`
- **巻き戻し**: engine が巻き戻しのカードを持つ人の前の手番の頭の局面を `GameState.skills.undo` に持つ（王を含むので `viewFor` が消し、`view.skills.undoable` だけを送る）。`skill` で使うと `state` の棋譜が短くなる（`armed.back` が戻した手数）。画面は `seq` に新しい棋譜の長さを使う。相手の王の指定は戻さず、戻した応手で相手が王を決めていたら、相手の `view.myKing.kept` / `forcedNow` が true（次に置く駒が王）。使った人には何も分からない
- **偵察**: 相手の王が分からないうちは王を特定し（`armed.scout: "find"`。`GameState.kings[相手].seen`）、王が分かっている・返した後は使った時点の相手の今の副将を特定する（`armed.scout: "vice"`。`GameState.kings[相手].vice.list` の最後の `seen`）。どちらも場所が見えるだけで罰は変わらない。相手の副将が「いない」（`view.oppVice.set` が `false`）・偵察の印が見えている（`view.oppVice.scouted`）なら `illegal_skill`（ゲージは減らない）
- **副将**: 王と同じく `move` の `vice: true` で、置いた駒を新しい副将にして置き直す（engine の `playMove(state, r, c, kind, { vice })` が検証する。王を決めた手から 7 手ごとの窓で 1 回。今の窓で置いた後・`king` と同時は `illegal_move`）。副将はいつも 1 つまで。副将の真の状態は `GameState.kings[p].vice`（隠し情報。`ViceState`: 周期の起点 `since`・見せる時期の起点 `base`・窓ごとに置いた副将の `list`）で、`viewFor` が本人に `view.myVice`（`ViceInfo`: `status` off / wait / unset / set・今の副将の `cell`・`left`・`forcedNow`・`kept`・`seen`・置き直してふつうの駒に戻った前の副将 `replaced`）、相手に `view.oppVice`（`{ set, wait, scouted, cell }`。`cell` は偵察で特定したときだけ）を作る。置いた手で `set` が変わると置いた駒が副将だと分かるので、窓 k の副将は相手の「王の期限 ＋ 7 × k 手目」を打ち終えてから `set: true` で見せる（`wait` は次の窓を見せるまでの相手の手数。見せた窓の副将を返したら次の窓まで `false`）。`vice` を付けた手も付けない手も、相手に届く `state` は同じ（棋譜にも残らない）。期限の手まで出さなければ置いた駒が自動で副将（`myVice.auto`）。副将を返した手の棋譜は `MoveEvent.vice`（`{ r, c, kind, penalty, scouted? }`。公開）。`server/test/skill.test.ts` が、副将の駒だけ違う局面で相手への `view` が一致することを検査する
- **隠し情報**: 偵察で分かった相手の王は `GameState.kings[相手].seen` に、王の移し替えで移した先は `kings[自分].cell` に持つだけで、`viewFor` が使った本人にだけ見せる（偵察した人の `view.oppKing` は `{ candidates: [王のマス], scouted: true }`）。王の移し替えの棋譜・`armed` には移す先を入れない（`cands` は使った時点の自分の駒すべて = 公開されている盤の情報）。`server/test/skill.test.ts` が、移す先だけ違う 2 部屋で相手に届くバイト列が一致することを検査する
- **再戦**: 次の対局は配り直す（カード・ゲージは持ち越さない）

## エンドレスマッチ

CPU に勝つたびに CPU が強くなり、負けたら終わる 1 人用のモード。CPU の手もサーバーが打ち（権威サーバー）、連勝数はサーバーだけが数える（画面から連勝数は受け取らない）。ルールと段階は `web/src/engine/endless.ts`（短い対局・`ENDLESS_STAGES`）、段階の値の測定は `.agent/endless.md`。

- **機能フラグ**: `server/wrangler.jsonc` の var `ENDLESS_ENABLED` が `"1"` のときだけ `/api/endless` の下を受ける。それ以外（`"0"`。本番は 2026-10-22 から `"1"`）はほかの存在しないパスと同じ 404 で、Durable Object も起こさない。`GET /api/health` はフラグが on のときだけ `{"ok":true,"endless":true}`（off は今までどおり `{"ok":true}`）。画面は `endless: true` のときだけメニューに入口を出す（オフラインの PWA は health に届かないので出ない）。深く読む CPU が 1 手 約 0.1 秒の CPU を使うので、Workers の有料プランにしてから on にする
- **1 端末 = 1 Durable Object**（`server/src/endless.ts` の `Endless`、binding `ENDLESS`、migration `v3`）。端末 ID から `idFromName`。端末のトークン・名前・最高の連勝数・今の挑戦を storage の `"device"` に 1 件で持ち、消さない（別の日に続きから）
- **ランキング**: 全員で 1 つの Durable Object（`server/src/ranking.ts` の `Ranking`、binding `RANKING`、名前 `"global"`）の SQLite（`scores`: 端末 ID・名前・最高・達した時刻、`blocked`）。書くのは端末の Durable Object だけ（勝って最高を超えたとき `report`、名前を変えて join したとき `rename`）。上位は最高の大きい順・同じなら先に達した順、順位は「より大きい最高の端末の数 + 1」（同じ連勝数は同じ順位）。外部のリソース（D1 など）は作らない

### エンドポイント（`/api/endless` の下。`protocol.ts` の `ENDLESS_PATH`）

| メソッドとパス | 用途 | 成功 | 失敗 |
|---|---|---|---|
| `POST /api/endless/devices` | 端末を発行する（本文なし） | 201 `DeviceResponse`（`device`: 16 バイトの base64url 22 文字、`token`: 32 バイトの base64url 43 文字） | 429 `too_many_requests`（接続元ごとに `DEVICE_WINDOW_MS` 10 分に `DEVICE_LIMIT` 10 回。合言葉と同じ Worker のメモリの軽い制限。e2e は `--var TEST_DEVICE_LIMIT:1000`） |
| `GET /api/endless/devices/:device/ws` | WebSocket | 101 | 形の違う ID は 101 で受けて `invalid_token` を送り 4003 で閉じる（ない端末・トークン違いと同じ答え） |
| `GET /api/endless/ranking?device=…` | 上位 `RANKING_TOP`（50）件と、`device` の順位 | 200 `RankingResponse`（`top`・`me`（載っていなければ null）・`total`）。形の違う `device` は無視 | |
| `GET /api/endless/admin/scores?q=…` | 管理用: 名前に `q` を含む行（空なら上位）を端末 ID つきで | 200 `AdminScore[]` | Secret `ENDLESS_ADMIN_TOKEN` がなければ 404、`Authorization: Bearer` が違えば 401 `unauthorized` |
| `DELETE /api/endless/admin/scores/:device[?block=1]` | 管理用: 行を消す（`block=1` なら以後の記録も載せない） | 200 `{ removed }` | 同上 |
| `POST /api/endless/admin/scores/:device?unblock=1` | 管理用: block を外す | 200 `{ unblocked: true }` | 同上 |

- 端末 ID は秘密ではない（WebSocket のパスとランキングの自分の行に使う）。トークンが鍵で、WebSocket の本文でだけ送る（比較は `timingSafeEqual`）
- 管理: `cd server && npx wrangler secret put ENDLESS_ADMIN_TOKEN` で入れ、`curl -H "Authorization: Bearer <token>" https://kyosho.rukiharukichi.com/api/endless/admin/scores?q=名前` で探し、`curl -X DELETE -H … …/api/endless/admin/scores/<device>?block=1` で消す。Secret を入れなければ管理用の API は存在しない（404）

### WebSocket のメッセージ

クライアント → サーバー（型は `EndlessClientMessage`。1 メッセージ 1024 バイトまで。ping は対局の部屋と同じ）:

| type | フィールド | いつ |
|---|---|---|
| `join` | `token`（必須）, `name?` | 接続直後に 1 回。名前は `normalizeName` で検証し、不正なら名前なし（エラーにしない）。join のたびに最新の名前にする（ランキングの名前も替える） |
| `start` | （e2e だけ `test`） | 挑戦がない・前の挑戦が負けで終わったとき。挑戦の途中は `run_active` |
| `next` | `game`（終わった対局の番号 = `run.game`） | 勝った・引き分けの後。違えば `stale_next`（二重押し） |
| `move` / `pick` / `reroll` / `skill` | 対局の部屋と同じ | プレイヤーの手番・カードを選ぶ前。対局中でなければ `no_game`、CPU の手番は `not_your_turn` |

- ほかの type（`rematch` / `leave` や、連勝数を送るような知らないもの）は `bad_message`。知らないキー（`wins` など）は捨てる
- `test`（`{ hp?: [プレイヤー, CPU], cpu?: EndlessCpuName, turnSeconds? }`）はサーバーの var `TEST_ENDLESS` が `"1"` のときだけ読み、その挑戦の全部の対局に効く（本番の設定にはなく、送っても捨てる）。画面は `window.kyoshoEndlessTest` があれば `start` に付ける（e2e の `addInitScript` だけが入れる）

サーバー → クライアント（`EndlessServerMessage`）: `endless`（`EndlessStateMessage`: `run`（`EndlessRunInfo` か null）・`best`・`name`）と `error`（対局の部屋と同じ形。新しい code は `no_game` / `run_active` / `stale_next`）。join・手・CPU の手・時間切れ・次の対局のたびに届く。

- `run.phase`: `playing` / `won`（勝った。`wins` は勝ちを含む）/ `drawn`（引き分け。`wins` はそのまま）/ `lost`（負け。挑戦の終わり）
- `run.stage`: この対局の段階（`no` = 何戦目 = Lv、`base` / `next` / `mix` / `hp`）。始めたときの `stageOf(wins)` を挑戦の記録に写すので、表を変えても対局の途中では変わらない
- `run.you`: 1 局ごとに入れ替える（奇数局はプレイヤーが先手）。引き分けの次の局も入れ替わる
- `run.view`: `viewFor(対局, プレイヤー)`。CPU の王・副将の場所・巻き戻しの局面は入らない（`server/test/endless.test.ts` が届いたバイト列に `"kings"` / `"undo"` がないことを確かめる）
- `run.thinking`: CPU の手番（`ENDLESS_CPU_DELAY_MS` 0.7 秒の後に CPU の手の入った状態が届く）
- `run.clock`: プレイヤーの手番の残り。CPU の手番・カードを選ぶ間・切断中・対局中でなければ null

### 流れとサーバーの処理

1. 画面は localStorage `kyosho:endless`（`{ v: 1, device, token }`）がなければ `POST /api/endless/devices` で発行してもらって保存する
2. WebSocket で `join`。挑戦がない・負けで終わっていれば（メニューから入った直後だけ）`start`。挑戦の途中なら届いた局面から続ける（終局していれば終局画面）
3. 対局を作るときに CPU のカードを CPU の決まり（`wantsReroll` / `chooseSkillPick`）で選び、プレイヤーは配られた 3 枚から選ぶ（選ぶ間は時計を止める）。巻き戻しは配らない（`RuleSet.omit`）
4. プレイヤーの手を `playMove` で検証して適用し、CPU の手番なら alarm を 0.7 秒後に張る。alarm で `cpuTurn`（段階の CPU。混ぜる段階は手番ごとに `cpuOf` で選ぶ）を **1 手番だけ**打って配り、まだ CPU の手番（連続行動の 2 手目・プレイヤーのパス）なら次の alarm を張る。読みが例外になったら置ける手から 1 つ（止まらないように）
5. 終局したら `settle`: 勝ちは `wins + 1`（最高を超えたらランキングに `report`）、引き分けはそのまま、負けは挑戦の終わり。`next` で次の対局（勝ちの後は段階が上がる）
- **1 手の制限時間**（`ENDLESS_TURN_SECONDS` 45 秒 + `TURN_GRACE_MS`）: プレイヤーの手番で、WebSocket がつながっている間だけ数える。最後の接続が切れたら残りを `left` に覚えて止め、join で残りから数え直す（中断で時間が増えず、中断している間に時間切れにもならない）。切れたら `playTimeout`。alarm は CPU の手の時刻と締め切りの早い方に張る（どちらもなければ消す）
- **改ざん**: 手・カード・スキルは engine が検証し、連勝数・段階・体力はサーバーの記録だけから決まる。トークンが違えば参加できない。`server/test/endless.test.ts` が反則手・他人のトークン・終わった挑戦への手と `next`・連勝数を送るメッセージ・`test` の形を確かめる

### 画面（`web/src`）

- 通信層 `net/endless.ts`（DOM なし）: 端末の保存・発行・ランキングの取得と `EndlessSession`（`OnlineSession` を継承。join の中身と受けるメッセージだけ替え、`leave` は送らない。`invalid_token` で閉じたら保存した端末を捨てる）
- 画面は届いた状態をオンライン対戦の `state` の形に直して同じ描き方で出す（`App.onEndless` → `onState`。盤は届いた view、時計はサーバーの値）。名札は自分に「N連勝」、CPU に「Lv N」（title に CPU の強さ）。状態の行は CPU の手番に「CPU 思考中…」。終局画面と駒台のボタンは勝ち「次の対局」・引き分け「もう一度」・負け「新しく挑戦」と「ランキング」（`App.endlessControls`）
- 入口はメニューの CPU対戦 → 強さの段の「エンドレス」（続きがあれば「N連勝中」、なければ最高）と「ランキング」（`ui/ranking.ts` の `RankingDialog`）。初めての人の遊び方の錠は CPU 対戦と同じ

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
- **入口**: 起動時に `GET /api/health` を 3 秒まで待ち、`{"ok":true}` が返ったときだけメニューの「マルチ」に「オンライン」（添え書き「招待リンク」）と「オンライン」（添え書き「合言葉」、`#menu-phrase`）を、設定メニューの手番に自分の席（「オンライン」の行。部屋を作る側の席で、ランダム（既定）／先手／後手 = `hostSeat`）を出す（GitHub Pages・`vite preview` は 404 や画面の HTML が返るので出ない）。「オンライン」を押すとすぐ部屋を作る
- **部屋の作成**: 設定メニューで保存した組み合わせ（URL のクエリで開いたときはそのルール、どちらもなければ既定の「標準」）を常に `rules` で送る（プリセットと同じでも `preset` は使わない）。`rules` は RuleSet の全項目なので、画面の既定を変えても送る形式・サーバーの検証は変わらない。応答の `token` を保存してから WebSocket で join する。待機中は案内のダイアログに招待リンク（`?room=<id>`、コピー・`navigator.share` があれば共有）・自分の席・ルールを出し、`phase: "playing"` の state で閉じる
- **合言葉**: 「オンライン 合言葉」で案内のダイアログに合言葉の入力（`#phrase-input`、Enter か「決定」`#phrase-go`。日本語の変換を確定する Enter では送らない）と「?」（`#phrase-help-btn`。知らない人とつながりうること・全角と半角を同じとみなすこと。常には出さない）。決めると画面で `normalizePhrase` を通し、通らなければ欄の下に理由（`#phrase-error`）を出して送らない。通れば `POST /api/match`（ルール・席・制限時間は部屋の作成と同じく設定メニューの組み合わせ）。`wait` は部屋の作成と同じく入り、待機中は合言葉と待機の表示（`data-view="phrase-wait"`。合言葉 `#phrase-show`・「やめる」`#phrase-leave` = `leave` を送ってメニューへ）。`join` は招待リンクと同じ参加の確認（見出し「合言葉の相手」）。入る前に `room_full` / `room_not_found` で閉じたら、同じ合言葉で探し直す（`App.phraseJoin`、最大 2 回）。`too_many_requests` は「少し待ってください」
- **アドレス**: 部屋に入ったら `?room=<id>` にする（再読み込みで同じ部屋に戻る）。対局中にメニューを開いても部屋の URL のまま（設定メニューで保存してもアドレスを書き換えない。「対局に戻る」で盤・待機中の案内に戻り、接続は保つ）。部屋を抜けたらクエリを外す
- **招待リンクから開いた**: 保存したトークンがあれば（再読み込み）確認なしで席に戻る。なければ `GET /api/rooms/:id` でルールを出して「参加する」を待つ。`open: false` は満員（終局済みならその旨）、404 は部屋が見つからない、届かなければ「この公開先ではオンライン対戦を使えない」。この端末で作った部屋（localStorage `kyosho:created` に部屋 ID を最新 20 件。秘密ではない）なら「ここで参加すると相手の席に座る」と注意を出す
- **トークンの保存先**: `sessionStorage` の `kyosho:token:<roomId>`。再読み込みでは残り、別のタブ・別のウィンドウとは共有しないので、同じブラウザの別タブで招待リンクを開くと別人として参加する（1 台で 2 人分を試せる）。タブを閉じると席に戻れない（同じ部屋に入り直すには、もう一方が新しい部屋を作る）。タブの複製では sessionStorage が写るので同じ席を 2 つのタブで開けるが、後から join した方が残り、古い方は 4001 で閉じて「別のタブで開かれました」と「このタブで続ける」（押すと取り戻す）を出す
- **つなぎ直し**: 4001 / 4003 / 4004 / 4010 以外で切れたら 1・2・4・8・16・30 秒（以後 30 秒）待ってトークン付きで join し直す。画面に戻った（`visibilitychange`）・ネットにつながった（`online`）ときは待たずにつなぐ。25 秒ごとに ping（`PING_TEXT`、サーバーが自動応答するので部屋の寿命・課金は増えない）を送り、10 秒以内に何も届かなければ切れたとみなす。切れている間は盤の枠の下の縁（`#net`）に「再接続中…」、盤は操作できない
- **描画**: 届いた `view` を `GameState` として描く（`legalCells` / `previewMove` / `threatenedPieces` は `kings` を読まない）。棋譜が伸びた state だけ着手の演出・効果音・決着の演出を出し、接続の変化や復帰の state は描き直すだけ。接続・再読み込み直後の最初の state は過去の手を演出せず、終局済みなら決着の演出なしで終局画面を出す。大・特大の演出中に届いた手は演出の後に反映する
- **手**: 自分の手番・対局中・つながっている・前の手の返事待ちでないときだけ盤を操作でき、打ったら `move`（`seq` 付き）を送って「送信中…」。返事を待つ間は置いた駒だけを先に盤に出し（`App.pending`。直前の手の印も付ける。往復の待ちを見せないため）、返す駒・ダメージ・王と副将の罰は state が届いたときに描く（画面では手を適用しない）。拒否・切断で返事待ちが終われば置いた駒は消える。拒否（`error`）は内容をトースト（`stale_move` は出さない）
- **制限時間**: 部屋を作るときに設定メニューの「1 手の時間」の「マルチ」（既定 45 秒）を `turnSeconds` で送る。招待・参加のダイアログに「1 手 N 秒」（`#room-time`）。対局中は手番の人の名札に時計（`#turn-clock`。相手の手番は相手の名札）。時間切れの手は棋譜に「（時間切れ・自動）」、トーストで「時間切れ。〜の手を（マス）に（駒）で自動で打ちました」
- **取られる駒の警告「!」**: 表示の設定（`Saved.threat`、既定はオフ）で、各自が自分の画面だけで切り替える（引き出しの `#btn-threat`）。サーバー・通信には載らない。待ったはオンラインにはない
- **スキル**: `view.skills.ready` が `false` の間はカードを選ぶダイアログ（`#skill-pick`。自分が選んだら「相手が選んでいます」）。選んだら `pick` を送り、両者が選んだ `state` でカードをトーストで知らせる。見出しの行の「配り直し」（`#skill-pick-reroll`）は `reroll` を送り、押したらすぐ押せなくする（`rerolled` の届いた view でも押せない）。名札のカードを押す（`#skill-use`）と `skill` を送り、`armed` が入った `state` で（相手が使ったときも）演出する（`App.playSkillCast`）。補充は戻す駒、王の移し替えは盤で移す先を選んでから送る。偵察で分かった相手の王は盤に金の「王」の印（`.king-cand.scouted`）と名札のマス名。副将は駒台の右端の「副」の鍵（`#vice-toggle`）を押してから置き、`move` に `vice: true` を付けて送る（王の鍵 `#king-toggle` と同じ流れ）。自分の副将は盤の銀の「副」（`.vice-mark`）と名札（`.vice-tag`）、偵察で分かった相手の副将は `.vice-cand.scouted`
- **隠し王**: 王の情報は `kingInfo` を使わず、自分の王は `view.myKing`、相手の王は `view.oppKing`（返されたか・候補）だけ。相手の王の候補には盤で「?」の印と、相手の名札の王の欄に「候補N」（`#king-cands`、説明は title）を出す
- **接続の表示**: 盤の枠の下の縁の左（`#net`、色の点と短い文字）に「相手: 接続中」（緑）／「相手: 切断中」（赤。手番の表示 `#status` は「相手の接続が切れています」）／「相手を待っています」／「再接続中…」。相手の参加・切断・復帰はトーストでも知らせる
- **終わり方**: 4001 → 別のタブで開かれた、4004 → 部屋が見つからない、4010 → 期限切れ、4003 は直前の `error.code` で満員／席に戻れない（`invalid_token` は保存したトークンを消す）。どれも案内のダイアログに出し、メニューへ戻れる。終局後に部屋が片付けられた（4004 / 4010）ときは何も出さず、盤と結果をそのまま見せる
- **終局後**: 終局画面は CPU 対戦と同じく自分の目線（勝利／敗北の演出・自分の成績）。終局画面の下と、盤面を見ている間の駒台の場所に再戦のボタン（`App.rematchControls`、`data-rematch`）と状態の 1 文（`#result-rematch-note` / `#tray-rematch-note`）: 何もなし →「再戦」／申し込み中 →「再戦の返事待ち」と「取り消し」／申し込まれた →「相手から再戦の申し込み」と「断る」「受ける」／断られた →「再戦を断られました」と「再戦」／相手が退室 →「相手が退室しました」と「新しい部屋で再戦」（同じルール・今の自分の席（先手なら `first`）で部屋を作り直し、招待リンクを出す）。送ってから次の `state` が届くまでと、つながっていない間はボタンを押せない（二重押しを防ぐ）。終局画面を閉じているときは、申し込まれた・断られた・取り消された・退室をトーストでも知らせる
- **名前**: 部屋に入るときの保存した名前（`App.setup.current.name`）を `OnlineSession` に渡し、`join`（つなぎ直しも）に付ける。名札・終局画面の自分の名前は `state.name`、相手の名前は `state.opponent.name`（`App.playerName`。名前なしは「あなた」「相手」）。案内のダイアログ（招待・参加の確認・待機）は今までどおり「あなた」「相手」
- **通算の戦績**: 終局画面の成績表に「通算」の行（各列はその人から見た「2勝1敗」、引き分けがあれば「1勝1敗1分」。`ui/outcome.ts` の `recordText`）。2 局目からは名札の名前の横にも小さく（`.plate-record`）
- **抽選の演出**: `state.seatDraw` が `true` で、`phase: "playing"`・まだ手がない state を、このタブで初めて受け取ったとき（参加者は最初の state、作成者は待機中から対局中に変わった state）に `App.playToss`。上を向く色は `you`。見たことは `sessionStorage` の `kyosho:toss:<roomId>` に残し、再読み込みでは出し直さない。メニューを開いている間に始まったら出さない。演出中は盤を操作できず、届いた相手の手は演出の後に反映する。相手の参加のトーストには席を書かない（演出で見せる）
- **再戦の成立**: `state.gameNo` が増えたら `App.startNextGame`: 前の対局の演出・終局画面・時計を片付けて、届いた `view` で描き直す（自分の名札は下のまま、席の色が入れ替わる）。トースト「再戦開始　あなたは先手」
- **部屋を抜ける**: `OnlineSession.close()` は参加済みなら `leave` を送ってから閉じる。「メニュー」を開くだけでは抜けない（接続を保ち「対局に戻る」で戻れる）。メニューから別の対局を始めた・新しい部屋を作ったときに抜ける
- **今のサーバーではできないこと**: 終局後の相手の王の答え合わせ（返されなかった相手の王は終局後も送られないので、終局画面では「非公開」）

## サーバーの設計

- **部屋 ID**: 16 バイトの乱数の base64url（22 文字、`ROOM_ID_PATTERN`）。Durable Object は `idFromName(roomId)` で引く。形式の違う ID では Durable Object を作らない
- **合言葉の受付**: `Lobby`（`server/src/lobby.ts`、binding `LOBBIES`、migration `v2`）。上の「合言葉」
- **トークン**: 32 バイトの乱数の base64url（43 文字）。Durable Object の storage にだけ置き、比較は `crypto.subtle.timingSafeEqual`
- **保存**: 部屋の状態（ルール・`GameState`・席のトークン・作成者の席）を storage の `"room"` に 1 件で保存し、参加・手のたびに書く。オブジェクトが退避されてもコンストラクタで読み直す（`blockConcurrencyWhile`）。WebSocket は Hibernation API（`acceptWebSocket`）で受けるので、待っている間は課金されず、退避後も接続は残る。接続ごとの席は `serializeAttachment` に入れる
- **手の直列化**: 手の処理は storage の書き込みしか待たないので、Durable Object の入力ゲートで 1 手ずつ処理される（同時に届いた手が混ざらない）
- **後片付け**: 参加・手・復帰のたびに alarm を張り直す（待機中・対局中は 24 時間後 `ROOM_TTL_MS`、終局後は 1 時間後 `FINISHED_TTL_MS`。制限時間のある対局中は手番の締め切り。上の「1 手の制限時間」）。放置の alarm が発火した = それだけ放置されたので、接続を 4010 で閉じて storage を消す。ping では延びない
- **不正な入力**: 本文は 8 KB、WebSocket は 1024 バイトまで。JSON・形・範囲を検証してから engine に渡す（engine の例外は `illegal_move`、カードの選択・スキルの使用は `illegal_skill`、副将を出せない手も `illegal_move`）。Worker の想定外の例外は 500 `internal`。join せずに待つ接続は 1 部屋 4 つまで（超えたら古いものから閉じる）
- **Origin**: 画面と同じオリジンだけを受ける（CSRF・他サイトからの WebSocket 乗っ取りの対策）。CORS のヘッダーは返さない
- **静的アセット**: `/api` の外は Workers の静的アセットが返す（無料・無制限で、Worker のリクエスト数にも数えない）。Worker の `fetch` は `/api` の外を受けたら Durable Object に触れずに 404 を返す

## ファイル

| ファイル | 中身 |
|---|---|
| `web/src/net/protocol.ts` | 通信仕様の型と定数（画面・サーバー共通） |
| `web/src/net/phrase.ts` | 合言葉の正規化と検証（画面・サーバー共通）。テストは `web/test/phrase.test.ts` |
| `web/src/net/name.ts` | 名前の正規化と検証（画面・サーバー共通）。テストは `web/test/name.test.ts`・`server/test/name.test.ts`・`web/e2e/online/names.spec.ts` |
| `web/src/net/online.ts` | 画面の通信層（HTTP・WebSocket の接続・参加・トークン・つなぎ直し・ping）。テストは `web/test/online.test.ts` |
| `web/src/net/endless.ts` | エンドレスマッチの通信層（端末の保存と発行・ランキング・`EndlessSession`）。テストは `web/test/endless-net.test.ts` |
| `web/src/ui/online.ts` | 案内のダイアログ（作成中・招待リンクと待機・参加の確認・合言葉の入力と待機・エラー） |
| `web/e2e/online/` | 2 つのブラウザで作成 → 参加 → 終局・再読み込み・隠し王の秘匿・エラー・切断・制限時間（`timer.spec.ts`）・同じ部屋での再戦（`rematch.spec.ts`）・合言葉（`phrase.spec.ts`）の e2e（`cd web && npm run e2e:online`、設定 `web/playwright.online.config.ts` が wrangler dev を :8790（`E2E_ONLINE_PORT` で変更可）で、`TEST_TURN_SECONDS`・`TEST_MATCH_LIMIT` 付きで起こす） |
| `server/wrangler.jsonc` | Worker の設定: 静的アセット（`../web/dist`、`run_worker_first`）・Durable Object・`ALLOWED_ORIGINS`・独自ドメイン（`routes` の Custom Domain `kyosho.rukiharukichi.com`） |
| `server/src/index.ts` | Worker: `/api` の下のルーティング・Origin・部屋の作成・合言葉（検証・送りすぎの制限・受付への振り分け） |
| `server/src/lobby.ts` | Durable Object `Lobby`: 合言葉ごとの受付（待っている部屋を 1 つ覚え、1 件ずつ処理する） |
| `server/src/endless.ts` | Durable Object `Endless`: エンドレスマッチの 1 端末（参加・挑戦・手の検証・CPU の手・制限時間・段階） |
| `server/src/ranking.ts` | Durable Object `Ranking`: エンドレスマッチのランキング（SQLite）と管理用の一覧・削除 |
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
