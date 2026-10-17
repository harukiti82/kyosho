// スキルを持つ CPU。配られたカードの配り直しと選び方（wantsReroll / chooseSkillPick）、使うか・どう使うか（chooseSkillUse）と、
// スキル込みの 2 手読み（skillLookahead）、副将を出す手の決め方（viceWith）。
// リポジトリ外のシミュレーター（kyosho-skillsim の sim.ts の plan / lookahead）の規則を写したもの。
// スキルなしの対局では使わない（cpu.ts の手は変わらない）。乱数は引数で受ける。

import { applyLines, damageOf, emptyCells, healOf, pieceLines, rawLines, SIZE, targetsOf, type Cell, type Line } from "./board";
import {
  armedEffect,
  attackable,
  availableKinds,
  bestReply,
  kingMoveCells,
  moveRules,
  refillKinds,
  skillBlock,
  type MoveEvent,
  type PlayerView,
} from "./game";
import { other, type PieceKind, type Player, type RuleSet } from "./rules";
import {
  FLIP_POINTS,
  gaugeMax,
  GAUGE_UNIT,
  isZone,
  secondDamage,
  shieldDamage,
  SKILL_HEAL,
  skillLength,
  SKILLS,
  strongDamage,
  vicePenalty,
  type SkillId,
  type SkillUse,
} from "./skills";
import type { Choice } from "./cpu";

/** ゲージ 1 点の価値の元（点。回復は効果の量 ÷ 長さ） */
const GAUGE_VALUE: Record<SkillId, number> = {
  firstaid: 10,
  bigheal: 30,
  strong: 6,
  omni: 6,
  refill: 6,
  wall: 8,
  scout: 5,
  kingmove: 6,
  fool: 8,
  wheel: 8,
  judge: 8,
};
/** 使う条件（使ったときの読みの得点が、使わないときよりこれ以上よい） */
const THRESHOLD = { omni: 2, strong: 6, wall: 6, kingmove: 1, fool: 6 } as const;
/** 巻き戻しは、自分の前の手の後に相手の応手で受けた体力の減りがこれ以上のときに使う（sim.ts の JTH） */
export const JUDGE_TAKEN = 15;
/** 回復は、足りない体力が効果の量のこの割合以上のときに使う */
const HEAL_NEED = 0.6;
/** 補充は、戻す駒の数字のこの倍を得点に足して比べる */
const REFILL_BONUS = 1.5;

/**
 * CPU が弱いとみなすカード（11 枚混在の 2 手読み同士 `npm run balance -- skillmix 2000` で、持った側の勝率が 48.5% 未満のもの）。
 * 配られた 3 枚がどれもこれなら配り直す
 */
export const WEAK_CARDS: ReadonlySet<SkillId> = new Set<SkillId>(["judge", "bigheal", "scout", "wall", "firstaid"]);

/** CPU が配られた 3 枚を配り直すか（どれも WEAK_CARDS のときだけ。乱数は使わない） */
export const wantsReroll = (offer: readonly SkillId[]): boolean => offer.length > 0 && offer.every((id) => WEAK_CARDS.has(id));

/** CPU が配られたカードから選ぶ 1 枚（一様に。乱数は引数で 1 回使う） */
export const chooseSkillPick = (offer: readonly SkillId[], rng: () => number): SkillId => offer[Math.min(offer.length - 1, Math.floor(rng() * offer.length))];

/** ゲージ 1 点の価値（点） */
const gaugeWeight = (id: SkillId, rules: RuleSet) => (id === "firstaid" || id === "bigheal" ? SKILL_HEAL[id] : GAUGE_VALUE[id]) / skillLength(id, rules);

interface Opt {
  designate?: boolean;
  /** 置く駒が 8 方向に挟める（全方向） */
  dirsAll?: boolean;
  /** 自分の手のダメージ ×1.5（強打） */
  strong?: boolean;
  /** 相手の次の手のダメージが半分（自分の鉄壁） */
  shield?: boolean;
  /** 自分の手のダメージが半分（相手の鉄壁） */
  ownHalf?: boolean;
  /** 自分の王のマス（王の移し替えの読み） */
  kingCell?: Cell | null;
  /** 持ち駒に 1 つ足して読む（補充） */
  handPlus?: PieceKind;
  /** 自分の手のダメージが半分（連続行動の 2 手目） */
  secondHalf?: boolean;
  /** 自分の手の後に続けてもう 1 手（連続行動。2 手目はダメージ半分で貪欲に選んだものとして読む） */
  extra?: boolean;
  /** この手は選ばない（巻き戻しで戻した手。ほかに手がなければ選ぶ） */
  exclude?: { r: number; c: number; kind: PieceKind } | null;
  /** ゲージ 1 点の価値と、満タンまでの残り（点） */
  gaugeW?: number;
  room?: number;
}

