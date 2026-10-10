// スキルを持つ CPU。使うか・どう使うか（chooseSkillUse）と、スキル込みの 2 手読み（skillLookahead）。
// リポジトリ外のシミュレーター（kyosho-skillsim の sim.ts の plan / lookahead）の規則を写したもの。
// スキルなしの対局では使わない（cpu.ts の手は変わらない）。乱数は引数で受ける。

import { applyLines, damageOf, emptyCells, healOf, pieceLines, rawLines, SIZE, targetsOf, type Cell } from "./board";
import { attackable, availableKinds, bestReply, kingMoveCells, moveRules, refillKinds, skillBlock, type PlayerView } from "./game";
import { other, type PieceKind, type Player } from "./rules";
import {
  FLIP_POINTS,
  gaugeMax,
  GAUGE_UNIT,
  isZone,
  shieldDamage,
  SKILL_HEAL,
  SKILLS,
  strongDamage,
  type SkillId,
  type SkillUse,
} from "./skills";
import type { Choice } from "./cpu";

/** ゲージ 1 点の価値の元（点。回復は効果の量 ÷ 長さ） */
const GAUGE_VALUE: Record<SkillId, number> = { firstaid: 10, bigheal: 30, strong: 6, omni: 6, refill: 6, wall: 8, scout: 5, kingmove: 6 };
/** 使う条件（使ったときの読みの得点が、使わないときよりこれ以上よい） */
const THRESHOLD = { omni: 2, strong: 6, wall: 6, kingmove: 1 } as const;
/** 回復は、足りない体力が効果の量のこの割合以上のときに使う */
const HEAL_NEED = 0.6;
/** 補充は、戻す駒の数字のこの倍を得点に足して比べる */
const REFILL_BONUS = 1.5;

/** ゲージ 1 点の価値（点） */
const gaugeWeight = (id: SkillId) => (id === "firstaid" || id === "bigheal" ? SKILL_HEAL[id] : GAUGE_VALUE[id]) / SKILLS[id].length;

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
  /** 王を返す罰の倍率（偵察） */
  penMul?: number;
  /** ゲージ 1 点の価値と、満タンまでの残り（点） */
  gaugeW?: number;
  room?: number;
}

const key = (r: number, c: number) => r * SIZE + c;

function penaltyOf(view: PlayerView, victim: Player): number {
  const { king } = view.rules;
  return king.penalty === "lose" ? Math.max(1, view.hp[victim]) : king.amount;
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
  let best = -Infinity;
  let cands: Choice[] = [];
  for (const [r, c] of emptyCells(board)) {
    const raw = rawLines(board, r, c, p, rules.values);
    const myKing: Cell | null = o.designate ? [r, c] : o.kingCell !== undefined ? o.kingCell : view.myKing.cell;
    for (const kind of myKinds) {
      const lines = pieceLines(raw, kind, o.dirsAll ? allRules : rules);
      if (rules.action === "flip" && lines.length === 0) continue;
      let d = damageOf(board, lines, rules);
      if (o.strong) d = strongDamage(d);
      if (o.ownHalf) d = shieldDamage(d);
      let own = d + healOf(lines, rules.values[kind], rules);
      if (oppPenalty > 0) own += oppPenalty * (o.penMul ?? 1) * lines.reduce((n, l) => n + l.cells.filter(([y, x]) => oc.has(key(y, x))).length, 0);
      if (card && o.gaugeW && o.room && o.room > 0) {
        const ts = targetsOf(lines);
        const zoneHits = (isZone(r, c) ? 1 : 0) + ts.filter(([y, x]) => isZone(y, x)).length;
        const g = FLIP_POINTS[Math.min(ts.length, FLIP_POINTS.length - 1)] + SKILLS[card].zone * zoneHits;
        own += o.gaugeW * Math.min(o.room, g);
      }
      const next = applyLines(board, p, r, c, kind, lines, rules);
      const br = bestReply(rules, next, oppHand, q, myKing ? { cell: myKing, penalty: myPenalty } : undefined);
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
  const o: Opt = { gaugeW: gaugeWeight(card), room: (gaugeMax(card) - sk.sides[p].gauge) / GAUGE_UNIT };
  if (sk.shielded[p]) o.ownHalf = true;
  switch (sk.armed?.id) {
    case "strong":
      o.strong = true;
      break;
    case "omni":
      o.dirsAll = true;
      break;
    case "wall":
      o.shield = true;
      break;
    case "scout":
      o.penMul = 2;
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
  const normal = lookahead(view, o);
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

/**
 * 手番の CPU がこの手番の頭でスキルを使うなら、その指定。使わない・使えないなら null。
 * 回復は足りない体力が効果の 6 割以上、偵察は使えればいつも、ほかは使ったときの読みの得点が使わないときより閾値以上よいとき
 */
export function chooseSkillUse(view: PlayerView, rng: () => number): SkillUse | null {
  if (skillBlock(view)) return null;
  const sk = view.skills!;
  const p = view.turn;
  const q = other(p);
  const id = sk.sides[p].card!;
  const gw = gaugeWeight(id);
  const normal = lookahead(view, { gaugeW: gw, room: 0 });
  if (normal.cands.length === 0) return null;
  const room = SKILLS[id].length;
  const wo: Opt = sk.shielded[p] ? { ownHalf: true } : {};
  const withRoom = (o: Opt): Opt => ({ ...wo, ...o, gaugeW: gw, room });
  const better = (o: Opt, th: number) => lookahead(view, withRoom(o)).best - normal.best >= th;
  switch (id) {
    case "firstaid":
    case "bigheal":
      return view.rules.hp[p] - view.hp[p] < SKILL_HEAL[id] * HEAL_NEED ? null : { id };
    case "refill": {
      const kinds = refillKinds(view);
      const kind = kinds[kinds.length - 1];
      const gain = lookahead(view, withRoom({ handPlus: kind })).best + REFILL_BONUS * view.rules.values[kind];
      return gain > normal.best ? { id, kind } : null;
    }
    case "omni":
      return better({ dirsAll: true }, THRESHOLD.omni) ? { id } : null;
    case "strong":
      return better({ strong: true }, THRESHOLD.strong) ? { id } : null;
    case "wall":
      return better({ shield: true }, THRESHOLD.wall) ? { id } : null;
    case "scout":
      // 候補が 1 つなら場所は分かっている
      return view.oppKing.candidates.length >= 2 ? { id } : null;
    case "kingmove": {
      // 今の王が次の手で返されうるときだけ、返されない駒へ（盤の端・隅を優先）
      const kc = view.myKing.cell!;
      const threatened = new Set(attackable(view.rules, view.board, view.hands[q], q).map(([y, x]) => key(y, x)));
      if (!threatened.has(key(kc[0], kc[1]))) return null;
      const safe = kingMoveCells(view).filter(([y, x]) => !threatened.has(key(y, x)));
      if (safe.length === 0) return null;
      const edge = ([y, x]: Cell) => (y === 0 || y === SIZE - 1 ? 1 : 0) + (x === 0 || x === SIZE - 1 ? 1 : 0);
      const most = Math.max(...safe.map(edge));
      const top = safe.filter((c) => edge(c) === most);
      const to = top[Math.floor(rng() * top.length)];
      return better({ kingCell: to }, THRESHOLD.kingmove) ? { id, to } : null;
    }
  }
}
