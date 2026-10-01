// 画面の制御。ゲームの計算はすべて engine/ に任せ、ここは表示と入力だけを扱う。

import { cellName, discCount, SIZE, type Cell } from "../engine/board";
import { chooseLookahead } from "../engine/cpu";
import {
  availableKinds,
  createGame,
  isLegal,
  lastMoveOf,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
  targetsAt,
  threatenedPieces,
  type GameEvent,
  type GameResult,
  type GameState,
  type MoveEvent,
  type Preview,
} from "../engine/game";
import {
  defaultRules,
  KIND_ORDER,
  matchPreset,
  other,
  PIECES,
  PLAYER_NAME,
  type PieceKind,
  type Player,
  type RuleSet,
} from "../engine/rules";
import { byId, h } from "./dom";
import { endDetails, handText, hpText, ruleDetails, ruleLines, verb } from "./ruletext";
import { fillSentences, SetupDialog, type PlaySettings } from "./setup";

/** CPU が打つまでの待ち時間（盤面の変化を目で追えるように） */
const CPU_DELAY_MS = 900;
/** 最終手を見せてから終局画面を出すまでの待ち時間 */
const RESULT_DELAY_MS = 900;
const TOAST_MS = 2800;
/** 取った駒が持ち駒へ飛んでいくアニメーションの長さ */
const FLY_MS = 650;

