// e2e（skill-vice.spec.ts）の 2 人対戦で盤に再生する手順を、エンジンで先に探す（DOM なし）。
// 先手は偵察を持つ。①後手が置いて出した副将を先手が次の手で返す（罰 15）②後手の次の副将を偵察で特定し、返す（罰 30）までの手順。
// 画面は同じ手を打てば同じ局面になる（カードの配られ方はゲージにも手にも効かない）

import type { Cell } from "../src/engine/board";
import {
  createGame,
  legalCells,
  playableKinds,
  playMove,
  setSkills,
  skillBlock,
  targetsAt,
  useSkill,
  viceInfo,
  viewFor,
  type GameState,
} from "../src/engine/game";
import { presetById, type PieceKind, type Player } from "../src/engine/rules";
import { moverGain, type SkillId } from "../src/engine/skills";

export type Step =
  | { type: "move"; player: Player; r: number; c: number; kind: PieceKind; king: boolean; vice: boolean }
  | { type: "skill"; id: SkillId };

export interface Plan {
  steps: Step[];
  /** 罰 15・罰 30 で後手の副将を返した手（steps の添字） */
  hit15: number;
  hit30: number;
  /** 偵察で副将を特定した手順（steps の添字） */
  scoutVice: number;
  /** 各手順の後の体力（画面と突き合わせる） */
  hp: [number, number][];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Move {
  r: number;
  c: number;
  kind: PieceKind;
}

function movesOf(s: GameState): Move[] {
  const out: Move[] = [];
  for (const kind of playableKinds(s)) for (const [r, c] of legalCells(s, kind)) out.push({ r, c, kind });
  return out;
}

const hits = (s: GameState, m: Move, cell: Cell | null | undefined) => !!cell && targetsAt(s, m.r, m.c, m.kind).some(([y, x]) => y === cell[0] && x === cell[1]);

/** seed の乱数で手順を探す。見つからなければ null。p1card は後手のカード（画面で後手が選ぶカード） */
export function findPlan(seed: number, p1card: SkillId): Plan | null {
  const rand = mulberry32(seed);
  let s = setSkills(createGame(presetById("skill").rules), ["scout", p1card]);
  const steps: Step[] = [];
  const hp: [number, number][] = [];
  let hit15 = -1;
  let scoutVice = -1;
  const push = (st: Step, next: GameState) => {
    steps.push(st);
    s = next;
    hp.push([s.hp[0], s.hp[1]]);
  };
  const play = (m: Move, king = false, vice = false) => push({ type: "move", player: s.turn, ...m, king, vice }, playMove(s, m.r, m.c, m.kind, { king, vice }));
  for (let guard = 0; guard < 120 && !s.result; guard++) {
    const p = s.turn;
    const moves = movesOf(s);
    // 両者とも最初の手で置く駒を王にする
    const king = viewFor(s, p).myKing.canDesignate;
    if (p === 1) {
      // 後手: 副将を出す期間なら、1 本目は先手が次の手で返せるマス、2 本目は返されないマスに副将を置く
      if (viceInfo(s, 1).status === "unset") {
        const chosen = moves.find((m) => {
          const after = playMove(s, m.r, m.c, m.kind, { vice: true });
          if (after.result || after.turn !== 0) return false;
          const reach = movesOf(after).some((x) => hits(after, x, [m.r, m.c]));
          return hit15 < 0 ? reach : !reach;
        });
        if (chosen) {
          play(chosen, false, true);
          continue;
        }
      }
      // 大きく返さない手から乱数で
      const calm = moves.filter((m) => targetsAt(s, m.r, m.c, m.kind).length <= 2);
      const pool = calm.length > 0 ? calm : moves;
      play(pool[Math.floor(rand() * pool.length)], king);
      continue;
    }
    // 先手: 副将は出せる最初の手で出す
    const myVice = viceInfo(s, 0).status === "unset";
    // 偵察が使えれば使う（王を特定・その後は副将を特定）
    if (skillBlock(viewFor(s, 0)) === null) {
      push({ type: "skill", id: "scout" }, useSkill(s, { id: "scout" }));
      if (s.skills!.armed?.scout === "vice") scoutVice = steps.length - 1;
    }
    const vice = s.kings[1].vice;
    const target = vice?.cell;
    // ①副将を返す（罰 15）②特定した副将を返す（罰 30）
    const want = hit15 < 0 || vice?.seen ? moves.find((m) => hits(s, m, target)) : undefined;
    if (want) {
      play(want, false, myVice);
      if (hit15 < 0) hit15 = steps.length - 1;
      else return { steps, hit15, hit30: steps.length - 1, scoutVice, hp };
      continue;
    }
    // ほかは後手の副将を返さない手のうち、後手の王を返す手、なければゲージが多く溜まる手
    const safe = moves.filter((m) => !hits(s, m, target));
    const pool = safe.length > 0 ? safe : moves;
    const kc = s.kings[1].revealed ? null : s.kings[1].cell;
    const gain = (m: Move) => moverGain("scout", [m.r, m.c], targetsAt(s, m.r, m.c, m.kind).map(([r, c]) => ({ r, c })));
    const score = (m: Move) => (hits(s, m, kc) ? 1000 : 0) + gain(m) + rand();
    play(pool.reduce((a, b) => (score(b) > score(a) ? b : a)), king, myVice);
  }
  return null;
}
