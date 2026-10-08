// オンライン対戦の通信仕様（画面 web/src/ui とサーバー server/ の共通の型と定数）。
// 説明は .agent/online-protocol.md。ここには型と定数だけを置き、実行時の処理は書かない（サーバー・画面のどちらからも import する）。

import type { PlayerView } from "../engine/game";
import type { PieceKind, Player, PresetId, RuleSet } from "../engine/rules";

/**
 * API と WebSocket のパスの接頭辞。画面と同じオリジンの Worker が /api の下だけを受け持ち、それ以外は静的アセット。
 * 画面からは相対でなく絶対パス（`${API_PATH}/rooms`）で呼ぶ。変えたら server/wrangler.jsonc の run_worker_first も揃える
 */
export const API_PATH = "/api";

/** 部屋 ID（ランダム 16 バイトの base64url、22 文字）。招待 URL に載せる */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** 再接続のトークン（ランダム 32 バイトの base64url、43 文字）。部屋ごとに保存する */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** クライアントが送る 1 メッセージの上限（UTF-8 のバイト数）。超えると too_large */
export const MAX_MESSAGE_BYTES = 1024;
/** POST /api/rooms の本文の上限（バイト数）。超えると 413 too_large */
export const MAX_CREATE_BYTES = 8 * 1024;

/** 最後の操作から部屋を消すまでの時間（待機中・対局中） */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** 終局（または終局後の最後の接続）から部屋を消すまでの時間 */
export const FINISHED_TTL_MS = 60 * 60 * 1000;

/** 接続維持の ping。この文字列そのままを送ると、サーバーは PONG_TEXT を返す（部屋の寿命は延びない） */
export const PING_TEXT = '{"type":"ping"}';
export const PONG_TEXT = '{"type":"pong"}';

/**
 * 1 手ごとの制限時間の選択肢（秒。0 は制限なし）。手番が来るたびに戻り、切れたら置ける手から 1 手を自動で打つ。
 * オンラインでは部屋を作るときに決め（CreateRoomRequest.turnSeconds）、サーバーが計る
 */
export const TURN_SECONDS = [0, 20, 45, 90] as const;
export type TurnSeconds = (typeof TURN_SECONDS)[number];
/**
 * サーバーが制限時間に足す猶予（ミリ秒）。画面は着手の演出（最大 1.5 秒）の間は時計を止めて見せ、
 * 通信の遅れもあるので、サーバーの締め切りは「手番が来た時刻 + 制限時間 + 猶予」にする
 */
export const TURN_GRACE_MS = 1500;
/**
 * 先手・後手を抽選で決めた部屋（hostSeat: random）の 1 局目で、先手の最初の締め切りに足す時間（ミリ秒）。
 * 画面は対局の始めに抽選の演出（石を投げる。ui/fx.ts の tossMs、最大 1.9 秒）を出し、その間は時計を止めて見せる
 */
export const TOSS_GRACE_MS = 2000;

// ---- HTTP ----

/** 作成者の席。first: 先手 / second: 後手 / random: 部屋を作るときにランダム（既定） */
export type HostSeat = "first" | "second" | "random";

/** POST /api/rooms の本文。rules と preset はどちらか一方 */
export type CreateRoomRequest =
  | {
      /** 対局のルール。範囲・型は ui/query.ts の decodeRules と同じ基準で検証する */
      rules: RuleSet;
      hostSeat?: HostSeat;
      /** 1 手ごとの制限時間（TURN_SECONDS のどれか）。省略は 0（制限なし） */
      turnSeconds?: TurnSeconds;
    }
  | {
      /** プリセットの ID（rules.ts の PRESETS） */
      preset: PresetId;
      hostSeat?: HostSeat;
      turnSeconds?: TurnSeconds;
    };

/** POST /api/rooms の応答（201） */
export interface CreateRoomResponse {
  roomId: string;
  /** 作成者のトークン。WebSocket の join に付けて送る */
  token: string;
  /** 作成者の手番（0: 先手 / 1: 後手） */
  you: Player;
}

/** 待機中（相手の参加待ち）/ 対局中 / 終局 */
export type RoomPhase = "waiting" | "playing" | "finished";

/** GET /api/rooms/:id の応答（200）。招待された人が参加前にルールを確かめる用 */
export interface RoomInfoResponse {
  roomId: string;
  phase: RoomPhase;
  rules: RuleSet;
  /** 1 手ごとの制限時間（秒。0 は制限なし） */
  turnSeconds: number;
  /** 参加できる席が残っている（トークンなしの join が通る） */
  open: boolean;
}

/** HTTP のエラー応答（4xx / 5xx）の本文 */
export interface HttpErrorBody {
  error: { code: HttpErrorCode; message: string };
}

export type HttpErrorCode =
  | "bad_request" // 本文が JSON でない・形が違う
  | "bad_rules" // ルールの型・範囲が不正
  | "too_large" // 本文が MAX_CREATE_BYTES を超えた
  | "not_found" // 部屋（またはパス）がない
  | "method_not_allowed"
  | "forbidden_origin" // 許可していない Origin（同一オリジンと ALLOWED_ORIGINS 以外）
  | "upgrade_required" // /ws に WebSocket 以外で来た
  | "internal";

// ---- WebSocket: クライアント → サーバー ----

/** 接続直後に 1 回送る。token があればその席に復帰、なければ空いている席に参加する */
export interface JoinMessage {
  type: "join";
  token?: string;
}

/** 手番の人が手を送る。サーバーは engine の playMove で検証して適用する */
export interface MoveMessage {
  type: "move";
  /** 行 0〜7 */
  r: number;
  /** 列 0〜7 */
  c: number;
  kind: PieceKind;
  /** 置いた駒を自分の王にする（隠し王）。省略は false */
  king?: boolean;
  /**
   * 手を考えた局面の棋譜の長さ（view.history.length）。サーバーの局面と違えば stale_move で拒否する
   * （制限時間切れの自動の手と入れ違いになった手を、次の局面に打たない）。省略すると調べない
   */
  seq?: number;
}

