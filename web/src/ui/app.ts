// 画面の制御。ゲームの計算はすべて engine/ に任せ、ここは表示と入力だけを扱う。

import { cellName, countStones, SIZE } from "../engine/board";
import { chooseLookahead } from "../engine/cpu";
import {
  availableKinds,
  createGame,
  movesFor,
  playMove,
  previewMove,
  type GameEvent,
  type GameResult,
  type GameState,
} from "../engine/game";
import { KIND_ORDER, PIECES, PLAYER_NAME, type Hand, type PieceKind, type Player } from "../engine/rules";
import { byId, h } from "./dom";

type Mode = "cpu" | "pvp";

interface Settings {
  mode: Mode;
  /** CPU 対戦で人間が持つ手番 */
  human: Player;
  kaku: boolean;
}

/** CPU が打つまでの待ち時間（盤面の変化を目で追えるように） */
const CPU_DELAY_MS = 700;
/** 最終手を見せてから終局画面を出すまでの待ち時間 */
const RESULT_DELAY_MS = 600;
const TOAST_MS = 2800;

const other = (p: Player): Player => (p === 0 ? 1 : 0);
const pieceLabel = (k: PieceKind) => `${PIECES[k].name}${PIECES[k].value}`;
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

export class App {
  private settings: Settings = { mode: "cpu", human: 0, kaku: false };
  private game: GameState | null = null;
  /** プレイヤーごとに選んでいる持ち駒 */
  private selected: [PieceKind | null, PieceKind | null] = [null, null];
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
  /** 返した駒のアニメーションを再生する手数（新しい手の直後の描画だけ） */
  private animatePly = -1;

  private readonly cells: HTMLButtonElement[][] = [];
  private readonly el = {
    game: byId("game"),
    board: byId("board"),
    status: byId("status"),
    players: [byId("player-0"), byId("player-1")] as const,
    preview: byId("preview"),
    hand: byId("hand"),
    handTitle: byId("hand-title"),
    handButtons: byId("hand-buttons"),
    log: byId("log"),
    toast: byId("toast"),
    setup: byId<HTMLDialogElement>("setup"),
    setupForm: byId<HTMLFormElement>("setup-form"),
    sideField: byId("side-field"),
    result: byId<HTMLDialogElement>("result"),
    rules: byId<HTMLDialogElement>("rules"),
  };

  constructor() {
    this.buildBoard();
    this.bindControls();
    this.openSetup();
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
    board.addEventListener("keydown", () => (this.lastPointer = "keyboard"));
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
    const { setup, setupForm, result, rules } = this.el;
    byId("btn-rules").addEventListener("click", () => rules.showModal());
    byId("btn-new").addEventListener("click", () => this.openSetup());
    byId("setup-rules").addEventListener("click", () => rules.showModal());
    byId("rules-close").addEventListener("click", () => rules.close());
    // 対局が始まる前は設定画面を閉じさせない
    setup.addEventListener("cancel", (e) => {
      if (!this.game) e.preventDefault();
    });
    setupForm.addEventListener("change", () => this.syncSetupForm());
    setupForm.addEventListener("submit", () => {
      const f = new FormData(setupForm);
      this.start({
        mode: f.get("mode") === "pvp" ? "pvp" : "cpu",
        human: f.get("side") === "1" ? 1 : 0,
        kaku: f.get("kaku") === "on",
      });
    });
    byId("result-view").addEventListener("click", () => result.close());
    byId("result-setup").addEventListener("click", () => {
      result.close();
      this.openSetup();
    });
    byId("result-rematch").addEventListener("click", () => {
      result.close();
      this.start(this.settings);
    });
  }

  private openSetup() {
    this.syncSetupForm();
    this.el.setup.showModal();
  }

  private syncSetupForm() {
    const mode = new FormData(this.el.setupForm).get("mode");
    this.el.sideField.hidden = mode === "pvp";
  }

  // ---- 対局の進行 ----

