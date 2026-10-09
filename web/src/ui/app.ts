// 画面の制御。ゲームの計算はすべて engine/ に任せ、ここは表示と入力だけを扱う。

import { cellName, discCount, othelloCells, SIZE, type Cell } from "../engine/board";
import { chooseMove, CPU_LEVEL_NAME, DEFAULT_CPU_LEVEL } from "../engine/cpu";
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
  playTimeout,
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
import { TURN_SECONDS, type ErrorMessage, type MatchRecord, type RematchAction, type RoomPhase, type StateMessage } from "../net/protocol";
import { dirIcon } from "./diricon";
import { clockLevel, clockText, cpuTurnSeconds, turnSecondsText, TurnClock } from "./clock";
import { byId, h } from "./dom";
import { finaleMs, Fx, fxTiming, speakerIcon, TOSS_LAND_MS, tossMs, type FxTiming } from "./fx";
import { OnlineDialog } from "./online";
import { hitOf, shownHp, statsOf, tierOf, tierText, type HitBreakdown, type PlayerStats, type Tier } from "./impact";
import { flipRecord, outcomeOf, recordText, type Outcome } from "./outcome";
import { dirMark, endDetails, handText, hpText, kingPenaltyText, pieceLabel, ruleDetails, ruleLines, verb } from "./ruletext";
import { Coach } from "./coach";
import {
  FINISHED_TEXT,
  illegalHint,
  judgeMove,
  LESSONS,
  loadProgress,
  nextNeed,
  progressAt,
  progressLabel,
  resumeStep,
  saveProgress,
  type Lesson,
  type Progress,
} from "./lessons";
import { Menu } from "./menu";
import { cryptoRandom, drawSeat, fillSentences, SetupDialog, type PlaySettings } from "./setup";
import { Sound } from "./sound";

/** CPU が打つまでの待ち時間（盤面の変化を目で追えるように） */
const CPU_DELAY_MS = 900;
/** 最終手を見せてから終局画面を出すまでの待ち時間 */
const RESULT_DELAY_MS = 900;
const TOAST_MS = 2800;
/** 取った駒が持ち駒へ飛んでいくアニメーションの長さ */
const FLY_MS = 650;
/** 制限時間の時計を描き直す間隔（時間切れの判定もこの間隔。残りは時刻の差で数えるので、間隔が延びてもずれない） */
const CLOCK_TICK_MS = 200;

/** 新しい手の演出の計画（段階・攻めた側か受けた側か・文言・長さ） */
interface ImpactPlan extends FxTiming {
  tier: Tier;
  hit: HitBreakdown;
  hurt: boolean;
  text: string | null;
  reduce: boolean;
}

/** 遊び方（チュートリアル）で開いているステップ。solved は正解を打った後（「次へ」を待つ間は盤を操作させない） */
interface LessonRun {
  index: number;
  lesson: Lesson;
  solved: boolean;
  /** 駒台・名札に出す駒（始めの局面の持ち駒にある駒。数字の小さい順） */
  kinds: PieceKind[];
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
  /** 先手・後手の抽選の演出中（終われば対局を動かす） */
  private tossing = false;
  private tossTimer: number | undefined;
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
  /**
   * 1 手ごとの制限時間の時計（手番の人の分）。CPU 対戦・2 人対戦は画面で計って時間切れの手も打つ。
   * オンライン対戦はサーバーの締め切りに合わせて見せるだけ（時間切れの手はサーバーが打つ）
   */
  private readonly clock = new TurnClock();
  private clockTimer: number | undefined;
  /** 対局の通し番号（再戦で棋譜の長さが 0 に戻っても、時計を新しい手番として数え直す） */
  private gameNo = 0;
  /** 名札の時計（手番の人の名札に移す） */
  private readonly clockEl = h("span", { class: "turn-clock", attrs: { id: "turn-clock", role: "timer" } }, [
    h("span", { class: "clock-dial", attrs: { "aria-hidden": "true" } }),
    h("span", { class: "clock-num", attrs: { "aria-hidden": "true" } }),
  ]);

  // ---- オンライン対戦 ----
  /** 部屋への接続（オンライン対戦中だけ） */
  private net: OnlineSession | null = null;
  /**
   * 最後に届いた部屋の状態（局面は this.game に view として入れる）。gameNo はこの部屋の何局目か（state が届く前は 0）。
   * record はこの部屋での自分から見た通算
   */
  private room: {
    id: string;
    phase: RoomPhase;
    gameNo: number;
    opponent: StateMessage["opponent"];
    rematch: StateMessage["rematch"];
    record: MatchRecord;
  } | null = null;
  /** 手を送って、サーバーから state が届くのを待っている */
  private sending = false;
  /** 再戦の申し込み・取り消し・断りを送って、state（または error）を待っている（二重押しを防ぐ） */
  private rematchSending = false;
  /** 演出の間に届いた state（演出が終わってから反映する） */
  private queued: StateMessage | null = null;
  /** 最後に届いたサーバーの時計（seq はその局面の棋譜の長さ、deadline はこの端末の時刻で数えたサーバーの締め切り） */
  private netClock: { seq: number; gameNo: number; limitMs: number; deadline: number } | null = null;
  private readonly lobby = new OnlineDialog();
  /** トークン（部屋ごと）。再読み込みでは残り、別のタブとは共有しない */
  private readonly tokens = safeStore(() => window.sessionStorage);
  /** この端末で作った部屋の記録（自分の招待リンクを開いたときの注意書き） */
  private readonly local = safeStore(() => window.localStorage);

  // ---- 遊び方（チュートリアル） ----
  /** 開いているステップ（チュートリアル中でなければ null） */
  private lesson: LessonRun | null = null;
  /** 進み具合（localStorage。読めなければ null = はじめて） */
  private progress: Progress | null;
  private readonly coach: Coach;

