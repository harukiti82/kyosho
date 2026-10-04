// オンライン対戦の通信仕様（画面 web/src/ui とサーバー server/ の共通の型と定数）。
// 説明は .agent/online-protocol.md。ここには型と定数だけを置き、実行時の処理は書かない（サーバー・画面のどちらからも import する）。

import type { PlayerView } from "../engine/game";
import type { PieceKind, Player, PresetId, RuleSet } from "../engine/rules";

/** 部屋 ID（ランダム 16 バイトの base64url、22 文字）。招待 URL に載せる */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** 再接続のトークン（ランダム 32 バイトの base64url、43 文字）。部屋ごとに保存する */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** クライアントが送る 1 メッセージの上限（UTF-8 のバイト数）。超えると too_large */
export const MAX_MESSAGE_BYTES = 1024;
/** POST /rooms の本文の上限（バイト数）。超えると 413 too_large */
export const MAX_CREATE_BYTES = 8 * 1024;

/** 最後の操作から部屋を消すまでの時間（待機中・対局中） */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** 終局（または終局後の最後の接続）から部屋を消すまでの時間 */
export const FINISHED_TTL_MS = 60 * 60 * 1000;

/** 接続維持の ping。この文字列そのままを送ると、サーバーは PONG_TEXT を返す（部屋の寿命は延びない） */
export const PING_TEXT = '{"type":"ping"}';
export const PONG_TEXT = '{"type":"pong"}';

// ---- HTTP ----

/** 作成者の席。first: 先手 / second: 後手 / random: 部屋を作るときにランダム（既定） */
export type HostSeat = "first" | "second" | "random";

/** POST /rooms の本文。rules と preset はどちらか一方 */
export type CreateRoomRequest =
  | {
      /** 対局のルール。範囲・型は ui/query.ts の decodeRules と同じ基準で検証する */
      rules: RuleSet;
      hostSeat?: HostSeat;
    }
  | {
      /** プリセットの ID（rules.ts の PRESETS） */
      preset: PresetId;
      hostSeat?: HostSeat;
    };

/** POST /rooms の応答（201） */
export interface CreateRoomResponse {
  roomId: string;
  /** 作成者のトークン。WebSocket の join に付けて送る */
  token: string;
  /** 作成者の手番（0: 先手 / 1: 後手） */
  you: Player;
}

/** 待機中（相手の参加待ち）/ 対局中 / 終局 */
export type RoomPhase = "waiting" | "playing" | "finished";

/** GET /rooms/:id の応答（200）。招待された人が参加前にルールを確かめる用 */
export interface RoomInfoResponse {
  roomId: string;
  phase: RoomPhase;
  rules: RuleSet;
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
  | "forbidden_origin" // 許可していない Origin
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
}

export type ClientMessage = JoinMessage | MoveMessage;

// ---- WebSocket: サーバー → クライアント ----

/** join が通った。直後に state が届く */
export interface JoinedMessage {
  type: "joined";
  roomId: string;
  you: Player;
  /** この席のトークン（新しく参加したときは発行したもの、トークン付きの join では送られたもの）。再接続用に保存する */
  token: string;
}

/** 部屋の状態。参加・手・相手の接続／切断・終局のたびに、各プレイヤーに自分用の内容で届く */
export interface StateMessage {
  type: "state";
  roomId: string;
  phase: RoomPhase;
  you: Player;
  /** viewFor(state, you)。相手の隠し王の場所は含まない。終局すると view.result が入る */
  view: PlayerView;
  opponent: {
    /** 相手の席が埋まっている */
    joined: boolean;
    /** 相手が今つながっている */
    online: boolean;
  };
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
