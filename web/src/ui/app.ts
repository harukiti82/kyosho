// 画面の制御。ゲームの計算はすべて engine/ に任せ、ここは表示と入力だけを扱う。

import { cellName, discCount, SIZE, type Cell } from "../engine/board";
import { chooseLookahead } from "../engine/cpu";
import {
  availableKinds,
  createGame,
  isLegal,
  kingInfo,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
  targetsAt,
  threatenedPieces,
  viewFor,
  type GameEvent,
  type GameResult,
  type GameState,
  type MoveEvent,
  type Preview,
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
import { dirIcon } from "./diricon";
import { byId, h } from "./dom";
import { dirMark, endDetails, handText, hpText, kingPenaltyText, pieceLabel, ruleDetails, ruleLines, verb } from "./ruletext";
import { fillSentences, SetupDialog, type PlaySettings } from "./setup";

/** CPU が打つまでの待ち時間（盤面の変化を目で追えるように） */
const CPU_DELAY_MS = 900;
/** 最終手を見せてから終局画面を出すまでの待ち時間 */
const RESULT_DELAY_MS = 900;
const TOAST_MS = 2800;
/** 取った駒が持ち駒へ飛んでいくアニメーションの長さ */
const FLY_MS = 650;

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
  /** トースト通知済みのイベント数 */
  private seenEvents = 0;
  /** 取った・減ったのアニメーションを再生する手数（新しい手の直後の描画だけ） */
  private animatePly = -1;
  /** 隠し王: 手番の人が「この駒を王にする」を選んでいる */
  private kingOn = false;
  /** 隠し王（2 人対戦）: 「自分の王を確認」を押している間 true */
  private peek = false;

  private readonly cells: HTMLButtonElement[][] = [];
  private readonly setup: SetupDialog;
  private readonly el = {
    game: byId("game"),
    board: byId("board"),
    legend: byId("legend"),
    rulesName: byId("rules4-name"),
    rulesList: byId("rules4-list"),
    status: byId("status"),
    ply: byId("ply"),
    players: [byId("player-0"), byId("player-1")] as const,
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
    this.setup.open();
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

  private bindControls() {
    const { result, rules } = this.el;
    byId("btn-rules").addEventListener("click", () => this.showRules(this.settings?.rules ?? null));
    byId("btn-new").addEventListener("click", () => this.setup.open(this.settings?.rules));
    byId("rules-close").addEventListener("click", () => rules.close());
    byId("result-view").addEventListener("click", () => result.close());
    byId("result-setup").addEventListener("click", () => {
      result.close();
      this.setup.open(this.settings?.rules);
    });
    byId("result-rematch").addEventListener("click", () => {
      result.close();
      if (this.settings) this.start(this.settings);
    });
  }

  // ---- 対局の進行 ----

  private start(settings: PlaySettings) {
    window.clearTimeout(this.cpuTimer);
    window.clearTimeout(this.resultTimer);
    this.hideToast();
    document.querySelectorAll(".flyer").forEach((f) => f.remove());
    this.settings = settings;
    this.setup.reflectUrl(settings.rules);
    this.game = createGame(settings.rules);
    this.selected = ["fu", "fu"];
    this.focus = null;
    this.pinned = false;
    this.kingOn = false;
    this.peek = false;
    this.seenEvents = 0;
    this.el.game.hidden = false;
    this.renderRuleCard(settings.rules);
    this.renderLegend(settings.rules);
    this.afterChange();
  }

  private isHuman(p: Player) {
    return this.settings?.mode === "pvp" || p === this.settings?.human;
  }

  private canAct(): boolean {
    return !!this.game && !this.game.result && this.isHuman(this.game.turn);
  }

  private place(r: number, c: number, kind: PieceKind, king = false) {
    if (!this.game) return;
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
    this.animatePly = g.ply;
    this.render();
    this.animatePly = -1;
    const last = lastMoveOf(g);
    if (last?.ply === g.ply && g.ply > 0) this.playMoveEffects(last);
    if (g.result) {
      this.resultTimer = window.setTimeout(() => this.showResult(g.result!), g.ply > 0 ? RESULT_DELAY_MS : 0);
    } else {
      this.scheduleCpu();
    }
  }

  private scheduleCpu() {
    const g = this.game;
    if (!g || g.result || this.isHuman(g.turn)) return;
    this.cpuTimer = window.setTimeout(() => {
      if (this.game !== g) return;
      // CPU には自分の視点（相手の王の正体を含まない）だけを渡す
      const ch = chooseLookahead(viewFor(g, g.turn));
      if (ch) this.place(ch.r, ch.c, ch.kind, ch.king);
    }, CPU_DELAY_MS);
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
      // CPU 対戦では、人間の王が決まったことを本人に知らせる（2 人対戦は相手に見えるので出さない）
      if (this.settings?.mode === "cpu" && e.player === this.settings.human) {
        const ki = kingInfo(g, e.player);
        if (ki.cell && ki.cell[0] === e.r && ki.cell[1] === e.c) {
          msgs.push(
            ki.auto
              ? `期限の ${g.rules.king.deadline} 手目なので、置いた${pieceLabel(g.rules, e.kind)}（${cellName(e.r, e.c)}）が自動であなたの王になりました`
              : `${cellName(e.r, e.c)} の${pieceLabel(g.rules, e.kind)}をあなたの王にしました（CPU には見えません）`,
          );
        }
      }
    }
    if (msgs.length > 0) this.showToast(msgs.join("　"));
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
      // 自分で選んだときだけ king を渡す（期限の手の自動指定はエンジンが行う）
      this.place(r, c, kind, this.kingOn && kingInfo(g, g.turn).canDesignate);
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
    const ki = kingInfo(g, g.turn);
    return ki.canDesignate && (this.kingOn || ki.forcedNow);
  }

  /**
   * 王の印を見せてよいプレイヤー。CPU 対戦は人間、2 人対戦は「自分の王を確認」を押している手番の人だけ。
   * 終局後は両者（答え合わせ）
   */
  private kingsShown(g: GameState): Player[] {
    if (!g.rules.king.on || !this.settings) return [];
    if (g.result) return [0, 1];
    if (this.settings.mode === "cpu") return [this.settings.human];
    return this.peek ? [g.turn] : [];
  }

  /** 見せてよい隠れた王のマス → 持ち主 */
  private shownKingCells(g: GameState): Map<number, Player> {
    const out = new Map<number, Player>();
    for (const p of this.kingsShown(g)) {
      const cell = kingInfo(g, p).cell;
      if (cell) out.set(idx(cell), p);
    }
    return out;
  }

  private setPeek(on: boolean) {
    if (this.peek === on) return;
    this.peek = on;
    // 押しているボタンを作り直さないよう、持ち駒欄は描き直さない
    const g = this.game;
    if (!g) return;
    const pv = this.currentPreview(g);
    this.renderBoard(g, pv);
    this.renderPreview(g, pv);
    this.el.kingBox.querySelector("#king-peek")?.setAttribute("aria-pressed", String(on));
  }

  // ---- 表示 ----

  private name(p: Player) {
    if (this.settings?.mode === "pvp") return PLAYER_NAME[p];
    return `${PLAYER_NAME[p]}（${p === this.settings?.human ? "あなた" : "CPU"}）`;
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
    const lines = ruleLines(r);
    fillSentences(this.el.rulesList, lines);
    this.el.rulesList.classList.toggle("dense", lines.length >= 6);
  }

  private renderLegend(r: RuleSet) {
    const v = verb(r);
    this.el.legend.replaceChildren(
      h("span", {}, [h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }), ` 置くと${v.can}マス`]),
      h("span", {}, [h("span", { class: "key-take", attrs: { "aria-hidden": "true" } }), ` この手で${v.can}駒`]),
      h("span", {}, [h("span", { class: "key-threat", attrs: { "aria-hidden": "true" }, text: "!" }), ` 相手に次に${v.passive}自分の駒`]),
      ...(r.dirs === "piece"
        ? [h("span", {}, [h("span", { class: "key-dir", attrs: { "aria-hidden": "true" }, text: dirMarks(r) }), " 駒が挟める方向"])]
        : []),
      ...(r.king.on
        ? [h("span", {}, [h("span", { class: "key-king", attrs: { "aria-hidden": "true" }, text: "王" }), " 自分の王（自分にだけ見える）"])]
        : []),
    );
  }

  private render() {
    const g = this.game;
    if (!g) return;
    const pv = this.currentPreview(g);
    this.renderBoard(g, pv);
    this.renderPlayers(g);
    this.renderStatus(g);
    this.renderPreview(g, pv);
    this.renderHand(g);
    this.renderKingBox(g);
    this.renderLog(g);
  }

  private renderBoard(g: GameState, pv: Preview | null) {
    const act = this.canAct();
    const f = pv ? this.focus : null;
    const kind = act ? this.kindFor(g) : null;
    const v = verb(g.rules);
    const open = new Set(kind ? legalCells(g, kind).map(idx) : []);
    const viewer = this.viewer(g);
    // 予測中は「置いた後に返されうる駒」、それ以外は「今、相手が次の手で返せる駒」に警告を出す
    const threat = new Set((pv ? pv.exposed : threatenedPieces(g, viewer)).map(idx));
    const willTake = new Set((pv?.targets ?? []).map(idx));
    const kings = this.shownKingCells(g);
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
        cell.classList.toggle("focus", isFocus);
        cell.classList.toggle("will-take", willTake.has(i));
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
        }
        if (threat.has(i)) {
          // 自分の王が返されうるときは強調する
          cell.append(h("span", { class: `threat${isKing ? " king" : ""}`, text: "!", attrs: { "aria-hidden": "true" } }));
          label += isKing ? ` 王が${v.passive}` : ` ${v.passive}`;
        }
        if (willTake.has(i)) label += ` ${v.can}`;
        if (canTake) label += ` 置くと${v.can}`;
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

  private renderPlayers(g: GameState) {
    const last = lastMoveOf(g);
    const kinds = this.kindsInGame(g);
    const fresh = last?.ply === this.animatePly ? " fresh" : "";
    for (const p of [0, 1] as const) {
      const el = this.el.players[p];
      const hp = g.hp[p];
      const max = g.rules.hp[p];
      const pct = Math.max(0, Math.min(100, (hp / max) * 100));
      // 直前の手で減った・増えた量（新しい手の直後だけアニメーションさせる）
      let delta: HTMLElement | null = null;
      const lost = last && last.player !== p ? last.damage + (last.king?.penalty ?? 0) : 0;
      if (lost > 0) delta = h("span", { class: `delta${fresh}`, text: `−${lost}` });
      if (last && last.player === p && last.heal > 0) delta = h("span", { class: `delta heal${fresh}`, text: `+${last.heal}` });
      el.className = `player-card glass p${p}`;
      el.classList.toggle("active", !g.result && g.turn === p);
      el.classList.toggle("low", hp <= max * 0.25);
      el.replaceChildren(
        h("div", { class: "player-head" }, [
          h("span", { class: `dot p${p}`, attrs: { "aria-hidden": "true" } }),
          h("span", { class: "player-name", text: this.name(p) }),
          !g.result && g.turn === p ? h("span", { class: "pill", text: "手番" }) : null,
          this.kingTag(g, p),
        ]),
        h("div", { class: "hp-row" }, [
          h("span", { class: "hp-label", text: "体力" }),
          h("span", { class: "hp-num", text: String(hp) }),
          h("span", { class: "hp-max", text: `/ ${max}` }),
          delta,
        ]),
        h(
          "div",
          {
            class: "hp-bar",
            attrs: {
              role: "meter",
              "aria-label": `${PLAYER_NAME[p]}の体力`,
              "aria-valuemin": "0",
              "aria-valuemax": String(Math.max(max, hp)),
              "aria-valuenow": String(Math.max(0, hp)),
            },
          },
          [h("span", { class: "hp-fill", attrs: { style: `width:${pct}%` } })],
        ),
        h(
          "div",
          { class: "hand-mini", attrs: { "aria-label": `${PLAYER_NAME[p]}の持ち駒` } },
          kinds.length === 0
            ? [h("span", { class: "mini empty", text: "持ち駒なし" })]
            : kinds.map((k) =>
                h(
                  "span",
                  {
                    class: `mini${g.hands[p][k] === 0 ? " empty" : ""}`,
                    attrs: { "data-owner": String(p), "data-kind": k },
                  },
                  [
                    h("span", { class: `mini-stone p${p}`, text: PIECES[k].name }),
                    dirMark(g.rules, k) ? dirIcon(PIECES[k].reach, "mini-dir") : null,
                    `×${g.hands[p][k]}`,
                  ],
                ),
              ),
        ),
      );
    }
  }

  /** 体力カードの王の状態（公開情報と、見せてよい本人の情報だけ） */
  private kingTag(g: GameState, p: Player): HTMLElement | null {
    if (!g.rules.king.on) return null;
    const ki = kingInfo(g, p);
    if (ki.status === "revealed") return h("span", { class: "king-tag lost", text: "王 返された" });
    if (this.kingsShown(g).includes(p)) {
      if (ki.cell) return h("span", { class: "king-tag", text: `王 ${cellName(ki.cell[0], ki.cell[1])}` });
      if (ki.canDesignate) return h("span", { class: "king-tag", text: "王 未定" });
    }
    return h("span", { class: "king-tag", text: "王 ？", attrs: { title: "王の場所は本人にしか見えない" } });
  }

  private renderStatus(g: GameState) {
    let text: string;
    if (g.result) {
      text = `終局 — ${this.resultHeadline(g.result)}（${this.reasonShort(g)}）`;
    } else if (!this.isHuman(g.turn)) {
      text = `${this.name(g.turn)}が考えています…`;
    } else {
      text = `${this.name(g.turn)}の番 — ${pieceLabel(g.rules, this.kindFor(g))}を${this.designating(g) ? "王にして" : ""}置くマスを選んでください`;
      // 王を決められる手番は、操作の場所を添える（スマホでは持ち駒欄が盤の下で見えないことがある）
      if (!this.designating(g) && kingInfo(g, g.turn).canDesignate) text += "（王は持ち駒欄で指定）";
    }
    this.el.status.textContent = text;
    this.el.status.classList.toggle("over", !!g.result);
    this.el.ply.textContent = g.rules.maxPlies > 0 ? `手数 ${g.ply} / ${g.rules.maxPlies}` : `手数 ${g.ply}`;
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
      else if (!this.isHuman(g.turn)) box.append(h("p", { class: "muted", text: "CPU の手番です。" }));
      else {
        box.append(
          h("p", { class: "muted" }, [
            `置けるマスにカーソルを乗せると（スマホは 1 回タップ）、${v.can}駒とダメージを表示します。`,
            h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }),
            ` のマスは置くと${v.can}マス。`,
            g.rules.dirs === "piece" ? "持ち駒を選び替えると、その駒の矢印の方向で返せるマスに印が付きます。" : null,
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
    }
    // 自分の王が返されうるときは最も強く、置いた駒そのものなら強く、他の駒なら控えめに警告する
    const placedExposed = pv.exposed.some(([y, x]) => y === f.r && x === f.c);
    const kings = this.shownKingCells(g);
    const myKing = [...kings].find(([, owner]) => owner === g.turn)?.[0];
    const pen = kingPenaltyText(g.rules);
    // 王にする駒が返されうるなら、置いた駒の警告はこの 1 行にまとめる
    const kingPlacedExposed = designating && placedExposed;
    if (kingPlacedExposed) {
      box.append(h("p", { class: "warn king", text: `！ 王にする ${pieceLabel(g.rules, kind)} は次の相手の手で${v.passive}（${v.hitIf}${pen}）` }));
    } else if (myKing !== undefined && pv.exposed.some((cell) => idx(cell) === myKing)) {
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
    if (g.result) {
      this.el.handTitle.textContent = "対局終了";
      const again = h("button", { class: "btn primary", text: "再戦", attrs: { type: "button", id: "btn-rematch" } });
      again.addEventListener("click", () => this.settings && this.start(this.settings));
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
    this.el.handTitle.textContent = `${this.name(p)}の持ち駒 — 置く駒を選ぶ`;
    for (const k of this.kindsInGame(g)) {
      const n = g.hands[p][k];
      // 持っているが強さ制限・駒の方向で置ける所がない駒は、押せない理由を添える
      const blocked = act && n > 0 && !playable.includes(k);
      const on = sel === k && n > 0 && !blocked;
      const b = h(
        "button",
        {
          class: `piece-btn k-${k}${on ? " selected" : ""}`,
          attrs: {
            type: "button",
            "data-owner": String(p),
            "data-kind": k,
            "aria-pressed": String(on),
            "aria-label": `${PIECES[k].name}（数字 ${g.rules.values[k]}${g.rules.dirs === "piece" ? `・${REACH_MARK[PIECES[k].reach].name}に挟める` : ""}）残り ${n} 個${blocked ? "（置けるマスなし）" : ""}`,
          },
        },
        [
          this.stone(p, k),
          h("span", { class: "piece-count", text: `×${n}` }),
          blocked ? h("span", { class: "piece-blocked", text: "置けない" }) : null,
        ],
      );
      b.disabled = !act || n === 0 || blocked;
      b.addEventListener("click", () => this.selectKind(k));
      box.append(b);
    }
  }

  /** 隠し王の操作欄: 王の指定（この駒を王にする）・自分の王の確認（2 人対戦）・状態の説明 */
  private renderKingBox(g: GameState) {
    const box = this.el.kingBox;
    const v = verb(g.rules);
    box.replaceChildren();
    box.hidden = !g.rules.king.on || !!g.result;
    if (box.hidden) return;
    const pvp = this.settings?.mode === "pvp";
    const act = this.canAct();
    // 自分の王の状態を出すのは、操作している人（CPU 対戦では CPU の手番中も人間）
    const p = this.viewer(g);
    const ki = kingInfo(g, p);
    const { deadline } = g.rules.king;
    const pen = kingPenaltyText(g.rules);

    if (ki.status === "revealed") {
      box.append(h("p", { class: "king-note", text: `${pvp ? `${PLAYER_NAME[p]}の` : "あなたの"}王は${v.hit}（以後ふつうの駒）` }));
      return;
    }
    if (ki.canDesignate && act) {
      const forced = ki.forcedNow;
      const on = forced || this.kingOn;
      const btn = h(
        "button",
        {
          class: `king-toggle${on ? " on" : ""}`,
          attrs: { type: "button", id: "king-toggle", "aria-pressed": String(on) },
        },
        [h("span", { class: "key-king", text: "王", attrs: { "aria-hidden": "true" } }), forced ? "この手で置く駒が王になる" : "この駒を王にする"],
      );
      btn.disabled = forced;
      btn.addEventListener("click", () => {
        this.kingOn = !this.kingOn;
        this.render();
      });
      const left = deadline - ki.nextMove + 1;
      const note = forced
        ? `期限の ${deadline} 手目です。この手で置く駒が自動で王になります。王を${v.hitIf}${pen}`
        : `王を決めてから置く（あと ${left} 手のうち 1 手。${deadline} 手目に置いた駒は自動で王）。王を${v.hitIf}${pen}`;
      box.append(btn, h("p", { class: "king-note", text: note }));
      if (pvp) box.append(h("p", { class: "king-privacy", text: "王を決める間は、相手に画面を見せないでください" }));
      return;
    }
    if (ki.status === "unset") {
      // CPU の手番中など。まだ決めていない
      box.append(h("p", { class: "king-note", text: `王はまだ決まっていません（最初の ${deadline} 手のうちに決める）` }));
      return;
    }
    if (!pvp) {
      const [y, x] = ki.cell!;
      box.append(
        h("p", { class: "king-note" }, [
          h("span", { class: "key-king", text: "王", attrs: { "aria-hidden": "true" } }),
          ` あなたの王: ${cellName(y, x)} の${pieceLabel(g.rules, g.board[y][x]!.kind)}（CPU には見えない。${v.hitIf}${pen}）`,
        ]),
      );
      return;
    }
    if (!act) return;
    // 2 人対戦: 押している間だけ、手番の人の王を表示する
    const peek = h(
      "button",
      { class: "btn ghost king-peek", attrs: { type: "button", id: "king-peek", "aria-pressed": String(this.peek) } },
      [h("span", { class: "key-king", text: "王", attrs: { "aria-hidden": "true" } }), " 自分の王を確認（押している間だけ表示）"],
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
  }

  private moveText(e: GameEvent): string {
    if (e.type === "pass") return `${PLAYER_NAME[e.player]} パス（${e.reason === "noPieces" ? "持ち駒切れ" : "置ける所なし"}）`;
    const r = this.game!.rules;
    const head = `${PLAYER_NAME[e.player]} ${pieceLabel(r, e.kind)}→${cellName(e.r, e.c)}`;
    if (e.targets.length === 0) return head;
    const v = verb(r);
    const heal = e.heal > 0 ? ` +${e.heal}回復` : "";
    const king = e.king ? ` 王を${v.past}！（${e.king.lose ? "即負け" : `体力−${e.king.penalty}`}）` : "";
    return `${head} ${e.targets.map((x) => pieceLabel(r, x.kind)).join("・")}を${v.past} ${e.damage}ダメージ${heal}${king}`;
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

  /** ダメージ数の表示と、返した駒の裏返り（flip）／取った駒が持ち駒へ飛んでいく（capture）演出 */
  private playMoveEffects(m: MoveEvent) {
    if (m.targets.length === 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 置いたマスにダメージ数を出す（次の描画で消える）
    const pop = m.heal > 0 ? `${m.damage} ダメージ ＋${m.heal} 回復` : `${m.damage} ダメージ`;
    this.cells[m.r][m.c].append(h("span", { class: "dmg-pop", text: pop }));
    // 王を返した: 王だった駒に「王！」と罰を出す（公開の演出）
    if (m.king) {
      const text = m.king.lose ? "王！" : `王！ −${m.king.penalty}`;
      this.cells[m.king.r][m.king.c].append(h("span", { class: "king-pop", text }));
    }
    if (this.game!.rules.action === "flip") {
      for (const t of m.targets) this.cells[t.r][t.c].querySelector(".stone")?.classList.add("flipped");
      return;
    }
    // 増えた持ち駒の表示を光らせる
    const targets = (k: PieceKind) =>
      [...document.querySelectorAll<HTMLElement>(`[data-owner="${m.player}"][data-kind="${k}"]`)];
    for (const k of new Set(m.targets.map((x) => x.kind))) targets(k).forEach((t) => t.classList.add("gain"));
    if (reduce) return;

    const victim = other(m.player);
    m.targets.forEach((x, i) => {
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
        { duration: FLY_MS, delay: i * 70, easing: "ease-in-out", fill: "forwards" },
      );
      anim.finished.then(() => fly.remove(), () => fly.remove());
    });
  }

  // ---- 終局・通知・ルール詳細 ----

  private resultHeadline(r: GameResult): string {
    if (r.winner === null) return "引き分け";
    if (this.settings?.mode === "cpu") return r.winner === this.settings.human ? "あなたの勝ち" : "CPU の勝ち";
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
    let judged: string;
    if (r.winner === null) judged = `体力（${g.hp[0]}）も石数（${d0}）も同じなので引き分け`;
    else if (r.byDiscs) judged = `体力が同じ（${g.hp[0]}）なので、石数 ${d0} 対 ${d1} で${this.name(r.winner)}の勝ち`;
    else judged = `体力 ${g.hp[0]} 対 ${g.hp[1]} で${this.name(r.winner)}の勝ち`;
    const stall = g.ply === 0 ? "最初から両者とも打てない設定のため終局" : "両者とも打てる手がなくなって終局";
    const reason = {
      ko: `体力 0 — ${loser !== null ? this.name(loser) : ""}の体力が 0 以下になりました`,
      limit: `${g.rules.maxPlies} 手に達して打ち切り — ${judged}`,
      stalled: `${stall} — ${judged}`,
      king: `王を${verb(g.rules).past} — ${loser !== null ? this.name(loser) : ""}の王が${verb(g.rules).hit}ので即負け`,
    }[r.reason];
    byId("result-winner").textContent = this.resultHeadline(r);
    byId("result-reason").textContent = reason;
    byId("result-detail").textContent =
      `${this.name(0)} 体力 ${g.hp[0]} ／ ${this.name(1)} 体力 ${g.hp[1]} ／ 石数 ${d0} 対 ${d1}（${g.ply} 手・ルール ${ruleName(g.rules)}）` +
      this.kingSummary(g);
    this.hideToast();
    if (!this.el.result.open) this.el.result.showModal();
  }

  /** 終局後の王の答え合わせ（例: 「／ 王: 先手 d3（隠れたまま）・後手 e5（返された）」） */
  private kingSummary(g: GameState): string {
    if (!g.rules.king.on) return "";
    const one = (p: Player) => {
      const ki = kingInfo(g, p);
      const moved = lastKingHit(g, p);
      if (moved) return `${PLAYER_NAME[p]} ${cellName(moved.r, moved.c)}（${verb(g.rules).hit}）`;
      if (ki.cell) return `${PLAYER_NAME[p]} ${cellName(ki.cell[0], ki.cell[1])}（隠れたまま）`;
      return `${PLAYER_NAME[p]} なし（決める前に終局）`;
    };
    return ` ／ 王: ${one(0)}・${one(1)}`;
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
          h("span", {}, [h("span", { class: "key-threat", attrs: { "aria-hidden": "true" }, text: "!" }), ` の付いた自分の駒は、相手が次の 1 手で${v.can}駒`]),
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

/** 対局に出てくる駒の方向のマーク（例: 「↕↔✕✚✱」。同じ方向は 1 回） */
function dirMarks(r: RuleSet): string {
  return [...new Set(kindsInRules(r).map((k) => dirMark(r, k)))].join("");
}

function inView(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
}