const key = (r: number, c: number) => r * SIZE + c;

function penaltyOf(view: PlayerView, victim: Player): number {
  const { king } = view.rules;
  return king.penalty === "lose" ? Math.max(1, view.hp[victim]) : king.amount;
}

/**
 * 相手の副将を返したときの罰の見込み（sim.ts の viceKnown）: 偵察で特定していればそのマスに罰、
 * 決まっていると分かっていれば相手の駒（偵察で分かった王を除く）1 つごとに罰 ÷ 駒の数。決まっていなければなし
 */
function oppViceHint(view: PlayerView): { cells: Set<number>; pen: number } {
  const ov = view.oppVice;
  if (!ov.set) return { cells: new Set(), pen: 0 };
  if (ov.scouted && ov.cell) return { cells: new Set([key(ov.cell[0], ov.cell[1])]), pen: vicePenalty(view.rules) };
  const q = other(view.turn);
  const ok = view.oppKing;
  const kc = ok.scouted && !ok.revealed ? key(ok.candidates[0][0], ok.candidates[0][1]) : -1;
  const cells = new Set<number>();
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (view.board[r][c]?.owner === q && key(r, c) !== kc) cells.add(key(r, c));
  return { cells, pen: cells.size > 0 ? vicePenalty(view.rules) / cells.size : 0 };
}

/** bestReply の score に、返されるマス（自分の王・副将）ごとの罰を足したもの（sim.ts の bestReply2） */
function bestReplyPens(view: PlayerView, board: PlayerView["board"], q: Player, pens: { cell: Cell; penalty: number }[]): { damage: number; score: number } {
  const { rules } = view;
  let damage = 0;
  let score = 0;
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, q, rules.values);
    if (raw.length === 0) continue;
    for (const k of availableKinds(view.hands[q])) {
      const lines = pieceLines(raw, k, rules);
      if (lines.length === 0) continue;
      const d = damageOf(board, lines, rules);
      damage = Math.max(damage, d);
      const ts = targetsOf(lines);
      let pen = 0;
      for (const e of pens) if (ts.some(([y, x]) => y === e.cell[0] && x === e.cell[1])) pen += e.penalty;
      score = Math.max(score, d + healOf(lines, rules.values[k], rules) + pen);
    }
  }
  return { damage, score };
}

