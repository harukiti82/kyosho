// e2e（skill-vice.spec.ts）の 2 人対戦で盤に再生する手順を、エンジンで先に探す（DOM なし）。
// 先手は偵察を持つ。①後手が置いて出した副将を先手が次の手で返す（罰 15）②後手が次の窓で置き直した副将を偵察で特定し、返す（罰は同じ 15）までの手順。
// 画面は同じ手を打てば同じ局面になる（カードの配られ方はゲージにも手にも効かない）

import type { Cell } from "../src/engine/board";
import {
  createGame,
  legalCells,
  playableKinds,
  playMove,
  previewMove,
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
  /** 後手の副将を返した手（steps の添字）。hitFirst は 1 本目、hitScouted は偵察で特定した 2 本目 */
  hitFirst: number;
  hitScouted: number;
  /** 偵察で副将を特定した手順（steps の添字） */
  scoutVice: number;
  /** 偵察で特定した副将のマス */
  scoutedCell: Cell;
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
  let hitFirst = -1;
  let scoutVice = -1;
  let scoutedCell: Cell = [0, 0];
  const push = (st: Step, next: GameState) => {
    steps.push(st);
    s = next;
    hp.push([s.hp[0], s.hp[1]]);
  };
  const play = (m: Move, king = false, vice = false) => push({ type: "move", player: s.turn, ...m, king, vice }, playMove(s, m.r, m.c, m.kind, { king, vice }));
  // ダメージの小さい手（対局を長く続け、後手が 21 手を打つまで決着させない）
  const calm = (moves: Move[]) => {
    const dmg = (m: Move) => previewMove(s, m.r, m.c, m.kind)?.damage ?? 0;
    const least = Math.min(...moves.map(dmg));
    return moves.filter((m) => dmg(m) <= least + 1);
  };
  for (let guard = 0; guard < 200 && !s.result; guard++) {
    const p = s.turn;
    const moves = movesOf(s);
    // 先手は最初の手で置く駒を王にする。後手は王を決めず、期限の 7 手目で自動の王にする
    // （窓が王の期限から始まり、相手に副将を見せる時期と窓の期限が揃う。早く決めると見せたときには置き直している）
    const king = p === 0 && viewFor(s, p).myKing.canDesignate;
    if (p === 1) {
      // 後手: 1 つ目の窓だけ、先手が次の手で返せるマスに副将を置く。2 つ目からは置かず、窓の最後の手で自動で置き直す
      if (hitFirst < 0 && viceInfo(s, 1).status === "unset") {
        const chosen = moves.find((m) => {
          const after = playMove(s, m.r, m.c, m.kind, { vice: true });
          if (after.result || after.turn !== 0) return false;
          return movesOf(after).some((x) => hits(after, x, [m.r, m.c]));
        });
        if (chosen) {
          play(chosen, false, true);
          continue;
        }
      }
      const pool = calm(moves);
      play(pool[Math.floor(rand() * pool.length)]);
      continue;
    }
    // 先手: 副将は出せる最初の手で出す
    const myVice = viceInfo(s, 0).status === "unset";
    // 偵察が使えれば使う（王を特定・その後は副将を特定）
    if (skillBlock(viewFor(s, 0)) === null) {
      push({ type: "skill", id: "scout" }, useSkill(s, { id: "scout" }));
      if (s.skills!.armed?.scout === "vice") {
        scoutVice = steps.length - 1;
        scoutedCell = viewFor(s, 0).oppVice.cell!;
      }
    }
    // 後手の今の副将（エンジンの真の状態。手順を探すためだけに読む）
    const vice = viceInfo(s, 1);
    const target = vice.cell;
    // ①副将を返す ②偵察で特定した今の副将を返す（どちらも罰 15）
    const want = hitFirst < 0 || vice.seen ? moves.find((m) => hits(s, m, target)) : undefined;
    if (want) {
      play(want, false, myVice);
      if (hitFirst < 0) hitFirst = steps.length - 1;
      else return { steps, hitFirst, hitScouted: steps.length - 1, scoutVice, scoutedCell, hp };
      continue;
    }
    // ほかは後手の副将を返さない手のうち、後手の王を返す手、なければゲージが多く溜まる手
    const safe = moves.filter((m) => !hits(s, m, target));
    const pool = calm(safe.length > 0 ? safe : moves);
    const kc = s.kings[1].revealed ? null : s.kings[1].cell;
    const gain = (m: Move) => moverGain("scout", [m.r, m.c], targetsAt(s, m.r, m.c, m.kind).map(([r, c]) => ({ r, c })));
    const score = (m: Move) => (hits(s, m, kc) ? 1000 : 0) + gain(m) + rand();
    play(pool.reduce((a, b) => (score(b) > score(a) ? b : a)), king, myVice);
  }
  return null;
}
