// 画面の制御。ゲームの計算はすべて engine/ に任せ、ここは表示と入力だけを扱う。

import { cellName, discCount, othelloCells, SIZE, type Cell } from "../engine/board";
import { chooseLookahead } from "../engine/cpu";
import {
  availableKinds,
  createGame,
  isLegal,
  kingInfo,
  lastMoveOf,
  legalCells,
  movesBy,
  playableKinds,
  playMove,
  previewMove,
  targetsAt,
  threatenedPieces,
  viewFor,
  type GameEvent,
  type GameResult,
  type GameState,
  type KingInfo,
  type MoveEvent,
  type PlayerView,
  type Preview,
  type Target,
} from "../engine/game";
import {
  defaultRules,
  kindsByValue,
  kindsInRules,
  KIND_ORDER,
  matchPreset,
  other,
  PIECES,
  PLAYER_NAME,
  REACH_MARK,
  type PieceKind,
  type Player,
  type RuleSet,
} from "../engine/rules";
import {
  browserDeps,
  checkHealth,
  createdHere,
  createRoom,
  getRoomInfo,
  inviteUrl,
  loadToken,
  OnlineHttpError,
  OnlineSession,
  rememberCreated,
  roomIdFromSearch,
  safeStore,
  saveToken,
  wsUrl,
  type EndReason,
} from "../net/online";
import type { ErrorMessage, RoomPhase, StateMessage } from "../net/protocol";
import { dirIcon } from "./diricon";
import { byId, h } from "./dom";
import { finaleMs, Fx, fxTiming, speakerIcon, type FxTiming } from "./fx";
import { OnlineDialog, seatText } from "./online";
import { hitOf, statsOf, tierOf, tierText, type HitBreakdown, type PlayerStats, type Tier } from "./impact";
import { outcomeOf, type Outcome } from "./outcome";
import { dirMark, endDetails, handText, hpText, kingPenaltyText, pieceLabel, ruleDetails, ruleLines, verb } from "./ruletext";
import { drawSeat, fillSentences, SetupDialog, type PlaySettings } from "./setup";
import { Sound } from "./sound";

/** CPU が打つまでの待ち時間（盤面の変化を目で追えるように） */
const CPU_DELAY_MS = 900;
/** 最終手を見せてから終局画面を出すまでの待ち時間 */
const RESULT_DELAY_MS = 900;
const TOAST_MS = 2800;
/** 取った駒が持ち駒へ飛んでいくアニメーションの長さ */
const FLY_MS = 650;

/** 新しい手の演出の計画（段階・攻めた側か受けた側か・文言・長さ） */
interface ImpactPlan extends FxTiming {
  tier: Tier;
  hit: HitBreakdown;
  hurt: boolean;
  text: string | null;
  reduce: boolean;
}

const idx = ([y, x]: Cell) => y * SIZE + x;
const ruleName = (r: RuleSet) => matchPreset(r)?.name ?? "カスタム";

export class App {
  private settings: PlaySettings | null = null;
  private game: GameState | null = null;
  /** プレイヤーごとに選んでいる持ち駒（置ける駒のどれか 1 つが常に選ばれる） */
  private selected: [PieceKind, PieceKind] = ["fu", "fu"];
  /** 予測を表示しているマス */
  private focus: { r: number; c: number } | null = null;
  /** タッチの 1 回目のタップで予測を固定しているか */
  private pinned = false;
  private lastPointer = "mouse";
  private cpuTimer: number | undefined;
  private resultTimer: number | undefined;
  private toastTimer: number | undefined;
  private fxTimer: number | undefined;
  /** 大・特大の演出中は、次の入力と CPU の着手を待たせる */
  private fxLock = false;
  /** 決着の演出中の対局（終われば終局画面を出す）。演出中でなければ null */
  private finale: GameState | null = null;
  private finaleTimer: number | undefined;
  /** トースト通知済みのイベント数 */
  private seenEvents = 0;
  /** 取った・減ったのアニメーションを再生する手数（新しい手の直後の描画だけ） */
  private animatePly = -1;
  /** 隠し王: 手番の人が「この駒を王にする」を選んでいる */
  private kingOn = false;
  /** 隠し王（2 人対戦）: 「自分の王を確認」を押している間 true */
  private peek = false;
  /** タッチで「同じマスをもう一度タップで置く」を覚えたか（吹き出しの案内は覚えるまで） */
  private tapLearned = false;

  // ---- オンライン対戦 ----
  /** 部屋への接続（オンライン対戦中だけ） */
  private net: OnlineSession | null = null;
  /** 最後に届いた部屋の状態（局面は this.game に view として入れる） */
  private room: { id: string; phase: RoomPhase; opponent: StateMessage["opponent"] } | null = null;
  /** 手を送って、サーバーから state が届くのを待っている */
  private sending = false;
  /** 演出の間に届いた state（演出が終わってから反映する） */
  private queued: StateMessage | null = null;
  private readonly lobby = new OnlineDialog();
  /** トークン（部屋ごと）。再読み込みでは残り、別のタブとは共有しない */
  private readonly tokens = safeStore(() => window.sessionStorage);
  /** この端末で作った部屋の記録（自分の招待リンクを開いたときの注意書き） */
  private readonly local = safeStore(() => window.localStorage);

  private readonly cells: HTMLButtonElement[][] = [];
  private readonly setup: SetupDialog;
  private readonly sound = new Sound();
  private readonly fx = new Fx(byId("fx"));
  private readonly el = {
    game: byId("game"),
    board: byId("board"),
    frame: byId("board-frame"),
    hand: byId("hand"),
    legend: byId("legend"),
    rulesName: byId("rules4-name"),
    rulesList: byId("rules4-list"),
    status: byId("status"),
    ply: byId("ply"),
    net: byId("net"),
    players: [byId("player-0"), byId("player-1")] as const,
    seats: [byId("seat-bottom"), byId("seat-top")] as const,
    preview: byId("preview"),
    handTitle: byId("hand-title"),
    handButtons: byId("hand-buttons"),
    kingBox: byId("king-box"),
    log: byId("log"),
    toast: byId("toast"),
    result: byId<HTMLDialogElement>("result"),
    rules: byId<HTMLDialogElement>("rules"),
  };

  constructor() {
    this.buildBoard();
    this.setup = new SetupDialog(
      (s) => this.start(s),
      (r) => this.showRules(r),
      () => !!this.game,
    );
    this.bindControls();
    // 招待リンク（?room=）から開いたら部屋へ、それ以外は設定画面から
    const roomId = roomIdFromSearch(window.location.search);
    if (roomId === undefined) this.setup.open();
    else void this.openRoom(roomId);
    // オンライン対戦の入口は、サーバーに届く公開先でだけ出す（GitHub Pages・vite preview では出さない）
    void checkHealth().then((ok) => ok && this.setup.enableOnline());
  }

  // ---- 初期化 ----