/** cpu.ts の lookaheadCandidates に、スキルの what-if とゲージの価値を足したもの */
function lookahead(view: PlayerView, o: Opt = {}): { best: number; cands: Choice[] } {
  const { rules, board } = view;
  const p = view.turn;
  const q = other(p);
  const card = view.skills?.sides[p].card ?? null;
  const hand = { ...view.hands[p] };
  if (o.handPlus) hand[o.handPlus]++;
  const myKinds = availableKinds(hand);
  const oppHand = view.hands[q];
  const oc = new Set(view.oppKing.candidates.map(([y, x]) => key(y, x)));
  const oppPenalty = oc.size > 0 ? penaltyOf(view, q) / oc.size : 0;
  const myPenalty = rules.king.on ? penaltyOf(view, p) : 0;
  const allRules = { ...rules, dirs: "all" as const };
  // 副将: 相手の副将を返す見込みと、自分の副将を返される危険（相手が場所を知っているとみなす）
  const vk = oppViceHint(view);
  const mv = view.myVice;
  const myVicePen = mv.cell ? { cell: mv.cell, penalty: vicePenalty(rules) } : null;
  const viceHits = (ls: Line[]) => ls.reduce((n, l) => n + l.cells.filter(([y, x]) => vk.cells.has(key(y, x))).length, 0);
  let best = -Infinity;
  let cands: Choice[] = [];
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p, rules.values);
    const myKing: Cell | null = o.designate ? [r, c] : o.kingCell !== undefined ? o.kingCell : view.myKing.cell;
    for (const kind of myKinds) {
      if (o.exclude && o.exclude.r === r && o.exclude.c === c && o.exclude.kind === kind) continue;
      const lines = pieceLines(raw, kind, o.dirsAll ? allRules : rules);
      if (rules.action === "flip" && lines.length === 0) continue;
      let d = damageOf(board, lines, rules);
      if (o.strong) d = strongDamage(d);
      if (o.ownHalf) d = shieldDamage(d);
      if (o.secondHalf) d = secondDamage(d);
      let own = d + healOf(lines, rules.values[kind], rules);
      const hits = (ls: typeof lines) => ls.reduce((n, l) => n + l.cells.filter(([y, x]) => oc.has(key(y, x))).length, 0);
      if (oppPenalty > 0) own += oppPenalty * hits(lines);
      if (vk.pen > 0) own += vk.pen * viceHits(lines);
      if (card && o.gaugeW && o.room && o.room > 0) {
        const ts = targetsOf(lines);
        const zoneHits = (isZone(r, c) ? 1 : 0) + ts.filter(([y, x]) => isZone(y, x)).length;
        const g = FLIP_POINTS[Math.min(ts.length, FLIP_POINTS.length - 1)] + SKILLS[card].zone * zoneHits;
        own += o.gaugeW * Math.min(o.room, g);
      }
      let next = applyLines(board, p, r, c, kind, lines, rules);
      if (o.extra) {
        // 連続行動: 2 手目を貪欲に（ダメージ半分＋回復＋王の罰の見込み）選んだ盤から相手の応手を読む
        const h2 = { ...hand };
        h2[kind]--;
        if (rules.action === "capture") for (const [y, x] of targetsOf(lines)) h2[board[y][x]!.kind]++;
        let b2 = -Infinity;
        let after = next;
        for (const [r2, c2] of emptyCells(next)) {
          const raw2 = rawLines(next, r2, c2, p, rules.values);
          if (raw2.length === 0) continue;
          for (const k2 of availableKinds(h2)) {
            const l2 = pieceLines(raw2, k2, rules);
            if (l2.length === 0) continue;
            const s2 =
              secondDamage(damageOf(next, l2, rules)) +
              healOf(l2, rules.values[k2], rules) +
              (oppPenalty > 0 ? oppPenalty * hits(l2) : 0) +
              (vk.pen > 0 ? vk.pen * viceHits(l2) : 0);
            if (s2 > b2) {
              b2 = s2;
              after = applyLines(next, p, r2, c2, k2, l2, rules);
            }
          }
        }
        if (b2 > -Infinity) {
          own += b2;
          next = after;
        }
      }
      const br = myVicePen
        ? bestReplyPens(view, next, q, [...(myKing ? [{ cell: myKing, penalty: myPenalty }] : []), myVicePen])
        : bestReply(rules, next, oppHand, q, myKing ? { cell: myKing, penalty: myPenalty } : undefined);
      const reply = o.shield ? br.score - (br.damage - shieldDamage(br.damage)) : br.score;
      const s = own - reply;
      if (s > best) {
        best = s;
        cands = [{ r, c, kind }];
      } else if (s === best) {
        cands.push({ r, c, kind });
      }
    }
  }
  return { best, cands };
}

/** いまの局面（使ったスキル・相手の鉄壁・ゲージ）から読みの条件を決める */
function currentOpt(view: PlayerView): Opt {
  const sk = view.skills!;
  const p = view.turn;
  const card = sk.sides[p].card!;
  const o: Opt = { gaugeW: gaugeWeight(card, view.rules), room: (gaugeMax(card, view.rules) - sk.sides[p].gauge) / GAUGE_UNIT };
  if (sk.shielded[p]) o.ownHalf = true;
  if (sk.second) o.secondHalf = true;
  switch (armedEffect(sk)) {
    case "strong":
      o.strong = true;
      break;
    case "omni":
      o.dirsAll = true;
      break;
    case "wall":
      o.shield = true;
      break;
    case "fool":
      o.extra = true;
      break;
    case "judge":
      // 戻した手をそのまま打ち直さない
      o.exclude = sk.armed?.redo ?? null;
      break;
  }
  return o;
}