const pieceLabel = (k: PieceKind) => `${PIECES[k].name}${PIECES[k].value}`;
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

  private place(r: number, c: number, kind: PieceKind) {
    if (!this.game) return;
    this.game = playMove(this.game, r, c, kind);
    this.focus = null;
    this.pinned = false;
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
      const ch = chooseLookahead(g);
      if (ch) this.place(ch.r, ch.c, ch.kind);
    }, CPU_DELAY_MS);
  }

  private notifyNewEvents(history: GameEvent[]) {
    const fresh = history.slice(this.seenEvents);
    this.seenEvents = history.length;
    const pass = fresh.find((e) => e.type === "pass");
    if (pass) {
      const why = pass.reason === "noPieces" ? "持ち駒が尽きました" : "置けるマスがありません";
      this.showToast(`${this.name(pass.player)}はパス（${why}）。${this.name(other(pass.player))}が続けて打ちます`);
    }
  }

  // ---- 入力 ----

  private onCellClick(r: number, c: number) {
    const g = this.game;
    if (!g || !this.canAct()) return;
    const kind = this.kindFor(g);
    if (!isLegal(g, r, c, kind)) {
      // 裏返すルールで挟めない空きマスを押したときは理由を出す
      if (g.board[r][c] === null && g.rules.action === "flip") {
        this.showToast(`${cellName(r, c)} に ${pieceLabel(kind)} を置いても返せる駒がありません（● のマスに置けます）`);
      }
      this.clearFocus();
      return;
    }
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    const samePinned = this.pinned && this.focus?.r === r && this.focus?.c === c;
    // マウス・キーボードは 1 回で確定。タッチは 1 回目で予測、同じマスの 2 回目で確定
    if (!touch || samePinned) {
      this.place(r, c, kind);
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
    const kinds = p === g.turn && !g.result ? playableKinds(g) : availableKinds(g.hands[p]);
    if (!kinds.includes(this.selected[p]) && kinds.length > 0) this.selected[p] = kinds[0];
    return this.selected[p];
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

  /** この対局で持ち駒に出てくる駒種（設定で 0 個の駒は出さない。取るルールでは盤上の歩も入りうる） */
  private kindsInGame(g: GameState): PieceKind[] {
    return KIND_ORDER.filter(
      (k) => g.rules.hand[k] > 0 || (g.rules.action === "capture" && k === "fu") || g.hands[0][k] + g.hands[1][k] > 0,
    );
  }

  private renderRuleCard(r: RuleSet) {
    this.el.rulesName.textContent = `ルール — ${ruleName(r)}`;
    fillSentences(this.el.rulesList, ruleLines(r));
  }

  private renderLegend(r: RuleSet) {
    const v = verb(r);
    this.el.legend.replaceChildren(
      h("span", {}, [h("span", { class: "key-dot", attrs: { "aria-hidden": "true" } }), ` 置くと${v.can}マス`]),
      h("span", {}, [h("span", { class: "key-take", attrs: { "aria-hidden": "true" } }), ` この手で${v.can}駒`]),
      h("span", {}, [h("span", { class: "key-threat", attrs: { "aria-hidden": "true" }, text: "!" }), ` 相手に次に${v.passive}自分の駒`]),
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
        if (s) {
          cell.append(this.stone(s.owner, s.kind));
          label += ` ${PLAYER_NAME[s.owner]}の${pieceLabel(s.kind)}`;
        } else if (isFocus && kind) {
          const ghost = this.stone(g.turn, kind);
          ghost.classList.add("ghost");
          cell.append(ghost);
          if (pv && pv.damage > 0) cell.append(h("span", { class: "dmg-badge", text: `${pv.damage}` }));
          if (pv && pv.heal > 0) cell.append(h("span", { class: "heal-badge", text: `+${pv.heal}` }));
        }
        if (threat.has(i)) {
          cell.append(h("span", { class: "threat", text: "!", attrs: { "aria-hidden": "true" } }));
          label += ` ${v.passive}`;
        }
        if (willTake.has(i)) label += ` ${v.can}`;
        if (canTake) label += ` 置くと${v.can}`;
        cell.setAttribute("aria-label", label);
        cell.disabled = !!g.result;
      }
    }
  }

  private stone(owner: Player, kind: PieceKind) {
    return h("span", { class: `stone p${owner} k-${kind}` }, [
      h("span", { class: "stone-name", text: PIECES[kind].name }),
      h("span", { class: "stone-val", text: String(PIECES[kind].value) }),
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
      if (last && last.player !== p && last.damage > 0) delta = h("span", { class: `delta${fresh}`, text: `−${last.damage}` });
      if (last && last.player === p && last.heal > 0) delta = h("span", { class: `delta heal${fresh}`, text: `+${last.heal}` });
      el.className = `player-card glass p${p}`;
      el.classList.toggle("active", !g.result && g.turn === p);
      el.classList.toggle("low", hp <= max * 0.25);
      el.replaceChildren(
        h("div", { class: "player-head" }, [
          h("span", { class: `dot p${p}`, attrs: { "aria-hidden": "true" } }),
          h("span", { class: "player-name", text: this.name(p) }),
          !g.result && g.turn === p ? h("span", { class: "pill", text: "手番" }) : null,
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
                  [h("span", { class: `mini-stone p${p}`, text: PIECES[k].name }), `×${g.hands[p][k]}`],
                ),
              ),
        ),
      );
    }
  }

  private renderStatus(g: GameState) {
    let text: string;
    if (g.result) {
      text = `終局 — ${this.resultHeadline(g.result)}（${this.reasonShort(g)}）`;
    } else if (!this.isHuman(g.turn)) {
      text = `${this.name(g.turn)}が考えています…`;
    } else {
      text = `${this.name(g.turn)}の番 — ${pieceLabel(this.kindFor(g))}を置くマスを選んでください`;
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
          ]),
        );
      }
      const last = lastMoveOf(g);
      if (last) box.append(h("p", { class: "last-move", text: `直前: ${this.moveText(last)}` }));
      return;
    }
    box.classList.add("on");
    const kind = this.kindFor(g);
    box.append(h("h2", { class: "label", text: `予測 — ${cellName(f.r, f.c)} に ${pieceLabel(kind)} を置くと` }));
    if (pv.targets.length === 0) {
      box.append(h("p", { class: "preview-main none", text: `${v.can}駒なし` }));
    } else {
      const names = pv.targets.map(([y, x]) => pieceLabel(g.board[y][x]!.kind)).join("・");
      box.append(
        h("p", { class: "preview-main" }, [
          `${names} を${g.rules.action === "flip" ? "返す" : "取る"} → `,
          h("strong", { class: "dmg", text: `${pv.damage} ダメージ` }),
          pv.heal > 0 ? "・" : null,
          pv.heal > 0 ? h("strong", { class: "heal", text: `自分が ${pv.heal} 回復` }) : null,
        ]),
      );
    }
    // 置いた駒そのものが返されうるときは強く、他の駒なら控えめに警告する
    const placedExposed = pv.exposed.some(([y, x]) => y === f.r && x === f.c);
    if (placedExposed) {
      box.append(h("p", { class: "warn", text: `！ ここに置いた ${pieceLabel(kind)} は次の相手の手で${v.passive}` }));
    } else if (pv.exposedDamage > 0) {
      box.append(h("p", { class: "warn soft", text: `！ 置いた後、相手は次の手で最大 ${pv.exposedDamage} ダメージ与えられる（! の駒）` }));
    }
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    const hint = touch ? `同じマスをもう一度タップすると ${pieceLabel(kind)} を置きます` : `クリックで ${pieceLabel(kind)} を置きます`;
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
      // 持っているが強さ制限で置ける所がない駒は、押せない理由を添える
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
            "aria-label": `${PIECES[k].name}（数字 ${PIECES[k].value}）残り ${n} 個${blocked ? "（置けるマスなし）" : ""}`,
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

  private moveText(e: GameEvent): string {
    if (e.type === "pass") return `${PLAYER_NAME[e.player]} パス（${e.reason === "noPieces" ? "持ち駒切れ" : "置ける所なし"}）`;
    const head = `${PLAYER_NAME[e.player]} ${pieceLabel(e.kind)}→${cellName(e.r, e.c)}`;
    if (e.targets.length === 0) return head;
    const v = verb(this.game!.rules);
    const heal = e.heal > 0 ? ` +${e.heal}回復` : "";
    return `${head} ${e.targets.map((x) => pieceLabel(x.kind)).join("・")}を${v.past} ${e.damage}ダメージ${heal}`;
  }

  private renderLog(g: GameState) {
    const items = [...g.history].reverse().map((e) =>
      h("li", { class: `log-item ${e.type} p${e.player}${e.type === "move" && e.damage > 0 ? " hit" : ""}` }, [
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
    return { ko: "体力 0", limit: `${g.rules.maxPlies} 手で判定`, stalled: "打てる手なしで判定" }[g.result!.reason];
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
    }[r.reason];
    byId("result-winner").textContent = this.resultHeadline(r);
    byId("result-reason").textContent = reason;
    byId("result-detail").textContent =
      `${this.name(0)} 体力 ${g.hp[0]} ／ ${this.name(1)} 体力 ${g.hp[1]} ／ 石数 ${d0} 対 ${d1}（${g.ply} 手・ルール ${ruleName(g.rules)}）`;
    this.hideToast();
    if (!this.el.result.open) this.el.result.showModal();
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

function inView(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
}