  private start(settings: Settings) {
    window.clearTimeout(this.cpuTimer);
    window.clearTimeout(this.resultTimer);
    this.hideToast();
    this.settings = settings;
    this.game = createGame({ kaku: settings.kaku });
    this.selected = [null, null];
    this.focus = null;
    this.pinned = false;
    this.seenEvents = 0;
    this.el.game.hidden = false;
    this.render();
    this.scheduleCpu();
  }

  private isHuman(p: Player) {
    return this.settings.mode === "pvp" || p === this.settings.human;
  }

  private canAct(): boolean {
    return !!this.game && !this.game.result && this.isHuman(this.game.turn);
  }

  private place(r: number, c: number, kind: PieceKind) {
    if (!this.game) return;
    this.game = playMove(this.game, r, c, kind);
    this.focus = null;
    this.pinned = false;
    for (const p of [0, 1] as const) {
      const k = this.selected[p];
      if (k && this.game.hands[p][k] <= 0) this.selected[p] = null;
    }
    this.afterChange();
  }

  private afterChange() {
    const g = this.game!;
    this.notifyNewEvents(g.history);
    this.animatePly = g.ply;
    this.render();
    this.animatePly = -1;
    if (g.result) {
      this.resultTimer = window.setTimeout(() => this.showResult(g.result!), RESULT_DELAY_MS);
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
    if (pass && pass.type === "pass") {
      const why = pass.reason === "no-piece" ? "持ち駒が尽きました" : "置ける場所がありません";
      this.showToast(`${this.name(pass.player)}はパス（${why}）。${this.name(other(pass.player))}が続けて打ちます`);
    }
  }

  // ---- 入力 ----

  private onCellClick(r: number, c: number) {
    const g = this.game;
    if (!g || !this.canAct()) return;
    if (!movesFor(g, g.turn).some((m) => m.r === r && m.c === c)) {
      this.clearFocus();
      return;
    }
    const kind = this.selected[g.turn];
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    const samePinned = this.pinned && this.focus?.r === r && this.focus?.c === c;
    // マウス・キーボードは 1 回で確定。タッチは 1 回目で予測、同じマスの 2 回目で確定
    if (kind && (!touch || samePinned)) {
      this.place(r, c, kind);
      return;
    }
    this.setFocus(r, c, true);
  }

  private setFocus(r: number, c: number, pin: boolean) {
    const g = this.game;
    if (!g || !this.canAct()) return;
    const legal = movesFor(g, g.turn).some((m) => m.r === r && m.c === c);
    if (!legal) {
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

  /** toggle: 選択中の駒をもう一度押したら解除する（持ち駒パネル用） */
  private selectKind(kind: PieceKind, toggle: boolean) {
    const g = this.game;
    if (!g || !this.canAct() || g.hands[g.turn][kind] <= 0) return;
    this.selected[g.turn] = toggle && this.selected[g.turn] === kind ? null : kind;
    this.render();
  }

  // ---- 表示 ----

  private name(p: Player) {
    if (this.settings.mode === "pvp") return PLAYER_NAME[p];
    return `${PLAYER_NAME[p]}（${p === this.settings.human ? "あなた" : "CPU"}）`;
  }

  private render() {
    const g = this.game;
    if (!g) return;
    this.renderBoard(g);
    this.renderPlayers(g);
    this.renderStatus(g);
    this.renderPreview(g);
    this.renderHand(g);
    this.renderLog(g);
  }

  private renderBoard(g: GameState) {
    const act = this.canAct();
    const kind = this.selected[g.turn];
    const legal = new Set(act ? movesFor(g, g.turn).map((m) => m.r * SIZE + m.c) : []);
    // 返る駒は駒種によらないので、未選択でも先頭の駒種で求める
    const f = act ? this.focus : null;
    const eff = f ? previewMove(g, f.r, f.c, kind ?? availableKinds(g.hands[g.turn])[0]) : null;
    const willFlip = new Set((eff?.flipped ?? []).map(([y, x]) => y * SIZE + x));
    const last = [...g.history].reverse().find((e) => e.type === "move");
    const animate = last?.type === "move" && last.ply === this.animatePly;
    const lastFlipped = new Set(animate ? last.flipped.map(([y, x]) => y * SIZE + x) : []);
    this.el.board.classList.toggle("selecting", !!kind && act);
    this.el.board.classList.toggle("over", !!g.result);

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const i = r * SIZE + c;
        const s = g.board[r][c];
        const cell = this.cells[r][c];
        const isFocus = f?.r === r && f?.c === c;
        cell.className = "cell";
        cell.classList.toggle("legal", legal.has(i));
        cell.classList.toggle("focus", isFocus);
        cell.classList.toggle("will-flip", willFlip.has(i));
        cell.classList.toggle("last", last?.type === "move" && last.r === r && last.c === c);
        cell.classList.toggle("flipped", lastFlipped.has(i));
        cell.replaceChildren();
        let label = cellName(r, c);
        if (s) {
          cell.append(this.stone(s.owner, s.kind, s.value));
          label += ` ${PLAYER_NAME[s.owner]}の${PIECES[s.kind].name}${s.value}`;
        } else if (isFocus && kind) {
          const ghost = this.stone(g.turn, kind, PIECES[kind].value);
          ghost.classList.add("ghost");
          cell.append(ghost);
        }
        if (legal.has(i)) label += " 置ける";
        cell.setAttribute("aria-label", label);
        cell.disabled = !!g.result;
      }
    }
  }

  private stone(owner: Player, kind: PieceKind, value: number) {
    return h("span", { class: `stone p${owner} k-${kind}` }, [
      h("span", { class: "stone-name", text: PIECES[kind].name }),
      h("span", { class: "stone-val", text: String(value) }),
    ]);
  }

  private renderPlayers(g: GameState) {
    const stones = countStones(g.board);
    const last = [...g.history].reverse().find((e) => e.type === "move");
    for (const p of [0, 1] as const) {
      const el = this.el.players[p];
      const init = g.rules.hp[p];
      const hp = g.hp[p];
      const pct = Math.max(0, Math.min(100, (hp / init) * 100));
      let delta: HTMLElement | null = null;
      if (last?.type === "move") {
        const d = last.player === p ? last.heal : -last.attack;
        if (d !== 0) delta = h("span", { class: `delta ${d > 0 ? "up" : "down"}`, text: signed(d) });
      }
      el.className = `player-card glass p${p}`;
      el.classList.toggle("active", !g.result && g.turn === p);
      el.classList.toggle("low", hp <= init * 0.25);
      el.replaceChildren(
        h("div", { class: "player-head" }, [
          h("span", { class: `dot p${p}`, attrs: { "aria-hidden": "true" } }),
          h("span", { class: "player-name", text: this.name(p) }),
          !g.result && g.turn === p ? h("span", { class: "pill", text: "手番" }) : null,
        ]),
        h("div", { class: "hp-row" }, [
          h("span", { class: "hp-num", text: String(hp) }),
          h("span", { class: "hp-max", text: `/ ${init}` }),
          delta,
          h("span", { class: "discs", text: `石 ${stones[p]}` }),
        ]),
        h(
          "div",
          {
            class: "hp-bar",
            attrs: {
              role: "meter",
              "aria-label": `${PLAYER_NAME[p]}の体力`,
              "aria-valuemin": "0",
              "aria-valuemax": String(init),
              "aria-valuenow": String(Math.max(0, hp)),
            },
          },
          [h("span", { class: "hp-fill", attrs: { style: `width:${pct}%` } })],
        ),
        h("div", { class: "hand-mini", attrs: { "aria-label": `${PLAYER_NAME[p]}の持ち駒` } }, this.handMini(g.hands[p], g)),
      );
    }
  }

  private handMini(hand: Hand, g: GameState) {
    return KIND_ORDER.filter((k) => g.rules.hand[k] > 0).map((k) =>
      h("span", { class: `mini${hand[k] === 0 ? " empty" : ""}`, text: `${PIECES[k].name}${hand[k]}` }),
    );
  }

  private renderStatus(g: GameState) {
    let text: string;
    if (g.result) {
      text = `終局 — ${this.resultHeadline(g.result)}（${this.reasonShort(g.result)}）`;
    } else if (!this.isHuman(g.turn)) {
      text = `${this.name(g.turn)}が考えています…`;
    } else if (!this.selected[g.turn]) {
      text = `${this.name(g.turn)}の番 — 持ち駒を選んでください`;
    } else {
      text = `${this.name(g.turn)}の番 — ${pieceLabel(this.selected[g.turn]!)}を置くマスを選んでください`;
    }
    this.el.status.textContent = text;
    this.el.status.classList.toggle("over", !!g.result);
  }

  private renderPreview(g: GameState) {
    const box = this.el.preview;
    box.replaceChildren();
    const f = this.focus;
    if (!f || !this.canAct()) {
      box.classList.remove("on");
      const last = [...g.history].reverse().find((e) => e.type === "move");
      box.append(h("h2", { class: "label", text: "予測" }));
      if (g.result) {
        box.append(h("p", { class: "muted", text: "対局は終了しました。" }));
      } else if (!this.isHuman(g.turn)) {
        box.append(h("p", { class: "muted", text: "CPU の手番です。" }));
      } else {
        box.append(
          h("p", {
            class: "muted",
            text: "置けるマスにカーソルを乗せると（スマホは 1 回タップ）、その手の攻撃・回復と返る駒を表示します。",
          }),
        );
      }
      if (last?.type === "move") box.append(h("p", { class: "last-move", text: `直前: ${this.moveText(last)}` }));
      return;
    }
    box.classList.add("on");
    const kinds = availableKinds(g.hands[g.turn]);
    const sel = this.selected[g.turn];
    const base = previewMove(g, f.r, f.c, kinds[0])!;
    box.append(
      h("h2", { class: "label", text: `予測 — ${cellName(f.r, f.c)} に置くと` }),
      h("p", { class: "preview-head" }, [
        `${base.flipped.length} 枚返す（最大 `,
        h("strong", { text: String(base.maxFlipped) }),
        `）: `,
        base.flipped
          .map(([y, x]) => `${cellName(y, x)} ${PIECES[g.board[y][x]!.kind].name}${g.board[y][x]!.value}`)
          .join("、"),
      ]),
    );
    const rows = h("div", { class: "preview-rows", attrs: { role: "group", "aria-label": "駒ごとの予測" } });
    for (const k of kinds) {
      const e = previewMove(g, f.r, f.c, k)!;
      const row = h(
        "button",
        {
          class: `preview-row${k === sel ? " selected" : ""}`,
          attrs: {
            type: "button",
            "data-kind": k,
            "aria-pressed": String(k === sel),
            title: `攻撃 = ${e.maxFlipped}${PIECES[k].mult > 1 ? ` × ${PIECES[k].mult}` : ""} ＋ ${e.flipped.length}÷4`,
          },
        },
        [
          h("span", { class: "pr-kind", text: pieceLabel(k) }),
          h("span", { class: "pr-atk" }, ["攻撃 ", h("strong", { text: String(e.attack) })]),
          h("span", { class: "pr-heal" }, ["回復 ", h("strong", { text: String(e.heal) })]),
        ],
      );
      row.addEventListener("click", () => this.selectKind(k, false));
      rows.append(row);
    }
    box.append(rows);
    const touch = this.lastPointer === "touch" || this.lastPointer === "pen";
    let hint: string;
    if (!sel) hint = "行か下の持ち駒をタップして駒を選んでください";
    else if (touch) hint = `同じマスをもう一度タップすると ${pieceLabel(sel)} を置きます`;
    else hint = `クリックで ${pieceLabel(sel)} を置きます`;
    box.append(h("p", { class: "hint", text: hint }));
  }

  private renderHand(g: GameState) {
    const box = this.el.handButtons;
    box.replaceChildren();
    if (g.result) {
      this.el.handTitle.textContent = "対局終了";
      const again = h("button", { class: "btn primary", text: "再戦", attrs: { type: "button", id: "btn-rematch" } });
      again.addEventListener("click", () => this.start(this.settings));
      const show = h("button", { class: "btn ghost", text: "結果を見る", attrs: { type: "button" } });
      show.addEventListener("click", () => this.showResult(g.result!));
      box.append(show, again);
      return;
    }
    // 人間の手番ならその人の持ち駒、CPU の手番なら人間の持ち駒を操作不可で出す
    const p = this.isHuman(g.turn) ? g.turn : this.settings.human;
    const act = this.canAct();
    this.el.handTitle.textContent = `${this.name(p)}の持ち駒`;
    for (const k of KIND_ORDER) {
      if (g.rules.hand[k] === 0) continue;
      const n = g.hands[p][k];
      const b = h(
        "button",
        {
          class: `piece-btn k-${k}${this.selected[p] === k ? " selected" : ""}`,
          attrs: {
            type: "button",
            "data-kind": k,
            "aria-pressed": String(this.selected[p] === k),
            "aria-label": `${PIECES[k].name}（数値 ${PIECES[k].value}）残り ${n} 個`,
          },
        },
        [
          h("span", { class: `stone p${p} k-${k}` }, [
            h("span", { class: "stone-name", text: PIECES[k].name }),
            h("span", { class: "stone-val", text: String(PIECES[k].value) }),
          ]),
          h("span", { class: "piece-count", text: `×${n}` }),
        ],
      );
      b.disabled = !act || n === 0;
      b.addEventListener("click", () => this.selectKind(k, true));
      box.append(b);
    }
  }

  private moveText(e: GameEvent): string {
    if (e.type === "pass") {
      return `${this.name(e.player)} パス（${e.reason === "no-piece" ? "持ち駒切れ" : "置ける場所なし"}）`;
    }
    return `${this.name(e.player)} ${pieceLabel(e.kind)}→${cellName(e.r, e.c)} ${e.flipped.length}枚返し 攻撃${e.attack} 回復${e.heal}`;
  }

  private renderLog(g: GameState) {
    const items = [...g.history].reverse().map((e) =>
      h("li", { class: `log-item ${e.type} p${e.player}` }, [
        h("span", { class: "log-ply", text: e.type === "move" ? String(e.ply) : "—" }),
        h("span", { text: this.moveText(e) }),
      ]),
    );
    this.el.log.replaceChildren(...items);
  }

  // ---- 終局・通知 ----

  private resultHeadline(r: GameResult): string {
    if (r.winner === null) return "引き分け";
    if (this.settings.mode === "cpu") return r.winner === this.settings.human ? "あなたの勝ち" : "CPU の勝ち";
    return `${PLAYER_NAME[r.winner]}の勝ち`;
  }

  private reasonShort(r: GameResult): string {
    return { ko: "体力 0", hp: "体力判定", discs: "石数", draw: "体力・石数とも同じ" }[r.reason];
  }

  private showResult(r: GameResult) {
    const g = this.game!;
    const stones = countStones(g.board);
    const loser = r.winner === null ? null : other(r.winner);
    const reason = {
      ko: `体力 0 — ${loser !== null ? this.name(loser) : ""}の体力が 0 以下になりました`,
      hp: `体力判定 — 盤が終わった時点の体力 ${g.hp[0]} 対 ${g.hp[1]}`,
      discs: `石数 — 体力が同じ（${g.hp[0]}）なので石の数 ${stones[0]} 対 ${stones[1]}`,
      draw: `引き分け — 体力（${g.hp[0]}）も石の数（${stones[0]}）も同じ`,
    }[r.reason];
    byId("result-winner").textContent = this.resultHeadline(r);
    byId("result-reason").textContent = reason;
    byId("result-detail").textContent =
      `${this.name(0)} 体力 ${g.hp[0]}・石 ${stones[0]} ／ ${this.name(1)} 体力 ${g.hp[1]}・石 ${stones[1]}（${g.ply} 手）`;
    if (!this.el.result.open) this.el.result.showModal();
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