/**
 * スキル込みの 2 手読みで 1 手選ぶ（ノーマルの CPU がカードを持つとき）。隠し王の指定の決め方は cpu.ts の chooseWith と同じ
 */
export function chooseSkillLookahead(view: PlayerView, rng: () => number): Choice | null {
  if (view.result) return null;
  const o = currentOpt(view);
  const pick = (cs: Choice[]) => cs[Math.floor(rng() * cs.length)];
  let normal = lookahead(view, o);
  if (normal.cands.length === 0 && o.exclude) {
    o.exclude = null;
    normal = lookahead(view, o);
  }
  if (normal.cands.length === 0) return null;
  const mk = view.myKing;
  if (mk.canDesignate) {
    const remaining = view.rules.king.deadline - mk.nextMove + 1;
    if (mk.forcedNow || rng() < 1 / remaining) {
      const wk = lookahead(view, { ...o, designate: true });
      if (mk.forcedNow || wk.best >= normal.best) return { ...pick(wk.cands), king: true };
    }
  }
  return pick(normal.cands);
}

/** 使ったスキルの後の view を、カードを読まない CPU（イージー・ハード）に渡す形にする（全方向なら 8 方向のルール） */
export const plainView = (view: PlayerView): PlayerView => ({ ...view, rules: moveRules(view) });

/** 補充で戻す駒: 戻せる駒のうち、2 手読みの得点 ＋ 数字 × REFILL_BONUS が最もよいもの（同点なら数字の大きい駒） */
function bestRefill(view: PlayerView, withRoom: (o: Opt) => Opt): { kind: PieceKind; gain: number } | null {
  let best: { kind: PieceKind; gain: number } | null = null;
  for (const kind of refillKinds(view)) {
    const v = view.rules.values[kind];
    const gain = lookahead(view, withRoom({ handPlus: kind })).best + REFILL_BONUS * v;
    if (!best || gain > best.gain || (gain === best.gain && v > view.rules.values[best.kind])) best = { kind, gain };
  }
  return best;
}

/** 王の移し替えの先: 次の手で返されない駒（盤の端・隅を優先）。どれも返されうるなら移せる駒のどれか。移せなければ null */
function kingMoveTarget(view: PlayerView, rng: () => number): { to: Cell; threatened: boolean; safe: boolean } | null {
  const q = other(view.turn);
  const kc = view.myKing.cell;
  const cells = kingMoveCells(view);
  if (!kc || cells.length === 0) return null;
  const threatened = new Set(attackable(view.rules, view.board, view.hands[q], q).map(([y, x]) => key(y, x)));
  const safe = cells.filter(([y, x]) => !threatened.has(key(y, x)));
  const pool = safe.length > 0 ? safe : cells;
  const edge = ([y, x]: Cell) => (y === 0 || y === SIZE - 1 ? 1 : 0) + (x === 0 || x === SIZE - 1 ? 1 : 0);
  const most = Math.max(...pool.map(edge));
  const top = pool.filter((c) => edge(c) === most);
  return { to: top[Math.floor(rng() * top.length)], threatened: threatened.has(key(kc[0], kc[1])), safe: safe.length > 0 };
}

/** 自分の前の手より後に、相手の手で減った自分の体力（ダメージと王の罰の合計） */
function takenSinceMyMove(view: PlayerView): number {
  const p = view.turn;
  let taken = 0;
  for (let i = view.history.length - 1; i >= 0; i--) {
    const e = view.history[i];
    if (e.type !== "move") continue;
    if (e.player === p) break;
    taken += (e as MoveEvent).damage + (e.king?.penalty ?? 0);
  }
  return taken;
}

/**
 * 手番の CPU がこの手番の頭でスキルを使うなら、その指定。使わない・使えないなら null。
 * 回復は足りない体力が効果の 6 割以上、偵察は使えればいつも（王を特定・その後は副将を特定）、
 * 運命の輪は満タンならいつも、巻き戻しは相手の応手で JUDGE_TAKEN 以上減ったとき、ほかは使ったときの読みの得点が使わないときより閾値以上よいとき。
 * 運命の輪で補充・王の移し替えが出て指定を待っているなら、その指定を返す
 */