  private buildBoard() {
    for (let r = 0; r < SIZE; r++) {
      const row: HTMLButtonElement[] = [];
      for (let c = 0; c < SIZE; c++) {
        const b = h("button", {
          class: "cell",
          attrs: { type: "button", role: "gridcell", "data-r": String(r), "data-c": String(c) },
        });
        row.push(b);
        this.el.board.append(b);
      }
      this.cells.push(row);
    }
    const cellOf = (e: Event) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".cell");
      return t ? { r: Number(t.dataset.r), c: Number(t.dataset.c) } : null;
    };
    const board = this.el.board;
    board.addEventListener("pointerdown", (e) => (this.lastPointer = e.pointerType || "mouse"));
    // Tab で盤に入ったときも予測を出せるよう、キー入力は文書全体で拾う
    document.addEventListener("keydown", () => (this.lastPointer = "keyboard"));
    board.addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse" || this.pinned) return;
      const at = cellOf(e);
      if (at) this.setFocus(at.r, at.c, false);
    });
    board.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && !this.pinned) this.clearFocus();
    });
    board.addEventListener("focusin", (e) => {
      if (this.lastPointer !== "keyboard") return;
      const at = cellOf(e);
      if (at) this.setFocus(at.r, at.c, false);
    });
    board.addEventListener("click", (e) => {
      const at = cellOf(e);
      if (at) this.onCellClick(at.r, at.c);
    });
  }

  /** 引き出しのタブ（押すと開く・選んでいるタブを押し直すと閉じる・左右キーで移る） */
  private bindTabs() {
    const tabs = this.tabs();
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => this.setTab(t.getAttribute("aria-selected") === "true" ? null : t.getAttribute("aria-controls")));
      t.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = tabs[(i + d + tabs.length) % tabs.length];
        next.focus();
        this.setTab(next.getAttribute("aria-controls"));
      });
    });
  }

  private tabs() {
    return [...document.querySelectorAll<HTMLButtonElement>("#drawer [role=tab]")];
  }

  /** 引き出しのタブを開く（null で閉じる）。予測の詳細は読み上げのため DOM に残し、見た目だけ外す */
  private setTab(id: string | null) {
    const tabs = this.tabs();
    for (const t of tabs) {
      const on = t.getAttribute("aria-controls") === id;
      t.setAttribute("aria-selected", String(on));
      // Tab キーで入るのは、開いているタブ（閉じているときは先頭のタブ）
      t.tabIndex = (id === null ? t === tabs[0] : on) ? 0 : -1;
      const panel = byId(t.getAttribute("aria-controls")!);
      if (panel.id === "preview") panel.classList.toggle("tab-off", !on);
      else panel.hidden = !on;
    }
    byId("drawer").classList.toggle("open", id !== null);
  }

  private bindControls() {
    const { result, rules } = this.el;
    this.bindTabs();
    byId("btn-rules").addEventListener("click", () => this.showRules(this.settings?.rules ?? null));
    byId("btn-new").addEventListener("click", () => this.openSetup());
    byId("rules-close").addEventListener("click", () => rules.close());
    const mute = byId("btn-mute");
    const showMute = () => {
      mute.setAttribute("aria-pressed", String(this.sound.muted));
      mute.setAttribute("title", this.sound.muted ? "効果音: オフ" : "効果音: オン");
      mute.replaceChildren(speakerIcon(this.sound.muted));
    };
    mute.addEventListener("click", () => {
      this.sound.setMuted(!this.sound.muted);
      showMute();
    });
    showMute();
    byId("result-view").addEventListener("click", () => result.close());
    byId("result-setup").addEventListener("click", () => {
      result.close();
      this.openSetup();
    });
    byId("result-rematch").addEventListener("click", () => {
      result.close();
      this.rematch();
    });
    // オンライン対戦: 画面に戻った・ネットにつながったら、つなぎ直しの待ち時間を飛ばす
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && this.net?.wake());
    window.addEventListener("online", () => this.net?.wake());
    // 決着の演出は Enter / Esc（押した時）・スペース（離した時。ボタンの起動と同じ）で飛ばす。
    // 下のボタンが一緒に反応しないよう、演出中のこれらのキーは既定の動作を止める
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.finale || !["Enter", "Escape", " "].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key !== " " && !e.repeat) this.endFinale();
      },
      true,
    );
    document.addEventListener(
      "keyup",
      (e) => {
        if (!this.finale || e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        this.endFinale();
      },
      true,
    );
  }

  // ---- 対局の進行 ----

  private start(settings: PlaySettings) {
    if (settings.mode === "online") {
      void this.createOnline(settings);
      return;
    }
    this.leaveOnline();
    this.resetPlay();
    // CPU 対戦の「ランダム」は対局を始めるたびに引く（希望の randomSeat は残すので、再戦でも引き直す）
    const drawn = settings.mode === "cpu" && settings.randomSeat;
    if (drawn) settings = { ...settings, human: drawSeat() };
    this.settings = settings;
    this.setup.reflectUrl(settings.rules);
    this.game = createGame(settings.rules);
    this.el.game.hidden = false;
    this.renderRuleCard(settings.rules);
    this.renderLegend(settings.rules);
    this.afterChange();
    if (drawn) {
      const first = settings.human === 0 ? "あなたから" : "CPU から";
      this.showToast(`対局開始！ 抽選の結果、あなたは${seatText(settings.human)}です（${first}打ちます）`);
    }
  }

  /** 対局の途中の状態（タイマー・演出・選択）を捨てる */
  private resetPlay() {
    window.clearTimeout(this.cpuTimer);
    window.clearTimeout(this.resultTimer);
    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.finaleTimer);
    this.fxLock = false;
    this.finale = null;
    this.fx.clear();
    this.hideToast();
    document.querySelectorAll(".flyer").forEach((f) => f.remove());
    if (this.el.result.open) this.el.result.close();
    this.selected = ["fu", "fu"];
    this.focus = null;
    this.pinned = false;
    this.kingOn = false;
    this.peek = false;
    this.seenEvents = 0;
  }

  private get online() {
    return this.settings?.mode === "online";
  }

  /** 画面の持ち主の手番（CPU 対戦は人間・オンライン対戦は自分）。2 人対戦は null */
  private me(): Player | null {
    return this.settings && this.settings.mode !== "pvp" ? this.settings.human : null;
  }

  private isHuman(p: Player) {
    return this.settings?.mode === "pvp" || p === this.settings?.human;
  }

  private canAct(): boolean {
    if (!this.game || this.game.result || this.fxLock || !this.isHuman(this.game.turn)) return false;
    // オンライン対戦は、対局中・つながっている・前の手の返事を待っていないときだけ
    return !this.online || (this.room?.phase === "playing" && !!this.net?.ready && !this.sending);
  }

  /**
   * p の王の情報。オンライン対戦は届いた view の自分の王だけを使い、相手の王は公開情報（返されたか）だけ
   * （view には相手の王の真の場所がない。kingInfo は GameState の隠し情報を読むので view には使わない）
   */
  private kingOf(g: GameState, p: Player): KingInfo {
    if (!this.online) return kingInfo(g, p);
    const v = g as unknown as PlayerView;
    if (p === v.viewer) return v.myKing;
    const on = g.rules.king.on;
    const status = !on ? "off" : v.oppKing.revealed ? "revealed" : "hidden";
    return { status, cell: null, auto: false, nextMove: movesBy(g, p) + 1, canDesignate: false, forcedNow: false };
  }

  private place(r: number, c: number, kind: PieceKind, king = false) {
    if (!this.game) return;
    if (this.online) {
      // 手を送るだけ。盤はサーバーから state が届いたときに描き直す（拒否されたら error が届く）
      if (!this.net?.sendMove(r, c, kind, king)) {
        this.showToast("接続が切れています。つながり直したら、もう一度打ってください");
        return;
      }
      this.sending = true;
      this.focus = null;
      this.pinned = false;
      this.render();
      return;
    }
    this.game = playMove(this.game, r, c, kind, { king });
    this.focus = null;
    this.pinned = false;
    this.kingOn = false;
    this.peek = false;
    this.afterChange();
  }

  private afterChange() {
    const g = this.game!;
    this.notifyNewEvents(g.history);
    const last = lastMoveOf(g);
    const fresh = last?.ply === g.ply && g.ply > 0 ? last : undefined;
    const plan = fresh ? this.impactPlan(fresh) : null;
    // 大・特大は演出が終わるまで入力を受けない（描画の前に決めて、盤を操作できない表示にする）
    const hold = plan?.hold ?? 0;
    window.clearTimeout(this.fxTimer);
    this.fxLock = hold > 0;
    this.animatePly = g.ply;
    this.render();
    this.animatePly = -1;
    if (fresh) this.playMoveEffects(fresh, plan!);
    if (hold > 0) {
      this.fxTimer = window.setTimeout(() => {
        this.fxLock = false;
        if (this.game === g) this.render();
        // 演出の間に届いた相手の手を反映する
        const q = this.queued;
        this.queued = null;
        if (q) this.onState(q);
      }, hold);
    }
    if (g.result) {
      // 最後の一手の演出（特大なら出し切る）→ 決着の演出 → 終局画面
      this.resultTimer = window.setTimeout(() => this.playFinale(g), g.ply > 0 ? Math.max(RESULT_DELAY_MS, hold + 300) : 0);
    } else {
      this.scheduleCpu(Math.max(CPU_DELAY_MS, hold + 200));
    }
  }

  private scheduleCpu(delay: number) {
    const g = this.game;
    if (!g || g.result || this.online || this.isHuman(g.turn)) return;
    this.cpuTimer = window.setTimeout(() => {
      if (this.game !== g) return;
      // CPU には自分の視点（相手の王の正体を含まない）だけを渡す
      const ch = chooseLookahead(viewFor(g, g.turn));
      if (ch) this.place(ch.r, ch.c, ch.kind, ch.king);
    }, delay);
  }

  /** 新しい手の段階と演出。CPU 対戦で CPU から受けた手は被弾の演出、それ以外（2 人対戦は常に）は攻めた側の祝福の演出 */
  private impactPlan(m: MoveEvent): ImpactPlan {
    const r = this.game!.rules;
    const tier = tierOf(r, m);
    const me = this.me();
    const hurt = me !== null && m.player !== me;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return { tier, hit: hitOf(r, m), hurt, text: tierText(tier, m, hurt ? "hurt" : "attack"), reduce, ...fxTiming(tier, m.targets.length, reduce) };
  }

  private notifyNewEvents(history: GameEvent[]) {
    const g = this.game!;
    const fresh = history.slice(this.seenEvents);
    this.seenEvents = history.length;
    const msgs: string[] = [];
    for (const e of fresh) {
      if (e.type === "pass") {
        const why = e.reason === "noPieces" ? "持ち駒が尽きました" : "置けるマスがありません";
        msgs.push(`${this.name(e.player)}はパス（${why}）。${this.name(other(e.player))}が続けて打ちます`);
        continue;
      }
      if (e.king) {
        const k = e.king;
        const v = verb(g.rules);
        const what = k.lose ? "即負け" : `体力−${k.penalty}`;
        msgs.push(`王を${v.past}！ ${this.name(other(e.player))}の王は ${cellName(k.r, k.c)} の${pieceLabel(g.rules, k.kind)}（${what}）`);
      }
      // CPU 対戦・オンライン対戦では、自分の王が決まったことを本人に知らせる（2 人対戦は相手に見えるので出さない）
      if (e.player === this.me()) {
        const ki = this.kingOf(g, e.player);
        if (ki.cell && ki.cell[0] === e.r && ki.cell[1] === e.c) {
          msgs.push(
            ki.auto
              ? `期限の ${g.rules.king.deadline} 手目なので、置いた${pieceLabel(g.rules, e.kind)}（${cellName(e.r, e.c)}）が自動であなたの王になりました`
              : `${cellName(e.r, e.c)} の${pieceLabel(g.rules, e.kind)}をあなたの王にしました（${this.foe()}には見えません）`,
          );
        }
      }
    }
    if (msgs.length > 0) this.showToast(msgs.join("　"));
  }

  /** 同じ設定でもう一局。オンライン対戦は同じルール・同じ席で新しい部屋を作る（招待リンクを送り直す） */
  private rematch() {
    const s = this.settings;
    if (!s) return;
    this.start(s.mode === "online" ? { ...s, hostSeat: s.human === 0 ? "first" : "second" } : s);
  }

  // ---- オンライン対戦 ----

  /** 設定画面を開く。オンライン対戦中に開いて閉じたら、アドレスを部屋の URL に戻す */
  private openSetup() {
    const restore = this.room ? `${window.location.pathname}?room=${this.room.id}` : undefined;
    this.setup.open(this.settings?.rules, restore);
  }

  /** 部屋を作って入る（設定画面の「部屋を作る」・終局後の「新しい部屋で再戦」） */
  private async createOnline(settings: PlaySettings) {
    this.lobby.busy("部屋を作っています…");
    try {
      const res = await createRoom({ rules: settings.rules, hostSeat: settings.hostSeat ?? "random" });
      saveToken(this.tokens, res.roomId, res.token);
      rememberCreated(this.local, res.roomId);
      this.enterRoom(res.roomId, { ...settings, human: res.you });
    } catch (e) {
      const why = e instanceof OnlineHttpError && e.code === "bad_rules" ? "この設定ではオンライン対戦の部屋を作れませんでした。" : "サーバーにつながりませんでした。";
      this.lobby.error("部屋を作れませんでした", `${why}時間をおいてもう一度試してください。`, [
        { label: "設定画面へ", onClick: () => this.leaveToSetup(settings.rules) },
        { label: "もう一度試す", primary: true, onClick: () => void this.createOnline(settings) },
      ]);
    }
  }

  /** 招待リンク（?room=）から開いた。保存したトークンがあれば（再読み込み）そのまま席に戻る */
  private async openRoom(id: string | null) {
    this.el.game.hidden = true;
    if (id === null) {
      this.lobby.error("部屋が見つかりません", "招待リンクの部屋 ID の形式が違います。リンクを最後までコピーできているか確かめてください。", [
        { label: "設定画面へ", primary: true, onClick: () => this.leaveToSetup() },
      ]);
      return;
    }
    if (loadToken(this.tokens, id)) {
      this.enterRoom(id);
      return;
    }
    this.lobby.busy("部屋を確かめています…");
    try {
      const info = await getRoomInfo(id);
      if (!info.open) {
        this.showEnded("room_full", info.phase === "finished" ? "この部屋の対局はもう終わっています。" : "この部屋には 2 人がもう参加しています。");
        return;
      }
      const name = ruleName(info.rules);
      this.lobby.join({
        rules: info.rules,
        ruleName: name,
        createdHere: createdHere(this.local, id),
        onJoin: () => this.enterRoom(id, { mode: "online", human: 0, rules: info.rules }),
        onCancel: () => this.leaveToSetup(info.rules),
      });
    } catch (e) {
      if (e instanceof OnlineHttpError && e.code === "not_found") this.showEnded("room_not_found", "招待リンクの部屋が見つかりません。");
      else this.showUnavailable();
    }
  }

  /** 部屋につなぐ（作成者・参加者・再読み込みの復帰で共通）。席はトークンがあればそれ、なければ空いている席 */
  private enterRoom(id: string, settings?: PlaySettings) {
    this.leaveOnline();
    this.resetPlay();
    this.game = null;
    this.el.game.hidden = true;
    this.settings = settings ?? { mode: "online", human: 0, rules: defaultRules() };
    this.room = { id, phase: "waiting", opponent: { joined: false, online: false } };
    this.sending = false;
    this.queued = null;
    // 再読み込みで同じ部屋に戻れるように、アドレスを部屋の URL にする
    window.history.replaceState(null, "", `${window.location.pathname}?room=${id}`);
    this.lobby.busy("部屋に接続しています…");
    const net = new OnlineSession(
      id,
      wsUrl(id, window.location),
      {
        joined: (m) => {
          if (this.net === net) this.settings!.human = m.you;
        },
        state: (m) => this.net === net && this.onState(m),
        error: (m) => this.net === net && this.onNetError(m),
        conn: (st, attempt) => {
          if (this.net !== net) return;
          // 最初の接続ができないまま（局面が届く前）は、案内の画面でつなぎ直しを知らせる
          if (st === "reconnecting" && !this.game) {
            this.lobby.busy("部屋に接続しています…", `サーバーにつながりません。つなぎ直しています（${attempt} 回目）`);
          }
          if (this.game) this.render();
        },
        ended: (reason, message) => this.net === net && this.onEnded(reason, message),
      },
      browserDeps(),
    );
    this.net = net;
    net.start();
  }

  /** オンライン対戦から抜ける（接続を閉じる。部屋と席はサーバーに残る） */
  private leaveOnline() {
    this.net?.close();
    this.net = null;
    this.room = null;
    this.sending = false;
    this.queued = null;
    this.lobby.close();
    this.renderNet();
  }

  /** オンライン対戦をやめて設定画面へ（アドレスから部屋を外す） */
  private leaveToSetup(rules?: RuleSet) {
    const keep = rules ?? this.settings?.rules;
    this.leaveOnline();
    this.resetPlay();
    this.game = null;
    this.settings = null;
    this.el.game.hidden = true;
    window.history.replaceState(null, "", window.location.pathname);
    this.setup.open(keep);
  }

  /** state が届いた。局面が進んだ（棋譜が伸びた）ときだけ演出し、それ以外（接続の変化・復帰）は描き直すだけ */
  private onState(m: StateMessage) {
    const s = this.settings!;
    const prevRoom = this.room;
    const prev = this.game;
    const first = !prev;
    const grew = !!prev && m.view.history.length > prev.history.length;
    // 大・特大の演出中に届いた手は、演出が終わってから反映する（接続の変化は先に反映してよい）
    if (grew && this.fxLock) {
      this.queued = m;
      this.room = { id: m.roomId, phase: this.room!.phase, opponent: m.opponent };
      this.renderNet();
      return;
    }
    this.room = { id: m.roomId, phase: m.phase, opponent: m.opponent };
    s.human = m.you;
    s.rules = m.view.rules;

    if (!first && !grew) {
      this.notifyRoom(prevRoom, first);
      // 局面は同じ（相手の接続・切断・復帰・自分の復帰）
      if (!this.finale) this.render();
      this.syncLobby();
      return;
    }
    // view は GameState から隠し王の真の状態（kings）を除いたもの。合法手・予測の関数は kings を読まないので、そのまま渡せる
    this.game = m.view as unknown as GameState;
    this.sending = false;
    this.kingOn = false;
    this.notifyRoom(prevRoom, first);
    if (first) {
      // 接続・再読み込み直後: 過去の手は演出しない。終局済みなら結果をそのまま出す
      this.seenEvents = m.view.history.length;
      this.el.game.hidden = false;
      this.renderRuleCard(s.rules);
      this.renderLegend(s.rules);
      this.render();
      this.syncLobby();
      if (m.view.result) this.showResult(m.view.result);
      return;
    }
    this.syncLobby();
    this.afterChange();
  }

  /** 待機中は招待リンクの案内、それ以外は案内を閉じる */
  private syncLobby() {
    const room = this.room;
    if (!room || !this.settings) return;
    if (room.phase === "waiting") {
      if (this.lobby.view !== "invite") {
        this.lobby.invite({
          url: inviteUrl(room.id, window.location),
          rules: this.settings.rules,
          ruleName: ruleName(this.settings.rules),
          you: this.settings.human,
          onLeave: () => this.leaveToSetup(),
        });
      }
    } else if (this.lobby.view === "invite" || this.lobby.view === "busy") {
      this.lobby.close();
    }
  }

  /** 相手の参加・切断・復帰を知らせる */
  private notifyRoom(prev: App["room"], first: boolean) {
    const now = this.room!;
    const me = seatText(this.settings!.human);
    if (first || !prev) {
      // 招待リンクから参加した人
      if (now.phase === "playing" && this.game?.ply === 0) this.showToast(`対局開始！ あなたは${me}です`);
      return;
    }
    if (prev.phase === "waiting" && now.phase === "playing") this.showToast(`相手が参加しました。対局開始！ あなたは${me}です`);
    else if (now.phase === "playing" && prev.opponent.online && !now.opponent.online) this.showToast("相手の接続が切れました。戻るのを待っています");
    else if (now.phase === "playing" && !prev.opponent.online && now.opponent.online) this.showToast("相手が戻りました");
  }

  /** 送った手が拒否された（盤は変わらない） */
  private onNetError(m: ErrorMessage) {
    this.sending = false;
    const text: Partial<Record<ErrorMessage["code"], string>> = {
      not_your_turn: "相手の手番です",
      waiting_opponent: "相手の参加を待っています",
      game_over: "対局はもう終わっています",
      illegal_move: `その手は打てません（${m.message}）`,
    };
    this.showToast(text[m.code] ?? m.message);
    if (this.game) this.render();
  }

  /** つなぎ直さない終わり方（別のタブ・部屋がない・満員・期限切れ） */
  private onEnded(reason: EndReason, message: string) {
    // 終局後に部屋が片付けられたのは正常。盤と結果はそのまま見せる
    if (this.room?.phase === "finished" && (reason === "expired" || reason === "room_not_found")) {
      this.net = null;
      this.renderNet();
      return;
    }
    // 説明は画面側の文に揃える。サーバーの文は理由が決まらないとき（rejected）だけ使う
    this.showEnded(reason, reason === "rejected" ? message : undefined);
  }

  /** つなげない・つながらなくなった理由を案内に出す。lead は理由の前に添える一文 */
  private showEnded(reason: EndReason, lead?: string) {
    const back = { label: "設定画面へ", onClick: () => this.leaveToSetup() };
    const titles: Record<EndReason, [string, string]> = {
      replaced: ["別のタブで開かれました", "この対局が別のタブ（または別の端末）で開かれたため、こちらの接続を閉じました。"],
      room_not_found: ["部屋が見つかりません", "招待リンクが古いか、部屋が片付けられました（放置した部屋は 24 時間、終局後は 1 時間で消えます）。"],
      expired: ["部屋の期限が切れました", "しばらく操作がなかったため、部屋が片付けられました。"],
      room_full: ["この部屋は満員です", "対局できるのは 2 人までです（観戦はできません）。"],
      invalid_token: ["席に戻れませんでした", "保存していた参加の情報がこの部屋と合いません。"],
      rejected: ["部屋に入れませんでした", ""],
    };
    const [title, detail] = titles[reason];
    const text = [lead, detail].filter(Boolean).join(" ");
    const actions =
      reason === "replaced" && this.net
        ? [back, { label: "このタブで続ける", primary: true, id: "resume-here", onClick: () => this.resumeHere() }]
        : [{ ...back, primary: true }];
    if (this.game) this.render();
    this.lobby.error(title, text, actions);
  }

  /** 別のタブに取られた席を、このタブに戻す（もう一方のタブが閉じられる） */
  private resumeHere() {
    this.lobby.busy("部屋に接続しています…");
    this.net?.resume();
  }

  /** /api に届かない公開先（GitHub Pages など）で招待リンクを開いた */
  private showUnavailable() {
    this.lobby.error(
      "オンライン対戦に接続できません",
      "サーバーにつながりませんでした。この公開先ではオンライン対戦を使えないか、通信が切れています。",
      [
        { label: "設定画面へ", onClick: () => this.leaveToSetup() },
        { label: "もう一度試す", primary: true, onClick: () => void this.openRoom(roomIdFromSearch(window.location.search) ?? null) },
      ],
    );
  }

  /** 状態の行の接続表示（相手の接続・自分のつなぎ直し） */
  private renderNet() {
    const el = this.el.net;
    const room = this.room;
    el.hidden = !this.online || !room || !this.game;
    if (el.hidden || !room) return;
    let state: "ok" | "warn" | "bad";
    let text: string;
    if (this.net?.connState === "closed" && !this.game?.result) {
      state = "bad";
      text = "未接続";
    } else if (this.net && !this.net.ready && !this.game?.result) {
      state = "warn";
      text = "再接続中…";
    } else if (room.phase === "waiting") {
      state = "warn";
      text = "相手を待っています";
    } else if (room.opponent.online) {
      state = "ok";
      text = "相手: 接続中";
    } else {
      state = "bad";
      text = "相手: 切断中";
    }
    el.className = `net ${state}`;
    el.textContent = text;
  }

  // ---- 入力 ----

  private onCellClick(r: number, c: number) {
    const g = this.game;
    if (!g || !this.canAct()) return;
    const kind = this.kindFor(g);
    if (!isLegal(g, r, c, kind)) {
      // 裏返すルールで挟めない空きマスを押したときは理由を出す
      if (g.board[r][c] === null && g.rules.action === "flip") {
        // 駒ごとの方向で、選んでいる駒の方向が限られるなら添える（他の駒なら返せることがある）
        const limited = g.rules.dirs === "piece" && PIECES[kind].reach !== "all";
        const reach = limited ? `${PIECES[kind].name}は${dirMark(g.rules, kind)} ${REACH_MARK[PIECES[kind].reach].name}だけ挟める。` : "";
        this.showToast(`${cellName(r, c)} に ${pieceLabel(g.rules, kind)} を置いても返せる駒がありません（${reach}● のマスに置けます）`);
      }
      this.clearFocus();
      return;
    }
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    const samePinned = this.pinned && this.focus?.r === r && this.focus?.c === c;
    // マウス・キーボードは 1 回で確定。タッチは 1 回目で予測、同じマスの 2 回目で確定
    if (!touch || samePinned) {
      if (touch) this.tapLearned = true;
      // 自分で選んだときだけ king を渡す（期限の手の自動指定はエンジンが行う）
      this.place(r, c, kind, this.kingOn && this.kingOf(g, g.turn).canDesignate);
      return;
    }
    this.setFocus(r, c, true);
  }

  private setFocus(r: number, c: number, pin: boolean) {
    const g = this.game;
    if (!g || !this.canAct()) return;
    if (!isLegal(g, r, c, this.kindFor(g))) {
      if (!this.pinned) this.clearFocus();
      return;
    }
    if (this.focus?.r === r && this.focus?.c === c && this.pinned === pin) return;
    this.focus = { r, c };
    this.pinned = pin;
    this.render();
  }

  private clearFocus() {
    if (!this.focus && !this.pinned) return;
    this.focus = null;
    this.pinned = false;
    this.render();
  }

  private selectKind(kind: PieceKind) {
    const g = this.game;
    if (!g || !this.canAct() || !playableKinds(g).includes(kind)) return;
    this.selected[g.turn] = kind;
    // 選び直した駒では置けないマスに予測を固定していたら外す
    if (this.focus && !isLegal(g, this.focus.r, this.focus.c, kind)) {
      this.focus = null;
      this.pinned = false;
    }
    this.render();
  }

  /**
   * p が置く駒。選んだ駒が置けなければ（尽きた・強さ制限で置ける所がない）置ける駒のうち数字の小さいものに切り替える。
   * 手番でない側は持っている駒で判定する
   */
  private kindFor(g: GameState, p: Player = g.turn): PieceKind {
    const kinds = kindsByValue(g.rules, p === g.turn && !g.result ? playableKinds(g) : availableKinds(g.hands[p]));
    if (!kinds.includes(this.selected[p]) && kinds.length > 0) this.selected[p] = kinds[0];
    return this.selected[p];
  }

  /** 手番の人がこの手で置く駒が王になるか（「この駒を王にする」を選んだ・期限の手） */
  private designating(g: GameState): boolean {
    if (!this.canAct()) return false;
    const ki = this.kingOf(g, g.turn);
    return ki.canDesignate && (this.kingOn || ki.forcedNow);
  }

  /**
   * 王の印を見せてよいプレイヤー。CPU 対戦は人間、2 人対戦は「自分の王を確認」を押している手番の人だけ。
   * 終局後は両者（答え合わせ）
   */
  private kingsShown(g: GameState): Player[] {
    if (!g.rules.king.on || !this.settings) return [];
    if (g.result) return [0, 1];
    if (this.settings.mode !== "pvp") return [this.settings.human];
    return this.peek ? [g.turn] : [];
  }

  /** 見せてよい隠れた王のマス → 持ち主 */
  private shownKingCells(g: GameState): Map<number, Player> {
    const out = new Map<number, Player>();
    for (const p of this.kingsShown(g)) {
      const cell = this.kingOf(g, p).cell;
      if (cell) out.set(idx(cell), p);
    }
    return out;
  }

  /** オンライン対戦: 相手の王の候補（view の公開情報。終局後・公開後は空） */
  private oppCandidates(g: GameState): Set<number> {
    if (!this.online || !g.rules.king.on || g.result) return new Set();
    return new Set((g as unknown as PlayerView).oppKing.candidates.map(idx));
  }

  private setPeek(on: boolean) {
    if (this.peek === on) return;
    this.peek = on;
    // 押しているボタンを作り直さないよう、持ち駒欄は描き直さない
    const g = this.game;
    if (!g) return;
    const pv = this.currentPreview(g);
    this.renderBoard(g, pv);
    this.renderPlayers(g);
    this.renderPreview(g, pv);
    this.el.kingBox.querySelector("#king-peek")?.setAttribute("aria-pressed", String(on));
  }

  // ---- 表示 ----

  private name(p: Player) {
    if (this.settings?.mode === "pvp") return PLAYER_NAME[p];
    return `${PLAYER_NAME[p]}（${p === this.settings?.human ? "あなた" : this.foe()}）`;
  }

  /** 相手の呼び方（CPU 対戦は「CPU」、オンライン対戦は「相手」） */
  private foe() {
    return this.online ? "相手" : "CPU";
  }

  /** 持ち駒・警告マークを見せる側（人間の手番ならその人、CPU の手番なら人間） */
  private viewer(g: GameState): Player {
    return this.isHuman(g.turn) ? g.turn : this.settings!.human;
  }

  private currentPreview(g: GameState): Preview | null {
    const f = this.canAct() ? this.focus : null;
    return f ? previewMove(g, f.r, f.c, this.kindFor(g)) : null;
  }

  /** この対局で持ち駒に出てくる駒種（設定で 0 個の駒は出さない。取るルールでは盤上の歩も入りうる）。数字の小さい順 */
  private kindsInGame(g: GameState): PieceKind[] {
    return kindsByValue(
      g.rules,
      KIND_ORDER.filter((k) => g.rules.hand[k] > 0 || (g.rules.action === "capture" && k === "fu") || g.hands[0][k] + g.hands[1][k] > 0),
    );
  }

  private renderRuleCard(r: RuleSet) {
    this.el.rulesName.textContent = `ルール — ${ruleName(r)}`;
    byId("tab-rules4").title = `ルール — ${ruleName(r)}`;
    const lines = ruleLines(r);
    fillSentences(this.el.rulesList, lines);
    this.el.rulesList.classList.toggle("dense", lines.length >= 6);
    // 盤を主役にするため、ルールは引き出しに入れる。横に余裕のある画面（盤の横に置く）では開いて始める
    this.setTab(window.matchMedia("(min-width: 900px)").matches ? "rules4" : null);
  }

  private renderLegend(r: RuleSet) {
    const v = verb(r);
    this.el.legend.replaceChildren(
      h("span", {}, [h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }), ` 置くと${v.can}マス`]),
      h("span", {}, [h("span", { class: "key-take", attrs: { "aria-hidden": "true" } }), ` この手で${v.can}駒`]),
      h("span", {}, [h("span", { class: "key-othello", attrs: { "aria-hidden": "true" } }), " 普通のオセロなら置けるマス"]),
      ...(r.anchor === "attack"
        ? [h("span", {}, [h("span", { class: "key-anchor", attrs: { "aria-hidden": "true" } }), " ダメージに上乗せする端の自分の駒"])]
        : []),
      h("span", {}, [h("span", { class: "key-threat", attrs: { "aria-hidden": "true" }, text: "!" }), ` 相手に次に${v.passive}自分の駒`]),
      ...(r.dirs === "piece"
        ? [h("span", {}, [h("span", { class: "key-dir", attrs: { "aria-hidden": "true" }, text: dirMarks(r) }), " 駒が挟める方向"])]
        : []),
      ...(r.king.on
        ? [h("span", {}, [h("span", { class: "key-king", attrs: { "aria-hidden": "true" }, text: "王" }), " 自分の王（自分にだけ見える）"])]
        : []),
      ...(r.king.on && this.online
        ? [h("span", {}, [h("span", { class: "key-cand", attrs: { "aria-hidden": "true" }, text: "?" }), " 相手の王の候補"])]
        : []),
    );
  }

  private render() {
    const g = this.game;
    if (!g) return;
    const pv = this.currentPreview(g);
    this.placeSeats();
    this.renderBoard(g, pv);
    this.renderPlayers(g);
    this.renderStatus(g);
    this.renderPreview(g, pv);
    this.renderHand(g);
    this.renderKingBox(g);
    this.renderLog(g);
    this.renderNet();
  }

  /** 自分の欄を盤の下、相手の欄を盤の上に置く（2 人対戦は先手が下で固定。同じ端末を挟んで座る） */
  private placeSeats() {
    const bottom: Player = this.settings?.mode === "pvp" ? 0 : (this.settings?.human ?? 0);
    const [low, high] = this.el.seats;
    const mine = this.el.players[bottom];
    const theirs = this.el.players[other(bottom)];
    if (mine.parentElement !== low) low.append(mine);
    if (theirs.parentElement !== high) high.append(theirs);
  }

  private renderBoard(g: GameState, pv: Preview | null) {
    const act = this.canAct();
    const f = pv ? this.focus : null;
    const kind = act ? this.kindFor(g) : null;
    const v = verb(g.rules);
    const open = new Set(kind ? legalCells(g, kind).map(idx) : []);
    // 参考: 普通のオセロのルールで置けるマス（石の色だけで見る。操作できる人の手番だけ）
    const othello = new Set(act ? othelloCells(g.board, g.turn).map(idx) : []);
    const viewer = this.viewer(g);
    // 予測中は「置いた後に返されうる駒」、それ以外は「今、相手が次の手で返せる駒」に警告を出す
    const threat = new Set((pv ? pv.exposed : threatenedPieces(g, viewer)).map(idx));
    const willTake = new Set((pv?.targets ?? []).map(idx));
    // 端の駒の力: 上乗せに使う端の自分の駒 → 足す数字
    const anchors = new Map((pv?.anchors ?? []).map((a) => [idx([a.r, a.c]), g.rules.values[a.kind]]));
    const kings = this.shownKingCells(g);
    const cands = this.oppCandidates(g);
    const designating = this.designating(g);
    const last = lastMoveOf(g);
    this.el.board.classList.toggle("over", !!g.result);
    this.el.board.classList.toggle("acting", act);

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const i = r * SIZE + c;
        const s = g.board[r][c];
        const cell = this.cells[r][c];
        const isFocus = f?.r === r && f?.c === c;
        const isOpen = open.has(i);
        // 裏返すルールでは置けるマス = 返せるマス
        const canTake = isOpen && (g.rules.action === "flip" || targetsAt(g, r, c, kind!).length > 0);
        cell.className = "cell";
        cell.classList.toggle("open", isOpen);
        cell.classList.toggle("can-take", canTake);
        cell.classList.toggle("othello", othello.has(i));
        cell.classList.toggle("focus", isFocus);
        cell.classList.toggle("will-take", willTake.has(i));
        cell.classList.toggle("anchor", anchors.has(i));
        cell.classList.toggle("last", last?.r === r && last?.c === c);
        cell.replaceChildren();
        let label = cellName(r, c);
        // 王の印は、見せてよい人の王だけ（相手の王は終局まで分からない）
        const isKing = (s && kings.get(i) === s.owner) || (isFocus && designating);
        if (s) {
          cell.append(this.stone(s.owner, s.kind, kings.get(i) === s.owner));
          label += ` ${PLAYER_NAME[s.owner]}の${pieceLabel(g.rules, s.kind)}`;
          if (kings.get(i) === s.owner) label += "（王）";
        } else if (isFocus && kind) {
          const ghost = this.stone(g.turn, kind, designating);
          ghost.classList.add("ghost");
          cell.append(ghost);
          if (pv && pv.damage > 0) cell.append(h("span", { class: "dmg-badge", text: `${pv.damage}` }));
          if (pv && pv.heal > 0) cell.append(h("span", { class: "heal-badge", text: `+${pv.heal}` }));
          const bubble = pv && this.bubble(g, pv, r, c);
          if (bubble) cell.append(bubble);
        }
        if (s && s.owner !== viewer && cands.has(i)) {
          cell.append(h("span", { class: "king-cand", text: "?", attrs: { "aria-hidden": "true" } }));
          label += " 相手の王の候補";
        }
        if (threat.has(i)) {
          // 自分の王が返されうるときは強調する
          cell.append(h("span", { class: `threat${isKing ? " king" : ""}`, text: "!", attrs: { "aria-hidden": "true" } }));
          label += isKing ? ` 王が${v.passive}` : ` ${v.passive}`;
        }
        const add = anchors.get(i);
        if (add !== undefined) {
          cell.append(h("span", { class: "anchor-badge", text: `+${add}`, attrs: { "aria-hidden": "true" } }));
          label += ` 端の駒としてダメージに+${add}`;
        }
        if (willTake.has(i)) label += ` ${v.can}`;
        if (canTake) label += ` 置くと${v.can}`;
        if (othello.has(i)) label += " オセロなら置ける";
        cell.setAttribute("aria-label", label);
        cell.disabled = !!g.result;
      }
    }
  }

  /** 駒の表示。挟める方向が「駒ごと」なら方向のマーク（↕ ↔ ✕ ✚ ✱）を石の上部に出す */
  private stone(owner: Player, kind: PieceKind, king = false) {
    const r = this.game?.rules ?? defaultRules();
    const mark = dirMark(r, kind);
    return h("span", { class: `stone p${owner} k-${kind}${king ? " king" : ""}${mark ? " has-dir" : ""}` }, [
      mark ? dirIcon(PIECES[kind].reach, "stone-dir") : null,
      h("span", { class: "stone-name", text: PIECES[kind].name }),
      h("span", { class: "stone-val", text: String(r.values[kind]) }),
      king ? h("span", { class: "king-mark", text: "王", attrs: { "aria-hidden": "true" } }) : null,
    ]);
  }

  /** 置いた後に返されうるもの（予測の吹き出しと詳細で共通）: 置いた駒・自分の王（見せてよいときだけ） */
  private exposure(g: GameState, pv: Preview, r: number, c: number) {
    const placed = pv.exposed.some(([y, x]) => y === r && x === c);
    const kings = this.shownKingCells(g);
    const myKing = [...kings].find(([, owner]) => owner === g.turn)?.[0];
    const king = myKing !== undefined && pv.exposed.some((cell) => idx(cell) === myKing);
    return { placed, myKing, king };
  }

  /**
   * 狙っているマスの吹き出し: 王にして置く・ダメージの内訳（端の駒があるとき）・警告・タッチの置き方（覚えるまで）。
   * 数字はマスのバッジ、文の詳細は引き出しの「予測」。読み上げは「予測」が受け持つので吹き出しは隠す
   */
  private bubble(g: GameState, pv: Preview, r: number, c: number): HTMLElement | null {
    const v = verb(g.rules);
    const designating = this.designating(g);
    const ex = this.exposure(g, pv, r, c);
    const warn = (cls: string, text: string) => h("span", { class: `bb-line bb-warn${cls}` }, [h("span", { class: "bb-mark", text: "!" }), text]);
    const lines: HTMLElement[] = [];
    if (designating) lines.push(h("span", { class: "bb-line bb-king", text: "王にして置く" }));
    if (pv.anchors.length > 0) {
      lines.push(
        h("span", { class: "bb-line bb-sum" }, [
          String(pv.base),
          ...pv.anchors.flatMap((a) => [" ＋ ", h("span", { class: "bb-anchor", text: `端${g.rules.values[a.kind]}` })]),
          ` ＝ ${pv.damage}`,
        ]),
      );
    }
    if (ex.king || (designating && ex.placed)) lines.push(warn(" king", `王が${v.passive}`));
    else if (ex.placed) lines.push(warn("", v.passive));
    else if (pv.exposedDamage > 0) lines.push(warn(" soft", `次に最大 −${pv.exposedDamage}`));
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    if (touch && !this.tapLearned) lines.push(h("span", { class: "bb-line bb-hint", text: "もう一度タップで置く" }));
    if (lines.length === 0) return null;
    // 返す駒・端の駒を隠さないよう、それらがない側（上か下）に出す。両側にあれば盤の外（近い方の縁）に出す
    const rows = [...pv.targets.map(([y]) => y), ...pv.anchors.map((a) => a.r)];
    const up = rows.some((y) => y < r);
    const down = rows.some((y) => y > r);
    let place: string;
    if (!up && r > 0) place = "";
    else if (!down && r < SIZE - 1) place = " below";
    else place = r < SIZE / 2 ? " edge-top" : " edge-bottom";
    const side = c <= 1 ? " to-r" : c >= SIZE - 2 ? " to-l" : "";
    return h(
      "div",
      { class: `pv-bubble${place}${side}`, attrs: { "aria-hidden": "true", style: `--up:${r};--down:${SIZE - 1 - r}` } },
      lines,
    );
  }

  private renderPlayers(g: GameState) {
    const last = lastMoveOf(g);
    const kinds = this.kindsInGame(g);
    const fresh = last?.ply === this.animatePly;
    // 駒台に並んでいる人の持ち駒は名札では省く（同じ数を二重に出さない）
    const onTray = g.result ? null : this.viewer(g);
    for (const p of [0, 1] as const) {
      const el = this.el.players[p];
      const hp = g.hp[p];
      const max = g.rules.hp[p];
      const pct = Math.max(0, Math.min(100, (hp / max) * 100));
      // 直前の手で減った・増えた量（新しい手の直後だけアニメーションさせる）
      let delta: HTMLElement | null = null;
      const lost = last && last.player !== p ? last.damage + (last.king?.penalty ?? 0) : 0;
      if (lost > 0) delta = h("span", { class: `delta${fresh ? " fresh" : ""}`, text: `−${lost}` });
      if (last && last.player === p && last.heal > 0) delta = h("span", { class: `delta heal${fresh ? " fresh" : ""}`, text: `+${last.heal}` });
      // 減った分はゲージに赤く残してから縮める（格闘ゲームの体力ゲージのように。新しい手の直後だけ）
      const ghost =
        fresh && lost > 0
          ? h("span", { class: "hp-ghost", attrs: { style: `left:${pct}%;width:${Math.min(100 - pct, (lost / max) * 100)}%` } })
          : null;
      const turn = !g.result && g.turn === p;
      el.className = `player-card p${p}`;
      el.classList.toggle("active", turn);
      el.classList.toggle("low", hp <= max * 0.25);
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", this.name(p));
      el.replaceChildren(
        h("span", { class: `avatar p${p}`, attrs: { "aria-hidden": "true" } }),
        h("div", { class: "plate" }, [
          h("div", { class: "plate-head" }, [
            h("span", { class: "player-name", text: this.shortName(p), attrs: { title: this.name(p) } }),
            this.kingTag(g, p),
            p === onTray ? null : this.handMini(g, p, kinds),
          ]),
          h(
            "div",
            {
              class: "hp-gauge",
              attrs: {
                role: "meter",
                "aria-label": `${PLAYER_NAME[p]}の体力`,
                "aria-valuemin": "0",
                "aria-valuemax": String(Math.max(max, hp)),
                "aria-valuenow": String(Math.max(0, hp)),
              },
            },
            [
              h("span", { class: "hp-fill", attrs: { style: `width:${pct}%` } }),
              ghost,
              h("span", { class: "hp-text" }, [h("span", { class: "hp-num", text: String(hp) }), h("span", { class: "hp-max", text: `/ ${max}` })]),
              delta,
            ],
          ),
        ]),
      );
    }
  }

  /** 名札の短い名前（2 人対戦は先手・後手、それ以外は あなた／CPU・相手）。正式な名前は title と読み上げ */
  private shortName(p: Player) {
    if (this.settings?.mode === "pvp") return PLAYER_NAME[p];
    return p === this.settings?.human ? "あなた" : this.foe();
  }

  /** 名札の持ち駒（小さな石の角に残り数） */
  private handMini(g: GameState, p: Player, kinds: PieceKind[]) {
    return h(
      "div",
      { class: "hand-mini", attrs: { "aria-label": `${PLAYER_NAME[p]}の持ち駒` } },
      kinds.length === 0
        ? [h("span", { class: "mini empty", text: "持ち駒なし" })]
        : kinds.map((k) =>
            h(
              "span",
              {
                class: `mini${g.hands[p][k] === 0 ? " empty" : ""}`,
                attrs: { "data-owner": String(p), "data-kind": k, title: `${pieceLabel(g.rules, k)} 残り ${g.hands[p][k]}` },
              },
              [h("span", { class: `mini-stone p${p}`, text: PIECES[k].name }), h("span", { class: "mini-count", text: String(g.hands[p][k]) })],
            ),
          ),
    );
  }

  /** 名札の王の状態（王の駒の形とマス名。公開情報と、見せてよい本人の情報だけ） */
  private kingTag(g: GameState, p: Player): HTMLElement | null {
    if (!g.rules.king.on) return null;
    const ki = this.kingOf(g, p);
    const tag = (text: string, title: string, cls = "", id?: string) =>
      h("span", { class: `king-tag${cls}`, attrs: { title, ...(id ? { id } : {}) } }, [h("span", { class: "king-icon", text: "王" }), text]);
    if (ki.status === "revealed") {
      const hit = lastKingHit(g, p);
      return tag(hit ? ` ${cellName(hit.r, hit.c)}` : " ✕", "王は返された（以後ふつうの駒）", " lost");
    }
    if (this.kingsShown(g).includes(p)) {
      if (ki.cell) return tag(` ${cellName(ki.cell[0], ki.cell[1])}`, `王は ${cellName(ki.cell[0], ki.cell[1])}（相手には見えない）`);
      if (ki.canDesignate) return tag(" 未定", "王はまだ決めていない", " unset");
    }
    // オンライン対戦: 相手の王の候補（公開情報）の数。盤では「?」の印
    if (this.online && p !== this.settings?.human) {
      const n = this.oppCandidates(g).size;
      const v = verb(g.rules);
      return tag(` 候補${n}`, `相手の王の候補 ${n} 個（相手が期限内に置き、まだ${v.past.replace(/た$/, "")}ていない駒）`, " cand", "king-cands");
    }
    return tag(" ？", "王の場所は本人にしか見えない", " unknown");
  }

  private renderStatus(g: GameState) {
    let text: string;
    const away = this.online && this.room?.opponent.online === false;
    if (g.result) {
      text = `終局 ${this.resultHeadline(g.result)}・${this.reasonShort(g)}`;
    } else if (this.online && this.room?.phase === "waiting") {
      text = "相手を待っています…";
    } else if (this.online && !this.net?.ready) {
      text = this.net?.connState === "closed" ? "接続を閉じました" : "接続が切れました。つなぎ直しています…";
    } else if (this.online && this.sending) {
      text = "送信中…";
    } else if (!this.isHuman(g.turn)) {
      text = this.online ? (away ? "相手の接続が切れています" : "相手の番") : "CPU が考えています…";
    } else {
      text = this.settings?.mode === "pvp" ? `${PLAYER_NAME[g.turn]}の番` : "あなたの番";
    }
    this.el.status.textContent = text;
    this.el.status.classList.toggle("over", !!g.result);
    this.el.ply.textContent = g.rules.maxPlies > 0 ? `${g.ply} / ${g.rules.maxPlies} 手` : `${g.ply} 手`;
    // 手番の側の木枠の縁を光らせる（操作できる手番は緑、待つ手番は琥珀）
    const frame = this.el.frame;
    const top = this.el.seats[1].contains(this.el.players[g.turn]);
    frame.classList.toggle("turn-top", !g.result && top);
    frame.classList.toggle("turn-bottom", !g.result && !top);
    frame.classList.toggle("turn-act", this.canAct());
  }

  private renderPreview(g: GameState, pv: Preview | null) {
    const box = this.el.preview;
    const v = verb(g.rules);
    box.replaceChildren();
    const f = this.focus;
    if (!pv || !f) {
      box.classList.remove("on");
      box.append(h("h2", { class: "label", text: "予測" }));
      if (g.result) box.append(h("p", { class: "muted", text: "対局は終了しました。" }));
      else if (!this.isHuman(g.turn)) box.append(h("p", { class: "muted", text: `${this.foe()}の手番です。` }));
      else {
        box.append(
          h("p", { class: "muted" }, [
            h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }),
            ` のマスを選ぶと、${v.can}駒とダメージを予測します。`,
          ]),
        );
      }
      const last = lastMoveOf(g);
      if (last) box.append(h("p", { class: "last-move", text: `直前: ${this.moveText(last)}` }));
      return;
    }
    box.classList.add("on");
    const kind = this.kindFor(g);
    const designating = this.designating(g);
    const asKing = designating ? "王にして" : "";
    box.append(h("h2", { class: "label", text: `予測 — ${cellName(f.r, f.c)} に ${pieceLabel(g.rules, kind)}${dirMark(g.rules, kind)} を${asKing}置くと` }));
    if (pv.targets.length === 0) {
      box.append(h("p", { class: "preview-main none", text: `${v.can}駒なし` }));
    } else {
      const names = pv.targets.map(([y, x]) => pieceLabel(g.rules, g.board[y][x]!.kind)).join("・");
      box.append(
        h("p", { class: "preview-main" }, [
          `${names} を${g.rules.action === "flip" ? "返す" : "取る"} → `,
          h("strong", { class: "dmg", text: `${pv.damage} ダメージ` }),
          pv.heal > 0 ? "・" : null,
          pv.heal > 0 ? h("strong", { class: "heal", text: `自分が ${pv.heal} 回復` }) : null,
        ]),
      );
      if (pv.anchors.length > 0) {
        // 内訳（例: 返した駒 2 ＋ 端の金5 ＝ 7）。端の駒は盤上の青枠と同じ色
        const parts = pv.anchors.flatMap((a) => [" ＋ ", h("span", { class: "anchor-part", text: `端の${pieceLabel(g.rules, a.kind)}` })]);
        box.append(h("p", { class: "breakdown" }, [`内訳: ${v.past}駒 ${pv.base}`, ...parts, ` ＝ ${pv.damage}`]));
      }
    }
    // 自分の王が返されうるときは最も強く、置いた駒そのものなら強く、他の駒なら控えめに警告する
    const { placed: placedExposed, myKing, king: kingExposed } = this.exposure(g, pv, f.r, f.c);
    const pen = kingPenaltyText(g.rules);
    // 王にする駒が返されうるなら、置いた駒の警告はこの 1 行にまとめる
    const kingPlacedExposed = designating && placedExposed;
    if (kingPlacedExposed) {
      box.append(h("p", { class: "warn king", text: `！ 王にする ${pieceLabel(g.rules, kind)} は次の相手の手で${v.passive}（${v.hitIf}${pen}）` }));
    } else if (myKing !== undefined && kingExposed) {
      const [y, x] = [Math.floor(myKing / SIZE), myKing % SIZE];
      box.append(
        h("p", {
          class: "warn king",
          text: `！ あなたの王（${cellName(y, x)} の${pieceLabel(g.rules, g.board[y][x]!.kind)}）が次の相手の手で${v.passive}（${v.hitIf}${pen}）`,
        }),
      );
    }
    if (kingPlacedExposed) {
      // 上で警告済み
    } else if (placedExposed) {
      box.append(h("p", { class: "warn", text: `！ ここに置いた ${pieceLabel(g.rules, kind)} は次の相手の手で${v.passive}` }));
    } else if (pv.exposedDamage > 0) {
      box.append(h("p", { class: "warn soft", text: `！ 置いた後、相手は次の手で最大 ${pv.exposedDamage} ダメージ与えられる（! の駒）` }));
    }
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    const hint = touch
      ? `同じマスをもう一度タップすると ${pieceLabel(g.rules, kind)} を${asKing}置きます`
      : `クリックで ${pieceLabel(g.rules, kind)} を${asKing}置きます`;
    box.append(h("p", { class: "hint", text: hint }));
  }

  private renderHand(g: GameState) {
    const box = this.el.handButtons;
    box.replaceChildren();
    this.el.hand.classList.toggle("over", !!g.result);
    if (g.result) {
      this.el.handTitle.textContent = "対局終了";
      const again = h("button", { class: "btn primary", text: this.online ? "新しい部屋で再戦" : "再戦", attrs: { type: "button", id: "btn-rematch" } });
      again.addEventListener("click", () => this.rematch());
      const show = h("button", { class: "btn ghost", text: "結果を見る", attrs: { type: "button" } });
      show.addEventListener("click", () => this.showResult(g.result!));
      box.append(show, again);
      return;
    }
    // 人間の手番ならその人の持ち駒、CPU の手番なら人間の持ち駒を操作不可で出す
    const p = this.viewer(g);
    const act = this.canAct();
    const playable = act ? playableKinds(g) : [];
    const sel = this.kindFor(g, p);
    this.el.handTitle.textContent = `${this.name(p)}の持ち駒`;
    for (const k of this.kindsInGame(g)) {
      const n = g.hands[p][k];
      // 持っているが強さ制限・駒の方向で置ける所がない駒は、斜線で押せないことを示す（理由は読み上げと title）
      const blocked = act && n > 0 && !playable.includes(k);
      const on = sel === k && n > 0 && !blocked;
      const b = h(
        "button",
        {
          class: `piece-btn k-${k}${on ? " selected" : ""}${blocked ? " blocked" : ""}`,
          attrs: {
            type: "button",
            "data-owner": String(p),
            "data-kind": k,
            "aria-pressed": String(on),
            "aria-label": `${PIECES[k].name}（数字 ${g.rules.values[k]}${g.rules.dirs === "piece" ? `・${REACH_MARK[PIECES[k].reach].name}に挟める` : ""}）残り ${n} 個${blocked ? "（置けるマスなし）" : ""}`,
            title: `${pieceLabel(g.rules, k)} 残り ${n}${blocked ? "・置けるマスなし" : ""}`,
          },
        },
        [this.stone(p, k), h("span", { class: "piece-count", text: String(n), attrs: { "aria-hidden": "true" } })],
      );
      b.disabled = !act || n === 0 || blocked;
      b.addEventListener("click", () => this.selectKind(k));
      box.append(b);
    }
  }

  /**
   * 隠し王の操作（駒台の右端の王の駒）: 王の指定（この駒を王にする）・自分の王の確認（2 人対戦）。
   * 王の場所・状態は名札に出すので、ここには操作があるときだけ出す。説明の文は読み上げと title
   */
  private renderKingBox(g: GameState) {
    const box = this.el.kingBox;
    const v = verb(g.rules);
    box.replaceChildren();
    box.hidden = true;
    if (!g.rules.king.on || g.result) return;
    const pvp = this.settings?.mode === "pvp";
    const act = this.canAct();
    const p = this.viewer(g);
    const ki = this.kingOf(g, p);
    const { deadline } = g.rules.king;
    const pen = kingPenaltyText(g.rules);
    if (ki.status === "revealed" || !act) return;
    const piece = (cap: string) => [h("span", { class: "king-piece", text: "王", attrs: { "aria-hidden": "true" } }), h("span", { class: "king-cap", text: cap, attrs: { "aria-hidden": "true" } })];
    if (ki.canDesignate) {
      const forced = ki.forcedNow;
      const on = forced || this.kingOn;
      const left = deadline - ki.nextMove + 1;
      const note = forced
        ? `期限の ${deadline} 手目です。この手で置く駒が自動で王になります。王を${v.hitIf}${pen}`
        : `王を決めてから置く（あと ${left} 手のうち 1 手。${deadline} 手目に置いた駒は自動で王）。王を${v.hitIf}${pen}`;
      const btn = h(
        "button",
        {
          class: `king-toggle${on ? " on" : ""}`,
          attrs: {
            type: "button",
            id: "king-toggle",
            "aria-pressed": String(on),
            "aria-label": forced ? "この手で置く駒が王になる" : "この駒を王にする",
            "aria-describedby": "king-note",
            title: note,
          },
        },
        piece(forced ? "この手で王" : `あと${left}手`),
      );
      btn.disabled = forced;
      btn.addEventListener("click", () => {
        this.kingOn = !this.kingOn;
        this.render();
      });
      box.append(btn, h("p", { class: "king-note sr-only", text: note, attrs: { id: "king-note" } }));
      if (pvp) box.append(h("p", { class: "king-privacy", text: "王を決める間は、相手に画面を見せないでください" }));
      box.hidden = false;
      return;
    }
    if (!pvp || ki.status === "unset") return;
    // 2 人対戦: 押している間だけ、手番の人の王を表示する
    const peek = h(
      "button",
      {
        class: "king-toggle king-peek",
        attrs: { type: "button", id: "king-peek", "aria-pressed": String(this.peek), "aria-label": "自分の王を確認（押している間だけ表示）", title: "押している間だけ自分の王を表示" },
      },
      piece("押して確認"),
    );
    peek.addEventListener("pointerdown", (e) => {
      peek.setPointerCapture?.(e.pointerId);
      this.setPeek(true);
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture", "blur"] as const) {
      peek.addEventListener(ev, () => this.setPeek(false));
    }
    peek.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        this.setPeek(true);
      }
    });
    peek.addEventListener("keyup", () => this.setPeek(false));
    peek.addEventListener("contextmenu", (e) => e.preventDefault());
    box.append(peek);
    box.hidden = false;
  }

  private moveText(e: GameEvent): string {
    if (e.type === "pass") return `${PLAYER_NAME[e.player]} パス（${e.reason === "noPieces" ? "持ち駒切れ" : "置ける所なし"}）`;
    const r = this.game!.rules;
    const head = `${PLAYER_NAME[e.player]} ${pieceLabel(r, e.kind)}→${cellName(e.r, e.c)}`;
    if (e.targets.length === 0) return head;
    const v = verb(r);
    const heal = e.heal > 0 ? ` +${e.heal}回復` : "";
    const king = e.king ? ` 王を${v.past}！（${e.king.lose ? "即負け" : `体力−${e.king.penalty}`}）` : "";
    return `${head} ${e.targets.map((x) => pieceLabel(r, x.kind)).join("・")}を${v.past} ${e.damage}ダメージ${anchorText(r, e)}${heal}${king}`;
  }

  private renderLog(g: GameState) {
    const items = [...g.history].reverse().map((e) =>
      h("li", { class: `log-item ${e.type} p${e.player}${e.type === "move" && e.damage > 0 ? " hit" : ""}${e.type === "move" && e.king ? " king" : ""}` }, [
        h("span", { class: "log-ply", text: e.type === "move" ? String(e.ply) : "—" }),
        h("span", { text: this.moveText(e) }),
      ]),
    );
    this.el.log.replaceChildren(...items);
  }

  // ---- 着手の演出 ----

  /**
   * ダメージ数の表示と、返した駒の裏返り（flip）／取った駒が持ち駒へ飛んでいく（capture）演出、効果音。
   * 段階（impact.ts）が上がるほど数字を大きくし、大・特大は fx.ts の文言・揺れ・粒・発光を重ねる。
   * 特大は返す駒を置いたマスに近い順にめくる溜めのあとで弾ける
   */
  /**
   * 着手の演出の文字（ダメージ・端の駒・王）を、アニメーションでいちばん大きくなったとき（peak 倍）でも
   * 盤の中に収まるよう横にずらす（マスの中央が基準。端に近い列でも画面の横にはみ出さない）
   */
  private fitPop(el: HTMLElement, r: number, c: number, peak: number) {
    const board = this.el.board.getBoundingClientRect();
    const cell = this.cells[r][c].getBoundingClientRect();
    // offsetWidth は transform（拡大・縮小）を含まない、文字の本来の幅
    const half = (el.offsetWidth * peak) / 2;
    const cx = cell.left + cell.width / 2;
    const lo = board.left + half;
    const hi = board.right - half;
    const x = lo > hi ? (board.left + board.right) / 2 : Math.min(hi, Math.max(lo, cx));
    el.style.setProperty("--pop-x", `calc(-50% + ${Math.round(x - cx)}px)`);
  }

  private playMoveEffects(m: MoveEvent, plan: ImpactPlan) {
    const g = this.game!;
    this.sound.place();
    if (m.targets.length === 0) return;
    const { tier, step, burstAt, reduce } = plan;
    // 溜めの後に出すもの（特大のダメージ数・王の印）は、それまで隠しておく
    const delayed = (el: HTMLElement) => {
      if (burstAt > 0) {
        el.classList.add("fx-wait");
        el.style.animationDelay = `${burstAt}ms`;
      }
      return el;
    };
    // 置いたマスにダメージ数を出す（次の描画で消える）
    const pop = m.heal > 0 ? `${m.damage} ダメージ ＋${m.heal} 回復` : `${m.damage} ダメージ`;
    const dmgPop = delayed(h("span", { class: `dmg-pop t-${tier}${plan.hurt ? " hurt" : ""}`, text: pop }));
    this.cells[m.r][m.c].append(dmgPop);
    this.fitPop(dmgPop, m.r, m.c, tier === "huge" ? 1.45 : 1.15);
    // 上乗せに使った端の駒に足した数字を出す
    for (const a of m.anchors ?? []) {
      const anchorPop = h("span", { class: "anchor-pop", text: `+${g.rules.values[a.kind]}` });
      this.cells[a.r][a.c].append(anchorPop);
      this.fitPop(anchorPop, a.r, a.c, 1.15);
    }
    // 王を返した: 王だった駒に「王！」と罰を出す（公開の演出）
    if (m.king) {
      const text = m.king.lose ? "王！" : `王！ −${m.king.penalty}`;
      const kingPop = delayed(h("span", { class: "king-pop", text }));
      this.cells[m.king.r][m.king.c].append(kingPop);
      this.fitPop(kingPop, m.king.r, m.king.c, 1.25);
    }
    // 置いたマスに近い順（特大は 1 つずつめくる）
    const order = [...m.targets].sort((x, y) => Math.max(Math.abs(x.r - m.r), Math.abs(x.c - m.c)) - Math.max(Math.abs(y.r - m.r), Math.abs(y.c - m.c)));
    this.sound.flip(order.length, (step || 60) / 1000);
    if (plan.hit.total > 0) this.sound.hit(tier, plan.hurt, burstAt / 1000);
    this.fx.burst({
      tier,
      hurt: plan.hurt,
      text: plan.text,
      cell: this.cells[m.r][m.c],
      board: this.el.board,
      victim: this.el.players[other(m.player)],
      delay: burstAt,
      reduce,
    });
    if (g.rules.action === "flip") {
      order.forEach((t, i) => {
        const stone = this.cells[t.r][t.c].querySelector<HTMLElement>(".stone");
        if (!stone) return;
        stone.classList.add("flipped");
        if (step > 0) {
          stone.classList.add("fx-wait");
          stone.style.animationDelay = `${i * step}ms`;
        }
      });
      return;
    }
    // 増えた持ち駒の表示を光らせる
    const targets = (k: PieceKind) =>
      [...document.querySelectorAll<HTMLElement>(`[data-owner="${m.player}"][data-kind="${k}"]`)];
    for (const k of new Set(m.targets.map((x) => x.kind))) targets(k).forEach((t) => t.classList.add("gain"));
    if (reduce) return;

    const victim = other(m.player);
    order.forEach((x, i) => {
      const from = this.cells[x.r][x.c].getBoundingClientRect();
      // 画面内に見えている受け取り先（持ち駒パネル優先、なければ体力カード）へ飛ばす
      const dest = targets(x.kind).sort((a, b) => Number(b.matches(".piece-btn")) - Number(a.matches(".piece-btn")));
      const to = (dest.find((t) => inView(t)) ?? dest[0])?.getBoundingClientRect();
      if (!to) return;
      const size = from.width * 0.86;
      const fly = this.stone(victim, x.kind);
      fly.classList.add("flyer");
      fly.style.width = `${size}px`;
      fly.style.left = `${from.left + (from.width - size) / 2}px`;
      fly.style.top = `${from.top + (from.height - size) / 2}px`;
      document.body.append(fly);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const anim = fly.animate(
        [
          { transform: "translate(0, 0) scale(1)", opacity: 1 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) scale(1.1)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.5)`, opacity: 0.2 },
        ],
        { duration: FLY_MS, delay: i * (step || 70), easing: "ease-in-out", fill: "forwards" },
      );
      anim.finished.then(() => fly.remove(), () => fly.remove());
    });
  }

  // ---- 終局・通知・ルール詳細 ----

  /** 決着の目線（CPU 対戦は人間、2 人対戦は勝った側） */
  private outcome(g: GameState): Outcome {
    const s = this.settings!;
    // オンライン対戦は CPU 対戦と同じく自分の目線（負ければ敗北の演出）
    return outcomeOf(g, { mode: s.mode === "pvp" ? "pvp" : "cpu", human: s.human })!;
  }

  /** 決着の演出。finaleMs の後か、タップ／クリック／Enter で終局画面へ進む */
  private playFinale(g: GameState) {
    if (this.game !== g || !g.result) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const o = this.outcome(g);
    this.finale = g;
    this.hideToast();
    this.fx.finale({ outcome: o, reduce, onSkip: () => this.endFinale() });
    this.sound.finale(o.kind);
    this.finaleTimer = window.setTimeout(() => this.endFinale(), finaleMs(reduce));
  }

  private endFinale() {
    const g = this.finale;
    if (!g) return;
    this.finale = null;
    window.clearTimeout(this.finaleTimer);
    this.fx.endFinale();
    if (this.game === g) this.showResult(g.result!);
  }

  private resultHeadline(r: GameResult): string {
    if (r.winner === null) return "引き分け";
    if (this.settings?.mode === "cpu") return r.winner === this.settings.human ? "あなたの勝ち" : "CPU の勝ち";
    if (this.online) return r.winner === this.settings!.human ? "あなたの勝ち" : "相手の勝ち";
    return `${PLAYER_NAME[r.winner]}の勝ち`;
  }

  private reasonShort(g: GameState): string {
    return { ko: "体力 0", limit: `${g.rules.maxPlies} 手で判定`, stalled: "打てる手なしで判定", king: `王を${verb(g.rules).past}` }[
      g.result!.reason
    ];
  }

  private showResult(r: GameResult) {
    const g = this.game!;
    const [d0, d1] = discCount(g.board);
    const loser = r.winner === null ? null : other(r.winner);
    const v = verb(g.rules);
    let judged: string;
    if (r.winner === null) judged = `体力（${g.hp[0]}）も石数（${d0}）も同じで引き分け`;
    else if (r.byDiscs) judged = `体力が同じ（${g.hp[0]}）で、石数 ${d0} 対 ${d1} で${this.name(r.winner)}の勝ち`;
    else judged = `体力 ${g.hp[0]} 対 ${g.hp[1]} で${this.name(r.winner)}の勝ち`;
    const stall = g.ply === 0 ? "最初から両者とも打てない設定" : "両者とも打てる手がなくなった";
    const loserName = loser !== null ? this.name(loser) : "";
    const reason = {
      ko: `${loserName}の体力が 0 になった`,
      limit: `${g.rules.maxPlies} 手で打ち切り。${judged}`,
      stalled: `${stall}。${judged}`,
      king: `${loserName}の王が${v.hit}ので即負け`,
    }[r.reason];
    const o = this.outcome(g);
    this.el.result.dataset.outcome = o.kind;
    byId("result-winner").textContent = this.resultHeadline(r);
    byId("result-reason").textContent = reason;
    this.renderScore(g, d0, d1);
    this.renderStats(g);
    // 負けたときは接戦の励ましを添え、「再戦」を強調する
    const cheer = byId("result-cheer");
    cheer.textContent = o.cheer ?? "";
    cheer.hidden = !o.cheer;
    const rematch = byId("result-rematch");
    rematch.classList.toggle("urge", o.urgeRematch);
    rematch.textContent = this.online ? "新しい部屋で再戦" : "再戦";
    this.hideToast();
    if (!this.el.result.open) this.el.result.showModal();
  }

  /** 終局画面の成績表: 対局者を列に、体力・石数・王（隠し王のとき）を行に。下に手数とルール */
  private renderScore(g: GameState, d0: number, d1: number) {
    const discs = [d0, d1];
    const winner = g.result?.winner ?? null;
    const head = (p: Player) =>
      h("th", { class: `score-head${winner === p ? " won" : ""}`, attrs: { scope: "col" } }, [
        h("span", { class: `avatar p${p}`, attrs: { "aria-hidden": "true" } }),
        this.name(p),
      ]);
    const row = (label: string, cells: [string, string]) =>
      h("tr", {}, [h("th", { text: label, attrs: { scope: "row" } }), h("td", { text: cells[0] }), h("td", { text: cells[1] })]);
    const king = g.rules.king.on ? row("王", [this.kingResult(g, 0), this.kingResult(g, 1)]) : null;
    byId("result-detail").replaceChildren(
      h("table", { class: "score" }, [
        h("thead", {}, [h("tr", {}, [h("td"), head(0), head(1)])]),
        h("tbody", {}, [row("体力", [String(g.hp[0]), String(g.hp[1])]), row("石数", [String(discs[0]), String(discs[1])]), king]),
      ]),
      h("p", { class: "score-foot", text: `${g.ply} 手・ルール ${ruleName(g.rules)}` }),
    );
  }

  /** 終局画面の成績（CPU 対戦は自分だけ、2 人対戦は両者） */
  private renderStats(g: GameState) {
    const stats = statsOf(g);
    const cpu = this.settings?.mode !== "pvp";
    const who: Player[] = cpu ? [this.settings!.human] : [0, 1];
    byId("result-stats").replaceChildren(
      ...who.map((p) =>
        h("section", { class: `stats p${p}`, attrs: { "data-player": String(p) } }, [
          h("h3", { class: "stats-title", text: cpu ? "あなたの成績" : `${PLAYER_NAME[p]}の成績` }),
          h("dl", { class: "stats-list" }, this.statsRows(g, stats[p]).flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
        ]),
      ),
    );
  }

  private statsRows(g: GameState, s: PlayerStats): [string, string][] {
    const r = g.rules;
    const v = verb(r);
    let best = "なし";
    if (s.best) {
      const { move: m, hit } = s.best;
      const parts = [`${v.past}駒 ${m.targets.length} 個で ${hit.base}`];
      if (hit.anchor > 0) parts.push(`端の駒 ${hit.anchor}`);
      if (hit.penalty > 0) parts.push(`王の罰 ${hit.penalty}`);
      best = `${hit.total}（${m.ply} 手目 ${cellName(m.r, m.c)} に${pieceLabel(r, m.kind)}: ${parts.join(" ＋ ")}）`;
    }
    const rows: [string, string][] = [
      ["最大ダメージ", best],
      ["会心以上", `${s.bigHits} 回`],
    ];
    if (r.anchor === "attack") rows.push(["端の駒の上乗せ", `合計 ${s.anchorTotal}`]);
    if (r.king.on) rows.push(["相手の王", s.kingHit ? `${v.past}` : `${v.cannot.slice(0, -1)}かった`]);
    return rows;
  }

  /** 終局後の王の答え合わせ（例: 「d3（隠れたまま）」「e5（返された）」） */
  private kingResult(g: GameState, p: Player): string {
    const ki = this.kingOf(g, p);
    const moved = lastKingHit(g, p);
    if (moved) return `${cellName(moved.r, moved.c)}（${verb(g.rules).hit}）`;
    if (ki.cell) return `${cellName(ki.cell[0], ki.cell[1])}（隠れたまま）`;
    // オンライン対戦では、返されなかった相手の王はサーバーが終局後も送らない
    if (this.online && p !== this.me()) return "？（明かされない）";
    return "なし（決める前に終局）";
  }

  /** ルール詳細ダイアログを設定から作って開く */
  private showRules(rules: RuleSet | null) {
    const r = rules ?? defaultRules();
    const content = byId("rules-content");
    byId("rules-title").textContent = `ルール — ${ruleName(r)}`;
    content.replaceChildren();
    {
      const v = verb(r);
      const list = (tag: "ol" | "ul", items: (string | HTMLElement)[]) => h(tag, {}, items.map((x) => h("li", {}, [x])));
      const ol = h("ol");
      fillSentences(ol, ruleDetails(r));
      content.append(
        h("p", { text: `オセロの盤で、挟んだ相手の駒の数字がダメージになる二人対戦。体力を 0 にした方の勝ち。` }),
        h("h3", { text: "ルール" }),
        ol,
        h("h3", { text: "準備" }),
        list("ul", [
          "8×8 の盤。中央の 4 駒は歩（オセロと同じ配置）",
          `持ち駒（両者同じ・公開）: ${handText(r)}`,
          hpText(r),
        ]),
        h("h3", { text: "決着" }),
        list("ul", endDetails(r)),
        h("h3", { text: "画面の見方" }),
        list("ul", [
          "置く駒を持ち駒から選ぶ（最初は数字の小さい駒が選ばれている）",
          h("span", {}, [h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }), ` の付いたマスは、置くと${v.can}マス`]),
          h("span", {}, [
            `マスにカーソルを乗せる（スマホは 1 回タップ）と、${v.can}駒が `,
            h("span", { class: "key-take", attrs: { "aria-hidden": "true" } }),
            " 赤枠で光り、ダメージと回復を表示。スマホは同じマスをもう一度タップで置く",
          ]),
          h("span", {}, [
            h("span", { class: "key-othello", attrs: { "aria-hidden": "true" } }),
            " の点線の枠は、駒の種類・方向・強さを考えない普通のオセロなら置けるマス（参考。置けるかは駒ごとの印で決まる）",
          ]),
          h("span", {}, [h("span", { class: "key-threat", attrs: { "aria-hidden": "true" }, text: "!" }), ` の付いた自分の駒は、相手が次の 1 手で${v.can}駒`]),
          ...(r.anchor === "attack"
            ? [
                h("span", {}, [
                  "予測中、ダメージに上乗せする端の自分の駒は ",
                  h("span", { class: "key-anchor", attrs: { "aria-hidden": "true" } }),
                  ` 青枠と「+数字」で示す。予測と棋譜にはダメージの内訳（${v.past}駒 ＋ 端の駒）を出す`,
                ]),
              ]
            : []),
          ...(r.dirs === "piece"
            ? [
                `駒の矢印（${dirMarks(r)}）は挟める方向。持ち駒を選び替えると、その駒で${v.can}マスだけに印が付き、予測もその駒の方向で計算する`,
                `「!」は相手の持ち駒の方向で、次の 1 手で${v.can}自分の駒`,
              ]
            : []),
          ...(r.king.on
            ? [
                "隠し王: 王を決める手番では、持ち駒の下の「この駒を王にする」を押してから置く",
                h("span", {}, [
                  h("span", { class: "key-king", attrs: { "aria-hidden": "true" }, text: "王" }),
                  " の印は自分の王。CPU 対戦では常に表示。2 人対戦では「自分の王を確認」を押している間だけ表示する",
                ]),
                h("span", {}, [
                  h("span", { class: "key-threat king", attrs: { "aria-hidden": "true" }, text: "!" }),
                  ` 自分の王が次の 1 手で${v.passive}ときは赤い「!」。相手の駒はどれが王か分からないので、予測のダメージに罰は入らない`,
                ]),
              ]
            : []),
        ]),
      );
    }
    if (!this.el.rules.open) this.el.rules.showModal();
  }

  private showToast(text: string) {
    const t = this.el.toast;
    t.textContent = text;
    t.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), TOAST_MS);
  }

  private hideToast() {
    this.el.toast.hidden = true;
  }
}

/** owner の王が返された手の記録（棋譜の公開情報） */
function lastKingHit(g: GameState, owner: Player) {
  for (const e of g.history) if (e.type === "move" && e.player !== owner && e.king) return e.king;
  return undefined;
}


/** 棋譜のダメージの内訳（上乗せがあるときだけ。例: 「（返した駒2＋端の金5）」） */
function anchorText(r: RuleSet, e: MoveEvent): string {
  const anchors: readonly Target[] = e.anchors ?? [];
  if (anchors.length === 0) return "";
  const bonus = anchors.reduce((n, a) => n + r.values[a.kind], 0);
  return `（${verb(r).past}駒${e.damage - bonus}${anchors.map((a) => `＋端の${pieceLabel(r, a.kind)}`).join("")}）`;
}

/** 対局に出てくる駒の方向のマーク（例: 「↕↔✕✚✱」。同じ方向は 1 回） */
function dirMarks(r: RuleSet): string {
  return [...new Set(kindsInRules(r).map((k) => dirMark(r, k)))].join("");
}

function inView(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
}