/**
 * 終局後の同じ部屋での再戦。request: 申し込む（相手が申し込み済みなら受けたことになり、先手と後手を入れ替えた次の対局が始まる）/
 * cancel: 自分の申し込みを取り消す / decline: 相手の申し込みを断る。
 * gameNo は終わった対局の番号（state.gameNo）。今の対局と違えば stale_rematch で拒否する（成立した後に届いた二重押し）
 */
export interface RematchMessage {
  type: "rematch";
  action: RematchAction;
  gameNo: number;
}

export type RematchAction = "request" | "cancel" | "decline";

/** 部屋を抜ける（メニューへ戻る・新しい部屋を作る）。相手に退室を知らせ、再戦の申し込みを取り下げる。送った後に接続を閉じる */
export interface LeaveMessage {
  type: "leave";
}

export type ClientMessage = JoinMessage | MoveMessage | RematchMessage | LeaveMessage;

// ---- WebSocket: サーバー → クライアント ----

/** join が通った。直後に state が届く */
export interface JoinedMessage {
  type: "joined";
  roomId: string;
  you: Player;
  /** この席のトークン（新しく参加したときは発行したもの、トークン付きの join では送られたもの）。再接続用に保存する */
  token: string;
}

/** 部屋の状態。参加・手・相手の接続／切断・終局・再戦の申し込みのたびに、各プレイヤーに自分用の内容で届く */
export interface StateMessage {
  type: "state";
  roomId: string;
  phase: RoomPhase;
  /** この部屋の何局目か（1 始まり）。再戦が成立すると 1 増え、view は新しい対局になる */
  gameNo: number;
  /** 自分の手番。再戦で先手と後手が入れ替わると変わる（トークンは同じ） */
  you: Player;
  /** viewFor(state, you)。相手の隠し王の場所は含まない。終局すると view.result が入る */
  view: PlayerView;
  opponent: {
    /** 相手の席が埋まっている */
    joined: boolean;
    /** 相手が今つながっている */
    online: boolean;
    /** 相手が leave で部屋を抜けた（同じトークンで戻ると false）。切断（online: false）とは別 */
    left: boolean;
  };
  /** 終局後の再戦の申し込みの状態（自分・相手）。終局していなければ null */
  rematch: { you: RematchStatus; opponent: RematchStatus } | null;
  /** この部屋での通算の戦績（自分から見た数）。今の対局は終局してから数える。再戦で席が入れ替わっても人ごとに数える */
  record: MatchRecord;
  /** 手番の制限時間。制限なし・対局中でない（待機中・終局）なら null */
  clock: TurnClockInfo | null;
  /**
   * この対局の先手・後手を抽選で決めた（作成者の hostSeat が random の部屋の 1 局目）。画面は手が 0 のときに抽選の演出を出す。
   * 再戦（先手と後手の入れ替え）と、作成者が手番を指定した部屋では false
   */
  seatDraw: boolean;
}

/** 部屋での通算の戦績（勝ち・負け・引き分けの局数） */
export interface MatchRecord {
  wins: number;
  losses: number;
  draws: number;
}

/** none: 何もしていない / requested: 再戦を申し込んでいる / declined: 相手の申し込みを断った（次に誰かが申し込むまで） */
export type RematchStatus = "none" | "requested" | "declined";

/** 手番の人の残り時間（送った時点の値。画面は受け取った時刻から数える） */
export interface TurnClockInfo {
  /** 1 手の制限時間（ミリ秒。猶予を含まない） */
  limitMs: number;
  /** サーバーが自動で打つまでの残り（ミリ秒。猶予 TURN_GRACE_MS を含む） */
  remainingMs: number;
}

export interface ErrorMessage {
  type: "error";
  code: WsErrorCode;
  message: string;
}

export type WsErrorCode =
  | "bad_json" // JSON として読めない
  | "bad_message" // 形が違う（type・フィールドの型・範囲）。バイナリも含む
  | "too_large" // MAX_MESSAGE_BYTES を超えた
  | "not_joined" // join の前に join 以外を送った（接続を閉じる）
  | "already_joined" // join 済みでもう一度 join した
  | "room_not_found" // 部屋がない・消えた（接続を閉じる）
  | "room_full" // 空いている席がない（接続を閉じる）
  | "invalid_token" // トークンがこの部屋の席と合わない（接続を閉じる）
  | "waiting_opponent" // 相手の参加前に手を送った
  | "not_your_turn"
  | "illegal_move" // engine が拒否した手（置けない・持ち駒がない・王を指定できない など）
  | "game_over" // 終局後に手を送った
  | "stale_move" // 手を考えた局面がもう進んでいる（制限時間切れの自動の手と入れ違い）
  | "stale_rematch" // 終局していない・gameNo が今の対局と違う（再戦が成立した後に届いた二重押しなど）
  | "opponent_left" // 退室した相手に再戦を申し込んだ
  | "internal";

export type ServerMessage = JoinedMessage | StateMessage | ErrorMessage;

/** サーバーが接続を閉じるときの close code（閉じる前に、原因が分かる error を送る。replaced と room_expired は error なし） */
export const CLOSE = {
  /** 同じ席に別の接続が join した（古い方を閉じる） */
  replaced: 4001,
  /** join に失敗した（room_full / invalid_token / not_joined） */
  rejected: 4003,
  /** 部屋がない */
  notFound: 4004,
  /** 放置で部屋が消えた */
  expired: 4010,
} as const;