export function chooseSkillUse(view: PlayerView, rng: () => number): SkillUse | null {
  const sk = view.skills;
  if (sk?.armed?.aim) return wheelAim(view, rng);
  if (skillBlock(view)) return null;
  const p = view.turn;
  const id = sk!.sides[p].card!;
  const gw = gaugeWeight(id, view.rules);
  const normal = lookahead(view, { gaugeW: gw, room: 0 });
  if (normal.cands.length === 0) return null;
  const room = skillLength(id, view.rules);
  const wo: Opt = sk!.shielded[p] ? { ownHalf: true } : {};
  const withRoom = (o: Opt): Opt => ({ ...wo, ...o, gaugeW: gw, room });
  const better = (o: Opt, th: number) => lookahead(view, withRoom(o)).best - normal.best >= th;
  switch (id) {
    case "firstaid":
    case "bigheal":
      return view.rules.hp[p] - view.hp[p] < SKILL_HEAL[id] * HEAL_NEED ? null : { id };
    case "refill": {
      const best = bestRefill(view, withRoom);
      return best && best.gain > normal.best ? { id, kind: best.kind } : null;
    }
    case "omni":
      return better({ dirsAll: true }, THRESHOLD.omni) ? { id } : null;
    case "strong":
      return better({ strong: true }, THRESHOLD.strong) ? { id } : null;
    case "wall":
      return better({ shield: true }, THRESHOLD.wall) ? { id } : null;
    case "scout":
      // 王を特定できるなら王、王が分かった・返した後は相手の今の副将（使えるならいつも。特定した副将は同じ手番の読みで罰 15 として狙う）
      return { id };
    case "kingmove": {
      // 今の王が次の手で返されうるときだけ、返されない駒へ（盤の端・隅を優先）
      const t = kingMoveTarget(view, rng);
      if (!t || !t.threatened || !t.safe) return null;
      return better({ kingCell: t.to }, THRESHOLD.kingmove) ? { id, to: t.to } : null;
    }
    case "fool":
      return better({ extra: true }, THRESHOLD.fool) ? { id } : null;
    case "wheel":
      return { id };
    case "judge":
      return takenSinceMyMove(view) >= JUDGE_TAKEN ? { id } : null;
  }
}

/** 運命の輪で出た補充・王の移し替えの指定（補充は読みで最もよい駒、王の移し替えは返されない駒を優先） */
function wheelAim(view: PlayerView, rng: () => number): SkillUse {
  const card = view.skills!.sides[view.turn].card!;
  if (view.skills!.armed!.effect === "refill") {
    const gw = gaugeWeight(card, view.rules);
    const best = bestRefill(view, (o) => ({ ...o, gaugeW: gw, room: skillLength(card, view.rules) }));
    return { id: "wheel", kind: best!.kind };
  }
  return { id: "wheel", to: kingMoveTarget(view, rng)!.to };
}

/**
 * 選んだ手 ch で置く駒を副将にして出すか（sim.ts の viceDesignate の safe 方針を、置く駒で出す形に写したもの）。
 * 置いた後に相手の次の手で返されない駒だけを副将にする: 盤の端・隅なら出し、ほかは 1 ÷ 期限までの残りの手数の確率で出す。
 * 返されうる手では出さない（期限の手は出さなくても置いた駒が自動で副将になる）。王を決める手・期限の手では false
 */
export function viceWith(view: PlayerView, ch: Choice, rng: () => number): boolean {
  const v = view.myVice;
  if (v.status !== "unset" || v.forcedNow || view.result || ch.king) return false;
  const p = view.turn;
  const q = other(p);
  const rules = moveRules(view);
  const lines = pieceLines(rawLines(view.board, ch.r, ch.c, p, rules.values), ch.kind, rules);
  if (rules.action === "flip" && lines.length === 0) return false;
  const after = applyLines(view.board, p, ch.r, ch.c, ch.kind, lines, rules);
  if (attackable(view.rules, after, view.hands[q], q).some(([y, x]) => y === ch.r && x === ch.c)) return false;
  const edge = (ch.r === 0 || ch.r === SIZE - 1 ? 1 : 0) + (ch.c === 0 || ch.c === SIZE - 1 ? 1 : 0);
  return edge > 0 || rng() < 1 / v.left;
}