  private readonly cells: HTMLButtonElement[][] = [];
  private readonly setup: SetupDialog;
  private readonly menu: Menu;
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
    this.menu = new Menu({
      cpu: (level) => this.start(this.setup.playSettings("cpu", level)),
      pvp: () => this.start(this.setup.playSettings("pvp")),
      online: () => this.start(this.setup.playSettings("online")),
      learn: () => this.openLesson(resumeStep(this.progress)),
      settings: () => this.setup.open(),
      rules: () => this.showRules(this.setup.current.rules),
      resume: () => this.resume(),
    });
    this.setup = new SetupDialog(
      this.local,
      (r) => this.showRules(r),
      (s) => {
        this.menu.setRuleName(ruleName(s.rules));
        this.showLevelTimes();
        // オンライン対戦の部屋にいる間は、アドレスを部屋の URL のままにする
        if (!this.room) this.setup.reflectUrl(s.rules);
      },
      (text) => this.menu.showNote(text),
    );
    this.menu.setRuleName(ruleName(this.setup.current.rules));
    this.showLevelTimes();
    this.coach = new Coach({
      next: () => this.openLesson((this.lesson?.index ?? 0) + 1),
      again: () => this.openLesson(this.lesson?.index ?? 0),
      jump: (i) => this.openLesson(i),
    });
    this.progress = loadProgress(this.local);
    this.showLearnState();
    this.bindControls();
    // 招待リンク（?room=）から開いたら部屋へ、それ以外はメニューから
    const roomId = roomIdFromSearch(window.location.search);
    if (roomId === undefined) this.showMenu();
    else void this.openRoom(roomId);
    // オンライン対戦の入口は、サーバーに届く公開先でだけ出す（GitHub Pages・vite preview では出さない）
    void checkHealth().then((ok) => {
      if (!ok) return;
      this.menu.enableOnline();
      this.setup.enableOnline();
    });
  }

  // ---- 初期化 ----

  /** メニューの強さのボタンに、保存した設定での制限時間を出す */
  private showLevelTimes() {
    const { timeCpu } = this.setup.current;
    this.menu.setLevelTimes((level) => {
      const t = cpuTurnSeconds(timeCpu, level);
      return t > 0 ? `${t}秒` : "制限なし";
    });
  }

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
    // 遊び方のステップ中は、習っている標準ルール（実戦のルール）の詳細を見せる
    byId("btn-rules").addEventListener("click", () =>
      this.inStep() ? this.showRules(LESSONS[LESSONS.length - 1].rules) : this.showRules(this.settings?.rules ?? null, this.settings ?? undefined),
    );
    byId("btn-menu").addEventListener("click", () => this.showMenu());
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
    byId("result-menu").addEventListener("click", () => {
      result.close();
      this.showMenu();
    });
    byId("result-rematch").addEventListener("click", () => {
      result.close();
      this.rematch();
    });
    // オンライン対戦の再戦（申し込む・受ける・断る・取り消す）は、終局画面と駒台のどちらのボタンでも同じ
    document.addEventListener("click", (e) => {
      const b = (e.target as Element | null)?.closest<HTMLButtonElement>("button[data-rematch]");
      if (b && !b.disabled) this.onRematchClick(b.dataset.rematch as RematchAction | "new");
    });
    // オンライン対戦: 画面に戻った・ネットにつながったら、つなぎ直しの待ち時間を飛ばす
    // 制限時間: 裏に回したタブではタイマーが間引かれるので、戻ったらすぐ時計を見直す（経過した分は時刻の差で減っている）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      this.net?.wake();
      this.tickClock();
    });
    window.addEventListener("online", () => this.net?.wake());
    // 決着の演出・抽選の演出は Enter / Esc（押した時）・スペース（離した時。ボタンの起動と同じ）で飛ばす。
    // 下のボタンが一緒に反応しないよう、演出中のこれらのキーは既定の動作を止める
    const skip = () => (this.finale ? () => this.endFinale() : this.tossing ? () => this.endToss() : null);
    document.addEventListener(
      "keydown",
      (e) => {
        const end = skip();
        if (!end || !["Enter", "Escape", " "].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key !== " " && !e.repeat) end();
      },
      true,
    );
    document.addEventListener(
      "keyup",
      (e) => {
        const end = skip();
        if (!end || e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        end();
      },
      true,
    );
  }

  // ---- 対局の進行 ----

  /** 対局を始める。lesson なら遊び方のステップ（局面はステップが作る。URL は書き換えない） */
  private start(settings: PlaySettings, lesson: LessonRun | null = null) {
    this.menu.hide();
    byId("btn-menu").hidden = false;
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
    this.lesson = lesson;
    if (!lesson) this.setup.reflectUrl(settings.rules);
    this.gameNo++;
    this.game = lesson ? lesson.lesson.start() : createGame(settings.rules);
    this.el.game.hidden = false;
    this.renderRuleCard(settings.rules);
    this.renderLegend(settings.rules);
    this.showCoach();
    this.afterChange();
    // 抽選の結果は石を投げる演出で見せる（終わるまで盤・CPU・時計を止める）
    if (drawn) this.playToss(settings.human);
  }

  /** 対局の途中の状態（タイマー・演出・選択）を捨てる */
  private resetPlay() {
    window.clearTimeout(this.cpuTimer);
    window.clearTimeout(this.resultTimer);
    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.finaleTimer);
    window.clearTimeout(this.tossTimer);
    window.clearTimeout(this.clockTimer);
    this.clock.clear();
    this.fxLock = false;
    this.finale = null;
    this.tossing = false;
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
    // 遊び方は start が lesson を渡したときだけ続ける（ほかの対局・オンラインの部屋では閉じる）
    this.lesson = null;
    this.coach.hide();
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
    // 遊び方: 正解を打った後は「次へ」を待つ
    if (this.lesson?.solved) return false;
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
      // 手を送るだけ。盤はサーバーから state が届いたときに描き直す（拒否されたら error が届く）。
      // 考えた局面の棋譜の長さを添え、時間切れの自動の手と入れ違ったらサーバーに拒否させる
      if (!this.net?.sendMove(r, c, kind, king, this.game.history.length)) {
        this.showToast("接続が切れています。つながったら打ち直してください");
        return;
      }
      this.sending = true;
      this.focus = null;
      this.pinned = false;
      this.render();
      return;
    }
    this.advance(playMove(this.game, r, c, kind, { king }));
  }

  /** 画面で打った手（人間・CPU・時間切れの自動の手）を反映する */
  private advance(next: GameState) {
    this.game = next;
    this.focus = null;
    this.pinned = false;
    this.kingOn = false;
    this.peek = false;
    this.afterChange();
  }

  // ---- 制限時間 ----

  /** 画面で時計を進めてよいか（CPU 対戦・2 人対戦）。操作できる手番で、演出中・決着の演出中・メニューを開いている間は止める */
  private clockShouldRun(): boolean {
    return this.canAct() && !this.finale && !this.menu.visible && !this.el.game.hidden;
  }

  /** 時計を局面に合わせる（描き直すたび。手番が変わったら数え直し、止める条件に合わせて動かす・止める） */
  private syncClock() {
    const g = this.game;
    const s = this.settings;
    window.clearTimeout(this.clockTimer);
    if (!g || !s || g.result) {
      this.clock.clear();
    } else if (this.online) {
      const nc = this.netClock;
      if (nc && nc.seq === g.history.length && this.room?.phase === "playing") this.clock.follow(`net:${nc.gameNo}:${nc.seq}`, nc.limitMs, nc.deadline);
      else this.clock.clear();
    } else if (s.turnSeconds > 0 && this.isHuman(g.turn)) {
      // CPU 対戦は人間の手番だけ（CPU が考えている間は人間の時計は進まない）
      this.clock.reset(`${this.gameNo}:${g.history.length}`, s.turnSeconds * 1000);
      this.clock.setRunning(this.clockShouldRun());
    } else {
      this.clock.clear();
    }
    this.renderClock();
    if (this.clock.current !== null && (this.clock.running || this.online)) {
      this.clockTimer = window.setTimeout(() => this.tickClock(), CLOCK_TICK_MS);
    }
  }

  /** 時計を進める。画面で計る対局で時間切れなら自動で打つ */
  private tickClock() {
    if (this.checkTimeout()) return;
    this.syncClock();
  }

  /**
   * 画面で計る対局の時間切れなら、手番の人の手を置ける手から自動で 1 手打って true。
   * 人の入力の前にも呼び、締め切りを過ぎた入力では打たない（自動の手と二重に打たない）
   */
  private checkTimeout(): boolean {
    const g = this.game;
    if (!g || g.result || this.online || !this.clock.running || !this.clock.expired) return false;
    if (this.clock.current !== `${this.gameNo}:${g.history.length}`) return false;
    window.clearTimeout(this.clockTimer);
    this.clock.clear();
    // 乱数は crypto（Math.random は CPU の乱数と共有。e2e は Math.random を種付きにして CPU の手を再現する）
    this.advance(playTimeout(g, cryptoRandom));
    return true;
  }

  /** 手番の人の名札（名前の右）の時計（色は残りで ok / warn / danger、止めている間は paused）。名札を作り直したら付け直す */
  private renderClock() {
    const el = this.clockEl;
    const g = this.game;
    const name = g ? this.el.players[g.turn].querySelector(".player-name") : null;
    if (this.clock.current === null || !name) {
      el.remove();
      return;
    }
    if (name.nextElementSibling !== el) name.after(el);
    const ms = this.clock.remaining();
    const limit = this.clock.limitMs;
    el.className = `turn-clock ${clockLevel(ms)}${this.clock.running || this.online ? "" : " paused"}`;
    el.style.setProperty("--left", String(limit > 0 ? ms / limit : 0));
    el.querySelector(".clock-num")!.textContent = clockText(ms);
    el.setAttribute("aria-label", `残り ${Math.ceil(ms / 1000)} 秒`);
    el.title = `1 手 ${turnSecondsText(limit / 1000)}。切れたら置ける手から自動で 1 手打つ`;
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
    if (g.result && this.lesson?.lesson.match) this.finishTutorial();
    if (g.result) {
      // 最後の一手の演出（特大なら出し切る）→ 決着の演出 → 終局画面
      this.resultTimer = window.setTimeout(() => this.playFinale(g), g.ply > 0 ? Math.max(RESULT_DELAY_MS, hold + 300) : 0);
    } else {
      this.scheduleCpu(Math.max(CPU_DELAY_MS, hold + 200));
    }
  }

  private scheduleCpu(delay: number) {
    const g = this.game;
    // 遊び方のステップでは CPU は打たない（実戦だけ打つ）
    if (!g || g.result || this.online || this.isHuman(g.turn) || this.inStep()) return;
    this.cpuTimer = window.setTimeout(() => {
      // メニューを開いている間は打たない（「対局に戻る」で読み直す）
      if (this.game !== g || this.menu.visible) return;
      // CPU には自分の視点（相手の王の正体を含まない）だけを渡す
      const ch = chooseMove(viewFor(g, g.turn), this.settings?.level ?? DEFAULT_CPU_LEVEL);
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
    // 遊び方のステップでは、知らせはコーチの 1 文にまとめる（トーストを重ねない）
    if (this.inStep()) return;
    const msgs: string[] = [];
    for (const e of fresh) {
      if (e.type === "pass") {
        const why = e.reason === "noPieces" ? "持ち駒切れ" : "置けるマスなし";
        msgs.push(`${this.shortName(e.player)}は${why}でパス`);
        continue;
      }
      if (e.timeout) {
        msgs.push(`時間切れ。${this.shortName(e.player)}の手を ${cellName(e.r, e.c)} に${pieceLabel(g.rules, e.kind)}で自動で打ちました`);
      }
      if (e.king) {
        const k = e.king;
        const v = verb(g.rules);
        const what = k.lose ? "即負け" : `体力−${k.penalty}`;
        // 自分の王なら「返された」（2 人対戦は me() が null なので「返した」）
        const owner = other(e.player);
        const head = owner === this.me() ? `王を${v.hit}` : `王を${v.past}`;
        msgs.push(`${head}。${this.shortName(owner)}の王は ${cellName(k.r, k.c)} の${pieceLabel(g.rules, k.kind)}、${what}`);
      }
      // CPU 対戦・オンライン対戦では、自分の王が決まったことを本人に知らせる（2 人対戦は相手に見えるので出さない）
      if (e.player === this.me()) {
        const ki = this.kingOf(g, e.player);
        if (ki.cell && ki.cell[0] === e.r && ki.cell[1] === e.c) {
          msgs.push(
            ki.auto
              ? `期限の ${g.rules.king.deadline} 手目なので、${cellName(e.r, e.c)} の${pieceLabel(g.rules, e.kind)}が自動で王になりました`
              : `${cellName(e.r, e.c)} の${pieceLabel(g.rules, e.kind)}を王にしました。${this.foe()}には見えません`,
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

  // ---- 遊び方（チュートリアル） ----

  /** 遊び方の実戦でないステップを開いているか（開いていればそのステップ） */
  private inStep(): LessonRun | null {
    return this.lesson && !this.lesson.lesson.match ? this.lesson : null;
  }

  /** i 番目のステップを始める（前回の位置として覚える） */
  private openLesson(i: number) {
    const lesson = LESSONS[Math.max(0, Math.min(LESSONS.length - 1, i))];
    const index = LESSONS.indexOf(lesson);
    this.progress = progressAt(this.progress, index);
    saveProgress(this.local, this.progress);
    this.showLearnState();
    const { hands } = lesson.start();
    const kinds = kindsByValue(lesson.rules, KIND_ORDER.filter((k) => hands[0][k] + hands[1][k] > 0));
    // 人間が先手・CPU はイージー・制限時間なし（ステップでは CPU も時計も動かない）
    this.start({ mode: "cpu", human: 0, rules: lesson.rules, level: "easy", turnSeconds: 0 }, { index, lesson, solved: false, kinds });
  }

  private showCoach() {
    const run = this.lesson;
    if (!run) {
      this.coach.hide();
      return;
    }
    // 一度でも開いたステップと、終えた後は全部へ移れる
    const open = this.progress?.done ? LESSONS.length - 1 : (this.progress?.reached ?? run.index);
    this.coach.show(run.index, LESSONS.map((l) => l.title), open, run.lesson.lead, run.lesson.task);
  }

  /** 正解を打った: 何が起きたかの 1 文と「次へ」 */
  private lessonSolved(run: LessonRun, before: GameState) {
    const m = lastMoveOf(this.game!);
    if (!m) return;
    const nextIsMatch = !!LESSONS[run.index + 1]?.match;
    this.coach.success(run.lesson.done(m, before), nextIsMatch ? "実戦へ" : "次へ");
  }

  /** 実戦が終わった: 遊び方を終えたことを覚える（勝ち負けは問わない） */
  private finishTutorial() {
    this.progress = { ...progressAt(this.progress, LESSONS.length - 1), done: true };
    saveProgress(this.local, this.progress);
    this.showLearnState();
    this.coach.success(FINISHED_TEXT, null);
  }

  private showLearnState() {
    this.menu.setLearnState(progressLabel(this.progress), this.progress === null);
  }

  /** 遊び方で、盤より先に駒台で選ぶもの（正解の駒・王）。操作できないとき・正解を打った後は何もない */
  private lessonNeed(g: GameState): { kind?: PieceKind; king?: true } {
    const step = this.inStep();
    if (!step || step.solved || !this.canAct()) return {};
    return nextNeed(step.lesson, this.kindFor(g), this.kingOn);
  }

  // ---- オンライン対戦 ----

  /** 対局がある（終局後も盤と「結果を見る」に戻れる）・オンラインの部屋にいる間は、メニューから戻れる */
  private canResume(): boolean {
    return !!this.room || !!this.game;
  }

  /** メニューを出す。対局は止めて残し、「対局に戻る」で続ける（新しい対局を始めたら捨てる） */
  private showMenu() {
    // 抽選の演出は飛ばして結果のままにする（メニューの上に残さない）
    this.endToss();
    window.clearTimeout(this.cpuTimer);
    window.clearTimeout(this.resultTimer);
    if (this.el.result.open) this.el.result.close();
    this.lobby.close();
    this.el.game.hidden = true;
    byId("btn-menu").hidden = true;
    this.menu.show(this.canResume());
    // メニューを開いている間は時計を止める（オンラインはサーバーが計るので止まらない）
    this.syncClock();
  }

  /** メニューから対局へ戻る */
  private resume() {
    this.menu.hide();
    byId("btn-menu").hidden = false;
    if (this.game) {
      this.el.game.hidden = false;
      this.render();
      this.scheduleCpu(CPU_DELAY_MS);
    } else if (this.room) {
      // 相手を待っている部屋（局面がまだない）は案内のダイアログに戻る
      this.syncLobby();
    }
  }

  /** 部屋を作って入る（メニューの「オンライン」・終局後の「新しい部屋で再戦」） */
  private async createOnline(settings: PlaySettings) {
    this.lobby.busy("部屋を作っています…");
    try {
      const turnSeconds = TURN_SECONDS.find((t) => t === settings.turnSeconds) ?? 0;
      const res = await createRoom({ rules: settings.rules, hostSeat: settings.hostSeat ?? "random", turnSeconds });
      saveToken(this.tokens, res.roomId, res.token);
      rememberCreated(this.local, res.roomId);
      this.enterRoom(res.roomId, { ...settings, human: res.you });
    } catch (e) {
      const why = e instanceof OnlineHttpError && e.code === "bad_rules" ? "この設定ではオンラインの部屋を作れません。" : "サーバーにつながりません。";
      this.lobby.error("部屋を作れませんでした", `${why}時間をおいて試してください。`, [
        { label: "メニューへ", onClick: () => this.leaveToMenu() },
        { label: "再試行", primary: true, onClick: () => void this.createOnline(settings) },
      ]);
    }
  }

  /** 招待リンク（?room=）から開いた。保存したトークンがあれば（再読み込み）そのまま席に戻る */
  private async openRoom(id: string | null) {
    this.el.game.hidden = true;
    if (id === null) {
      this.lobby.error("部屋が見つかりません", "招待リンクが途中で切れていないか確かめてください。", [
        { label: "メニューへ", primary: true, onClick: () => this.leaveToMenu() },
      ]);
      return;
    }
    if (loadToken(this.tokens, id)) {
      this.enterRoom(id);
      return;
    }
    this.lobby.busy("部屋を確認中…");
    try {
      const info = await getRoomInfo(id);
      if (!info.open) {
        this.showEnded("room_full", info.phase === "finished" ? "この部屋の対局は終わっています。" : "この部屋には 2 人そろっています。");
        return;
      }
      const name = ruleName(info.rules);
      this.lobby.join({
        rules: info.rules,
        ruleName: name,
        turnSeconds: info.turnSeconds ?? 0,
        createdHere: createdHere(this.local, id),
        onJoin: () => this.enterRoom(id, { mode: "online", human: 0, rules: info.rules, turnSeconds: info.turnSeconds ?? 0 }),
        onCancel: () => this.leaveToMenu(),
      });
    } catch (e) {
      if (e instanceof OnlineHttpError && e.code === "not_found") this.showEnded("room_not_found");
      else this.showUnavailable();
    }
  }

  /** 部屋につなぐ（作成者・参加者・再読み込みの復帰で共通）。席はトークンがあればそれ、なければ空いている席 */
  private enterRoom(id: string, settings?: PlaySettings) {
    this.leaveOnline();
    this.resetPlay();
    this.game = null;
    this.el.game.hidden = true;
    // 再読み込みで戻ったときの制限時間は、届いた state の時計で分かる
    this.settings = settings ?? { mode: "online", human: 0, rules: defaultRules(), turnSeconds: 0 };
    this.room = {
      id,
      phase: "waiting",
      gameNo: 0,
      opponent: { joined: false, online: false, left: false },
      rematch: null,
      record: { wins: 0, losses: 0, draws: 0 },
    };
    // 招待リンクから入ったとき（メニューを通らない）もメニューへ出られるように
    byId("btn-menu").hidden = false;
    this.sending = false;
    this.rematchSending = false;
    this.queued = null;
    this.netClock = null;
    // 再読み込みで同じ部屋に戻れるように、アドレスを部屋の URL にする
    window.history.replaceState(null, "", `${window.location.pathname}?room=${id}`);
    this.lobby.busy("接続中…");
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
            this.lobby.busy("接続中…", `サーバーにつながりません。再接続 ${attempt} 回目`);
          }
          if (this.game) this.render();
          // つながっていない間は終局画面の再戦のボタンも押せない
          this.renderResultActions();
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
    this.rematchSending = false;
    this.queued = null;
    this.netClock = null;
    this.lobby.close();
    this.renderNet();
  }

  /** オンライン対戦をやめてメニューへ（アドレスから部屋を外す） */
  private leaveToMenu() {
    this.leaveOnline();
    this.resetPlay();
    this.game = null;
    this.settings = null;
    window.history.replaceState(null, "", window.location.pathname);
    this.showMenu();
  }

  /**
   * state が届いた。局面が進んだ（棋譜が伸びた）ときだけ演出し、それ以外（接続の変化・復帰・再戦の申し込み）は描き直すだけ。
   * 再戦が成立した（gameNo が増えた）ときは、前の対局の演出・終局画面を片付けて新しい対局を出す
   */
  private onState(m: StateMessage) {
    const s = this.settings!;
    const prevRoom = this.room;
    const prev = this.game;
    const first = !prev;
    const next = !!prev && !!prevRoom && prevRoom.gameNo > 0 && m.gameNo > prevRoom.gameNo;
    const grew = !!prev && !next && m.view.history.length > prev.history.length;
    this.rematchSending = false;
    // サーバーの時計は届いた時刻から数える（端末とサーバーの時計のずれを持ち込まない）。演出の後に反映する局面でも、ここで受け取る
    this.netClock = m.clock
      ? { seq: m.view.history.length, gameNo: m.gameNo, limitMs: m.clock.limitMs, deadline: Date.now() + m.clock.remainingMs }
      : null;
    if (m.clock) s.turnSeconds = m.clock.limitMs / 1000;
    // 大・特大の演出中に届いた手は、演出が終わってから反映する（接続の変化は先に反映してよい）
    if (grew && this.fxLock) {
      this.queued = m;
      this.room = { ...this.room!, id: m.roomId, opponent: m.opponent };
      this.renderNet();
      return;
    }
    this.room = { id: m.roomId, phase: m.phase, gameNo: m.gameNo, opponent: m.opponent, rematch: m.rematch, record: m.record };
    s.human = m.you;
    s.rules = m.view.rules;
    const toss = !next && this.claimToss(m, prevRoom, first);

    if (next) {
      this.startNextGame(m);
      return;
    }

    if (!first && !grew) {
      this.notifyRoom(prevRoom, first, toss);
      // 局面は同じ（相手の接続・切断・復帰・自分の復帰・再戦の申し込み）
      if (!this.finale) this.render();
      this.renderResultActions();
      this.syncLobby();
      if (toss) this.playToss(m.you);
      return;
    }
    // view は GameState から隠し王の真の状態（kings）を除いたもの。合法手・予測の関数は kings を読まないので、そのまま渡せる
    this.game = m.view as unknown as GameState;
    this.sending = false;
    this.kingOn = false;
    this.notifyRoom(prevRoom, first, toss);
    if (first) {
      // 接続・再読み込み直後: 過去の手は演出しない。終局済みなら結果をそのまま出す
      this.seenEvents = m.view.history.length;
      // メニューを開いている間は盤を出さない（「対局に戻る」で出す）
      this.el.game.hidden = this.menu.visible;
      this.renderRuleCard(s.rules);
      this.renderLegend(s.rules);
      this.render();
      this.syncLobby();
      if (m.view.result) this.showResult(m.view.result);
      else if (toss) this.playToss(m.you);
      return;
    }
    this.syncLobby();
    this.afterChange();
  }

  /** 再戦が成立した: 前の対局の演出・終局画面を片付け、先手と後手が入れ替わった新しい対局を出す（過去の手はないので演出しない） */
  private startNextGame(m: StateMessage) {
    this.resetPlay();
    this.queued = null;
    this.sending = false;
    this.gameNo++;
    this.game = m.view as unknown as GameState;
    this.seenEvents = 0;
    this.el.game.hidden = this.menu.visible;
    this.renderRuleCard(m.view.rules);
    this.renderLegend(m.view.rules);
    this.render();
    this.syncLobby();
    this.showToast(`再戦開始　あなたは${PLAYER_NAME[m.you]}`);
  }

  /** 待機中は招待リンクの案内、それ以外は案内を閉じる */
  private syncLobby() {
    const room = this.room;
    if (!room || !this.settings || this.menu.visible) return;
    if (room.phase === "waiting") {
      if (this.lobby.view !== "invite") {
        this.lobby.invite({
          url: inviteUrl(room.id, window.location),
          rules: this.settings.rules,
          ruleName: ruleName(this.settings.rules),
          turnSeconds: this.settings.turnSeconds,
          you: this.settings.human,
          onLeave: () => this.leaveToMenu(),
        });
      }
    } else if (this.lobby.view === "invite" || this.lobby.view === "busy") {
      this.lobby.close();
    }
  }

  /**
   * オンライン: 席を抽選した部屋の 1 局目が始まった（まだ手がない）ところを、このタブで初めて見たら true（抽選の演出を出す）。
   * 見たことは sessionStorage に残し、再読み込みでは出し直さない。メニューを開いている間に始まったら出さない
   */
  private claimToss(m: StateMessage, prev: App["room"], first: boolean): boolean {
    if (!m.seatDraw || m.phase !== "playing" || m.view.history.length > 0 || m.view.result) return false;
    if (!first && prev?.phase !== "waiting") return false;
    if (this.menu.visible) return false;
    const key = `kyosho:toss:${m.roomId}`;
    if (this.tokens.getItem(key)) return false;
    this.tokens.setItem(key, "1");
    return true;
  }

  /** 相手の参加・切断・復帰を知らせる。toss（抽選の演出を出す）なら、手番は演出で見せるので知らせに書かない */
  private notifyRoom(prev: App["room"], first: boolean, toss = false) {
    const now = this.room!;
    const seat = toss ? "" : `　あなたは${PLAYER_NAME[this.settings!.human]}`;
    if (first || !prev) {
      // 招待リンクから参加した人
      if (now.phase === "playing" && this.game?.ply === 0 && !toss) this.showToast(`対局開始${seat}`);
      return;
    }
    if (prev.phase === "waiting" && now.phase === "playing") this.showToast(`相手が参加しました${seat}`);
    else if (now.phase === "playing" && prev.opponent.online && !now.opponent.online) this.showToast("相手の接続が切れました");
    else if (now.phase === "playing" && !prev.opponent.online && now.opponent.online) this.showToast("相手が戻りました");
    else if (now.phase === "finished" && prev.phase === "finished") {
      // 再戦の申し込みの知らせ。終局画面を開いているときはその中の一文（#result-rematch-note）で分かる
      const was = prev.rematch?.opponent ?? "none";
      const is = now.rematch?.opponent ?? "none";
      let text: string | null = null;
      if (!prev.opponent.left && now.opponent.left) text = "相手が退室しました";
      else if (was !== "requested" && is === "requested") text = "相手から再戦の申し込み";
      else if (was !== "declined" && is === "declined") text = "再戦を断られました";
      else if (was === "requested" && is === "none") text = "再戦の申し込みが取り消されました";
      if (text && !this.el.result.open) this.showToast(text);
    }
  }

  /** 送った手が拒否された（盤は変わらない） */
  private onNetError(m: ErrorMessage) {
    this.sending = false;
    this.rematchSending = false;
    // 時間切れの自動の手と入れ違った手・再戦の二重押し（成立した後に届いた古い申し込み）。
    // 自動の手の知らせ（棋譜の timeout）・次の対局の state が先に届いているので、重ねて出さない
    if (m.code === "stale_move" || m.code === "stale_rematch") {
      if (this.game) this.render();
      this.renderResultActions();
      return;
    }
    const text: Partial<Record<ErrorMessage["code"], string>> = {
      not_your_turn: "相手の手番です",
      waiting_opponent: "相手の参加を待っています",
      game_over: "対局はもう終わっています",
      illegal_move: `その手は打てません。${m.message}`,
      opponent_left: "相手が退室しました",
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
    const back = { label: "メニューへ", onClick: () => this.leaveToMenu() };
    const titles: Record<EndReason, [string, string]> = {
      replaced: ["別のタブで開かれました", "別のタブか端末で開いたので、こちらの接続を閉じました。"],
      room_not_found: ["部屋が見つかりません", "部屋は終局から 1 時間、放置すると 24 時間で閉じます。"],
      expired: ["部屋の期限が切れました", "しばらく操作がなかったので、部屋を閉じました。"],
      room_full: ["この部屋は満員です", "対局は 2 人まで。観戦はできません。"],
      invalid_token: ["席に戻れませんでした", "この端末の参加の記録が、この部屋と合いません。"],
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
    this.lobby.busy("接続中…");
    this.net?.resume();
  }

  /** /api に届かない公開先（GitHub Pages など）で招待リンクを開いた */
  private showUnavailable() {
    this.lobby.error(
      "オンライン対戦に接続できません",
      "サーバーにつながりません。この公開先ではオンライン対戦を使えないか、通信が切れています。",
      [
        { label: "メニューへ", onClick: () => this.leaveToMenu() },
        { label: "再試行", primary: true, onClick: () => void this.openRoom(roomIdFromSearch(window.location.search) ?? null) },
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
    } else if (room.opponent.left) {
      state = "bad";
      text = "相手: 退室";
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
    // 締め切りを過ぎてから届いた入力では打たない（先に時間切れの自動の手を打つ）
    if (this.checkTimeout()) return;
    const g = this.game;
    if (!g || !this.canAct()) return;
    const kind = this.kindFor(g);
    if (!isLegal(g, r, c, kind)) {
      const step = this.inStep();
      if (step) {
        // 遊び方: 理由とヒントはコーチに出す
        const hint = illegalHint(step.lesson, g, { r, c, kind, king: this.kingOn });
        if (hint) this.coach.hint(hint);
      } else if (g.board[r][c] === null && g.rules.action === "flip") {
        // 裏返すルールで挟めない空きマスを押したときは理由を出す
        // 駒ごとの方向で、選んでいる駒の方向が限られるなら添える（他の駒なら返せることがある）
        const limited = g.rules.dirs === "piece" && PIECES[kind].reach !== "all";
        const reach = REACH_MARK[PIECES[kind].reach];
        this.showToast(
          limited
            ? `${cellName(r, c)} では返せません。${PIECES[kind].name}は${reach.mark}${reach.short}にだけ挟めます`
            : `${cellName(r, c)} では返せる駒がありません`,
        );
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
      const king = this.kingOn && this.kingOf(g, g.turn).canDesignate;
      const step = this.inStep();
      if (step) {
        // 遊び方: 正解でなければ打たずにヒント。正解なら盤を止めてから打つ（描き直しで操作できない表示にする）
        const hint = judgeMove(step.lesson, g, { r, c, kind, king });
        if (hint) {
          this.coach.hint(hint);
          this.clearFocus();
          return;
        }
        step.solved = true;
      }
      this.place(r, c, kind, king);
      if (step && this.game !== g) this.lessonSolved(step, g);
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
    this.renderClock();
    this.renderPreview(g, pv);
    this.el.kingBox.querySelector("#king-peek")?.setAttribute("aria-pressed", String(on));
  }

  // ---- 表示 ----

  private name(p: Player) {
    if (this.settings?.mode === "pvp") return PLAYER_NAME[p];
    return `${PLAYER_NAME[p]}（${p === this.settings?.human ? "あなた" : this.foe()}）`;
  }

  /** 相手の呼び方（CPU 対戦は「CPU」、オンライン対戦は「相手」） */
  /** CPU 対戦の強さ（終局画面の下の行。CPU 対戦でなければ空） */
  private levelText() {
    return this.settings?.mode === "cpu" ? `・CPU ${CPU_LEVEL_NAME[this.settings.level ?? DEFAULT_CPU_LEVEL]}` : "";
  }

  /** 制限時間（終局画面の下の行。制限なしなら空） */
  private timeText() {
    const t = this.settings?.turnSeconds ?? 0;
    return t > 0 ? `・1 手 ${turnSecondsText(t)}` : "";
  }

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
    // 遊び方のステップは、その局面の持ち駒にある駒だけ（使い切った駒は 0 で残す）
    const step = this.inStep();
    if (step) return step.kinds;
    return kindsByValue(
      g.rules,
      KIND_ORDER.filter((k) => g.rules.hand[k] > 0 || (g.rules.action === "capture" && k === "fu") || g.hands[0][k] + g.hands[1][k] > 0),
    );
  }

  private renderRuleCard(r: RuleSet) {
    // 遊び方のステップは習った分だけのルール（プリセットにない組み合わせ）なので「遊び方」と呼ぶ
    const name = this.inStep() ? "遊び方" : ruleName(r);
    // 見出しは「ルール」と名前を字の太さで分ける（区切りの記号は使わない）
    this.el.rulesName.replaceChildren("ルール ", h("span", { class: "tab-sub", text: name }));
    byId("tab-rules4").title = `${name}のルール`;
    const lines = ruleLines(r);
    fillSentences(this.el.rulesList, lines);
    this.el.rulesList.classList.toggle("dense", lines.length >= 6);
    // 盤を主役にするため、ルールは引き出しに入れる。横に余裕のある画面（盤の横に置く）では開いて始める
    // 遊び方のステップはコーチを主にするので閉じて始める
    this.setTab(window.matchMedia("(min-width: 900px)").matches && !this.inStep() ? "rules4" : null);
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
        ? [h("span", {}, [h("span", { class: "key-king", attrs: { "aria-hidden": "true" }, text: "王" }), " 自分の王。自分にだけ見える"])]
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
    this.syncClock();
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
    // 遊び方: 打つマスを光らせ、駒台で選ぶもの（駒・王）がなければ矢印も出す。1 マスだけのときだけ矢印（候補から選ぶステップは光だけ）
    const step = this.inStep();
    const guides = new Set(act && step && !step.solved ? step.lesson.guide.map(idx) : []);
    const need = this.lessonNeed(g);
    const arrow = guides.size === 1 && !need.kind && !need.king;
    const marks = new Map((step && !step.solved ? (step.lesson.marks ?? []) : []).map((m) => [idx(m.at), m]));
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
        const mark = marks.get(i);
        if (mark) {
          cell.append(h("span", { class: "king-cand lesson-mark", text: mark.text, attrs: { "aria-hidden": "true" } }));
          label += ` ${mark.label}`;
        }
        if (guides.has(i)) {
          cell.classList.add("guide");
          cell.append(...guideMarks(arrow));
          label += " ここに置く";
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
      const hp = shownHp(g.hp[p]);
      const max = g.rules.hp[p];
      const pct = Math.min(100, (hp / max) * 100);
      // 直前の手で減った・増えた量（新しい手の直後だけアニメーションさせる）
      let delta: HTMLElement | null = null;
      const lost = last && last.player !== p ? last.damage + (last.king?.penalty ?? 0) : 0;
      if (lost > 0) delta = h("span", { class: `delta${fresh ? " fresh" : ""}`, text: `−${lost}` });
      if (last && last.player === p && last.heal > 0) delta = h("span", { class: `delta heal${fresh ? " fresh" : ""}`, text: `+${last.heal}` });
      // 減った分はゲージに赤く残してから縮める（格闘ゲームの体力ゲージのように。新しい手の直後だけ）。
      // 幅は手の前の体力（0 で止める前の値に減った分を足す）から今の体力まで
      const ghost =
        fresh && lost > 0
          ? h("span", { class: "hp-ghost", attrs: { style: `left:${pct}%;width:${Math.min(100, ((g.hp[p] + lost) / max) * 100) - pct}%` } })
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
            this.plateRecord(p),
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
                "aria-valuenow": String(hp),
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

  /** オンライン対戦の部屋での、席 p の人から見た通算（オンライン対戦でなければ null） */
  private recordOf(p: Player): MatchRecord | null {
    const room = this.room;
    if (!this.online || !room) return null;
    return p === this.settings!.human ? room.record : flipRecord(room.record);
  }

  /** 名札の通算（オンライン対戦の同じ部屋で 2 局目から） */
  private plateRecord(p: Player): HTMLElement | null {
    const rec = this.recordOf(p);
    if (!rec || this.room!.gameNo < 2) return null;
    const text = recordText(rec);
    return h("span", { class: "plate-record", text, attrs: { title: `この部屋の通算 ${text}` } });
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
    if (this.lesson?.solved) {
      // 遊び方のステップは小さな局面なので、正解の後にどちらも打てず終局することがある。終局とは言わない
      text = "クリア";
    } else if (this.tossing && this.settings) {
      // 抽選の演出中（#fx は読み上げないので、結果はここで伝える）
      text = `抽選で${PLAYER_NAME[this.settings.human]}`;
    } else if (g.result) {
      text = `終局 ${this.resultHeadline(g.result)}・${this.reasonShort(g)}`;
    } else if (this.online && this.room?.phase === "waiting") {
      text = "相手を待っています";
    } else if (this.online && !this.net?.ready) {
      text = this.net?.connState === "closed" ? "接続を閉じました" : "再接続中…";
    } else if (this.online && this.sending) {
      text = "送信中…";
    } else if (!this.isHuman(g.turn)) {
      text = this.online ? (away ? "相手の接続が切れています" : "相手の番") : "CPU 思考中…";
    } else {
      text = this.settings?.mode === "pvp" ? `${PLAYER_NAME[g.turn]}の番` : "あなたの番";
    }
    this.el.status.textContent = text;
    this.el.status.classList.toggle("over", !!g.result && !this.lesson?.solved);
    this.el.ply.textContent = g.rules.maxPlies > 0 ? `${g.ply} / ${g.rules.maxPlies} 手` : `${g.ply} 手`;
    // 手番の側の盤の枠の縁に線を引く（操作できる手番は白、待つ手番はシアン）
    const frame = this.el.frame;
    const top = this.el.seats[1].contains(this.el.players[g.turn]);
    const idle = !!g.result || !!this.lesson?.solved;
    frame.classList.toggle("turn-top", !idle && top);
    frame.classList.toggle("turn-bottom", !idle && !top);
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
      if (g.result) box.append(h("p", { class: "muted", text: "終局" }));
      else if (!this.isHuman(g.turn)) box.append(h("p", { class: "muted", text: `${this.foe()}の番` }));
      else {
        box.append(
          h("p", { class: "muted" }, [
            h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }),
            ` のマスを選ぶと、${v.can}駒とダメージが出ます`,
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
    box.append(h("h2", { class: "label", text: `${cellName(f.r, f.c)} に${pieceLabel(g.rules, kind)}${dirMark(g.rules, kind)}を${asKing}置くと` }));
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
      box.append(h("p", { class: "warn king", text: `！ 王にする${pieceLabel(g.rules, kind)}が次に${v.passive}。${v.hitIf}${pen}` }));
    } else if (myKing !== undefined && kingExposed) {
      const [y, x] = [Math.floor(myKing / SIZE), myKing % SIZE];
      box.append(
        h("p", {
          class: "warn king",
          text: `！ 自分の王 ${cellName(y, x)} の${pieceLabel(g.rules, g.board[y][x]!.kind)}が次に${v.passive}。${v.hitIf}${pen}`,
        }),
      );
    }
    if (kingPlacedExposed) {
      // 上で警告済み
    } else if (placedExposed) {
      box.append(h("p", { class: "warn", text: `！ 置いた${pieceLabel(g.rules, kind)}が次に${v.passive}` }));
    } else if (pv.exposedDamage > 0) {
      box.append(h("p", { class: "warn soft", text: `！ 次の相手の手で最大 ${pv.exposedDamage} ダメージ。! の駒が${v.passive}` }));
    }
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    const hint = touch
      ? `もう一度タップで${asKing}置く`
      : `クリックで${asKing}置く`;
    box.append(h("p", { class: "hint", text: hint }));
  }

  private renderHand(g: GameState) {
    const box = this.el.handButtons;
    box.replaceChildren();
    this.el.hand.classList.toggle("over", !!g.result && !this.inStep());
    // 遊び方のステップで決着した（体力 0 の手）ときは、再戦の鍵を出さず駒台のまま
    if (g.result && !this.inStep()) {
      const show = h("button", { class: "btn ghost", text: "結果を見る", attrs: { type: "button" } });
      show.addEventListener("click", () => this.showResult(g.result!));
      this.el.handTitle.textContent = "対局終了";
      // オンライン対戦は同じ部屋での再戦の申し込み（鍵の上に申し込みの状態の 1 文）
      const online = this.online ? this.rematchControls() : null;
      if (online) {
        const note = online.note ? h("p", { class: "tray-note", attrs: { id: "tray-rematch-note", role: "status" }, text: online.note }) : null;
        box.append(...(note ? [note] : []), show, ...online.buttons);
        return;
      }
      const again = h("button", { class: "btn primary", text: "再戦", attrs: { type: "button", id: "btn-rematch" } });
      again.addEventListener("click", () => this.rematch());
      box.append(show, again);
      return;
    }
    // 人間の手番ならその人の持ち駒、CPU の手番なら人間の持ち駒を操作不可で出す
    const p = this.viewer(g);
    const act = this.canAct();
    const playable = act ? playableKinds(g) : [];
    const sel = this.kindFor(g, p);
    const need = this.lessonNeed(g);
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
        [this.stone(p, k), h("span", { class: "piece-count", text: String(n), attrs: { "aria-hidden": "true" } }), ...(need.kind === k ? guideMarks(true) : [])],
      );
      if (need.kind === k) b.classList.add("guide");
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
      if (this.lessonNeed(g).king) {
        btn.classList.add("guide");
        btn.append(...guideMarks(true));
      }
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
    const head = `${PLAYER_NAME[e.player]} ${pieceLabel(r, e.kind)}→${cellName(e.r, e.c)}${e.timeout ? "（時間切れ・自動）" : ""}`;
    if (e.targets.length === 0) return head;
    const v = verb(r);
    const heal = e.heal > 0 ? ` +${e.heal}回復` : "";
    const king = e.king ? ` 王を${v.past}・${e.king.lose ? "即負け" : `体力−${e.king.penalty}`}` : "";
    return `${head} ${e.targets.map((x) => pieceLabel(r, x.kind)).join("・")}を${v.past} ${e.damage}ダメージ${anchorText(r, e)}${heal}${king}`;
  }

  private renderLog(g: GameState) {
    const items = [...g.history].reverse().map((e) =>
      h("li", { class: `log-item ${e.type} p${e.player}${e.type === "move" && e.damage > 0 ? " hit" : ""}${e.type === "move" && e.king ? " king" : ""}${e.type === "move" && e.timeout ? " timeout" : ""}` }, [
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
   * 盤の中に収まるよう横にずらす（マスの中央が基準。端に近い列でも画面の横にはみ出さない）。
   * 戻り値は最も大きくなったときの横の範囲（画面の座標）
   */
  private fitPop(el: HTMLElement, r: number, c: number, peak: number): [number, number] {
    const board = this.el.board.getBoundingClientRect();
    const cell = this.cells[r][c].getBoundingClientRect();
    // offsetWidth は transform（拡大・縮小）を含まない、文字の本来の幅
    const half = (el.offsetWidth * peak) / 2;
    const cx = cell.left + cell.width / 2;
    const lo = board.left + half;
    const hi = board.right - half;
    const x = lo > hi ? (board.left + board.right) / 2 : Math.min(hi, Math.max(lo, cx));
    el.style.setProperty("--pop-x", `calc(-50% + ${Math.round(x - cx)}px)`);
    return [x - half, x + half];
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
    const [dmgL, dmgR] = this.fitPop(dmgPop, m.r, m.c, tier === "huge" ? 1.45 : 1.15);
    // 上乗せに使った端の駒に足した数字を出す。同じ行・隣の行でダメージ数と横に重なるなら、駒の下に出す
    for (const a of m.anchors ?? []) {
      const anchorPop = h("span", { class: "anchor-pop", text: `+${g.rules.values[a.kind]}` });
      this.cells[a.r][a.c].append(anchorPop);
      const [l, r] = this.fitPop(anchorPop, a.r, a.c, 1.15);
      if (Math.abs(a.r - m.r) <= 1 && l < dmgR && r > dmgL) anchorPop.classList.add("below");
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
    // 遊び方のステップは、体力 0 で勝つ手だけ決着の演出を見せる（打てる手がなくなっただけの終局は演出しない）
    if (this.inStep() && g.result.reason !== "ko") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const o = this.outcome(g);
    this.finale = g;
    this.hideToast();
    this.fx.finale({ outcome: o, reduce, onSkip: () => this.endFinale() });
    this.sound.finale(o.kind);
    this.finaleTimer = window.setTimeout(() => this.endFinale(), finaleMs(reduce));
  }

  /**
   * 先手・後手の抽選の演出（盤の石を投げ、上を向いた色が me の手番）。CPU 対戦の「ランダム」と、オンラインで席を抽選した部屋の 1 局目。
   * 演出の間は fxLock で盤・CPU・時計を止め、終わってから（タップ・Enter で飛ばしても）対局を動かす
   */
  private playToss(me: Player) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.clearTimeout(this.cpuTimer);
    window.clearTimeout(this.tossTimer);
    this.tossing = true;
    this.fxLock = true;
    this.render();
    this.fx.toss({ up: me, who: "あなた", title: PLAYER_NAME[me], reduce, onSkip: () => this.endToss() });
    this.sound.toss(reduce ? 0 : TOSS_LAND_MS / 1000);
    this.tossTimer = window.setTimeout(() => this.endToss(), tossMs(reduce));
  }

  private endToss() {
    if (!this.tossing) return;
    this.tossing = false;
    this.fxLock = false;
    window.clearTimeout(this.tossTimer);
    this.fx.endToss();
    if (!this.game) return;
    this.render();
    this.scheduleCpu(CPU_DELAY_MS);
    // 演出の間に届いた相手の手を反映する（オンライン）
    const q = this.queued;
    this.queued = null;
    if (q) this.onState(q);
  }

  private endFinale() {
    const g = this.finale;
    if (!g) return;
    this.finale = null;
    window.clearTimeout(this.finaleTimer);
    this.fx.endFinale();
    // 遊び方のステップ（体力 0 で勝つ手）は終局画面を出さず、コーチの「次へ」で進む
    if (this.game === g && !this.inStep()) this.showResult(g.result!);
  }

  /**
   * オンライン対戦の終局後の再戦のボタンと一文（申し込みの状態ごと）。ボタンは data-rematch で、押すと onRematchClick。
   * 相手が退室したら同じ部屋では申し込めないので、新しい部屋を作る
   */
  private rematchControls(): { note: string | null; buttons: HTMLButtonElement[] } | null {
    const room = this.room;
    const g = this.game;
    if (!this.online || !room || !g?.result || room.phase !== "finished") return null;
    const urge = this.outcome(g).urgeRematch;
    const key = (action: RematchAction | "new", text: string, primary = false) =>
      h("button", {
        class: `btn ${primary ? "primary" : "ghost"}${primary && urge ? " urge" : ""}`,
        text,
        attrs: { type: "button", "data-rematch": action },
      });
    const r = room.rematch ?? { you: "none", opponent: "none" };
    let note: string | null = null;
    let buttons: HTMLButtonElement[];
    if (room.opponent.left) {
      note = "相手が退室しました";
      buttons = [key("new", "新しい部屋で再戦", true)];
    } else if (r.opponent === "requested") {
      note = "相手から再戦の申し込み";
      buttons = [key("decline", "断る"), key("request", "受ける", true)];
    } else if (r.you === "requested") {
      note = room.opponent.online ? "再戦の返事待ち" : "再戦の返事待ち　相手は切断中";
      buttons = [key("cancel", "取り消し")];
    } else {
      if (r.opponent === "declined") note = "再戦を断られました";
      else if (r.you === "declined") note = "再戦を断りました";
      buttons = [key("request", "再戦", true)];
    }
    // 送った返事を待つ間・つながっていない間は押せない（新しい部屋は作れる）
    const off = this.rematchSending || !this.net?.ready;
    for (const b of buttons) if (b.dataset.rematch !== "new") b.disabled = off;
    return { note, buttons };
  }

  /** 終局画面の下のボタン。オンライン対戦は再戦の申し込みの状態に合わせて差し替える（開いている間も届いた state で描き直す） */
  private renderResultActions() {
    const fixed = byId("result-rematch");
    const box = byId("result-online");
    const note = byId("result-rematch-note");
    const online = this.rematchControls();
    fixed.hidden = this.online;
    box.replaceChildren(...(online?.buttons ?? []));
    note.textContent = online?.note ?? "";
    note.hidden = !online?.note;
  }

  /** 再戦のボタンを押した（終局画面・駒台） */
  private onRematchClick(action: RematchAction | "new") {
    if (action === "new") {
      if (this.el.result.open) this.el.result.close();
      this.rematch();
      return;
    }
    const net = this.net;
    const room = this.room;
    if (!net || !room || !net.sendRematch(action, room.gameNo)) return;
    this.rematchSending = true;
    if (this.game) this.renderHand(this.game);
    this.renderResultActions();
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
    if (r.winner === null) judged = `体力 ${g.hp[0]}・石 ${d0} で並んで引き分け`;
    else if (r.byDiscs) judged = `体力が並び、石数 ${d0} 対 ${d1} で${this.shortName(r.winner)}の勝ち`;
    else judged = `体力 ${g.hp[0]} 対 ${g.hp[1]} で${this.shortName(r.winner)}の勝ち`;
    const stall = g.ply === 0 ? "最初から両者とも打てない設定" : "両者とも打てる手がなくなった";
    const loserName = loser !== null ? this.shortName(loser) : "";
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
    this.renderResultActions();
    this.hideToast();
    if (!this.el.result.open) this.el.result.showModal();
  }

  /** 終局画面の成績表: 対局者を列に、体力・石数・王（隠し王のとき）・通算（オンライン対戦）を行に。下に手数とルール */
  private renderScore(g: GameState, d0: number, d1: number) {
    const discs = [d0, d1];
    const winner = g.result?.winner ?? null;
    const head = (p: Player) =>
      h("th", { class: `score-head${winner === p ? " won" : ""}`, attrs: { scope: "col" } }, [
        h("span", { class: `avatar p${p}`, attrs: { "aria-hidden": "true" } }),
        h("span", { class: "score-name", text: this.shortName(p) }),
        // 2 人対戦は名前が先手・後手なので、手番を重ねて書かない
        this.settings?.mode === "pvp" ? null : h("span", { class: "score-seat", text: PLAYER_NAME[p] }),
      ]);
    const row = (label: string, cells: [string, string]) =>
      h("tr", {}, [h("th", { text: label, attrs: { scope: "row" } }), h("td", { text: cells[0] }), h("td", { text: cells[1] })]);
    const king = g.rules.king.on ? row("王", [this.kingResult(g, 0), this.kingResult(g, 1)]) : null;
    // オンライン対戦は同じ部屋での通算（再戦を続けた分）
    const r0 = this.recordOf(0);
    const r1 = this.recordOf(1);
    const record = r0 && r1 ? row("通算", [recordText(r0), recordText(r1)]) : null;
    byId("result-detail").replaceChildren(
      h("table", { class: "score" }, [
        h("thead", {}, [h("tr", {}, [h("td"), head(0), head(1)])]),
        h("tbody", {}, [row("体力", [String(shownHp(g.hp[0])), String(shownHp(g.hp[1]))]), row("石数", [String(discs[0]), String(discs[1])]), king, record]),
      ]),
      h("p", { class: "score-foot", text: `${g.ply} 手・ルール ${ruleName(g.rules)}${this.levelText()}${this.timeText()}` }),
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
          h(
            "dl",
            { class: "stats-list" },
            this.statsRows(g, stats[p]).flatMap(([k, v]) => [
              h("dt", { text: k }),
              typeof v === "string" ? h("dd", { text: v }) : h("dd", {}, [v[0], h("span", { class: "stats-note", text: ` ${v[1]}` })]),
            ]),
          ),
        ]),
      ),
    );
  }

  /** 成績の行（値が [数字, 添え書き] なら添え書きを薄い字で出す） */
  private statsRows(g: GameState, s: PlayerStats): [string, string | [string, string]][] {
    const r = g.rules;
    const v = verb(r);
    let best: string | [string, string] = "なし";
    if (s.best) {
      const { move: m, hit } = s.best;
      const parts = [`${v.past}駒 ${m.targets.length} 個で ${hit.base}`];
      if (hit.anchor > 0) parts.push(`端の駒 ${hit.anchor}`);
      if (hit.penalty > 0) parts.push(`王の罰 ${hit.penalty}`);
      // 数字を主に、どの手か・内訳は薄い字で添える
      best = [String(hit.total), `${m.ply} 手目 ${cellName(m.r, m.c)} ${pieceLabel(r, m.kind)}・${parts.join(" ＋ ")}`];
    }
    const rows: [string, string | [string, string]][] = [
      ["最大ダメージ", best],
      ["会心以上", `${s.bigHits} 回`],
    ];
    if (r.anchor === "attack") rows.push(["端の駒の上乗せ", `合計 ${s.anchorTotal}`]);
    if (r.king.on) rows.push(["相手の王", s.kingHit ? `${v.past}` : `${v.cannot.slice(0, -1)}かった`]);
    return rows;
  }

  /** 終局後の王の答え合わせ（例: 「d3 隠れたまま」「e5 返された」） */
  private kingResult(g: GameState, p: Player): string {
    const ki = this.kingOf(g, p);
    const moved = lastKingHit(g, p);
    if (moved) return `${cellName(moved.r, moved.c)} ${verb(g.rules).hit}`;
    if (ki.cell) return `${cellName(ki.cell[0], ki.cell[1])} 隠れたまま`;
    // オンライン対戦では、返されなかった相手の王はサーバーが終局後も送らない
    if (this.online && p !== this.me()) return "非公開";
    return "決める前に終局";
  }

  /** ルール詳細ダイアログを設定から作って開く。play（対局中）なら制限時間も載せる */
  private showRules(rules: RuleSet | null, play?: PlaySettings) {
    const r = rules ?? defaultRules();
    const content = byId("rules-content");
    byId("rules-title").textContent = `${ruleName(r)}のルール`;
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
        ...(play && play.turnSeconds > 0
          ? [
              h("h3", { text: "制限時間" }),
              list("ul", [
                `1 手 ${turnSecondsText(play.turnSeconds)}${play.mode === "cpu" ? "（あなたの手番だけ）" : ""}。手番が来るたびに戻る`,
                "切れると、置ける手（駒の種類も含む）から 1 手が自動で打たれる。王を決める期限の手なら、置いた駒が自動で王になる",
                "残りは手番の人の名札の時計。少なくなると琥珀、わずかになると赤に変わる。着手の演出の間は止まる",
              ]),
            ]
          : []),
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

/** 遊び方の誘導の印（脈打つ輪と、arrow なら弾む矢印）。読み上げには出さない */
function guideMarks(arrow: boolean): HTMLElement[] {
  const ring = h("span", { class: "guide-ring", attrs: { "aria-hidden": "true" } });
  return arrow ? [ring, h("span", { class: "guide-arrow", attrs: { "aria-hidden": "true" } })] : [ring];
}

function inView(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
}
