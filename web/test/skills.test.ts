import { describe, expect, it } from "vitest";
import { SIZE } from "../src/engine/board";
import {
  createGame,
  dealSkills,
  gameFrom,
  isLegal,
  kingInfo,
  lastMoveOf,
  pickSkill,
  playMove,
  previewMove,
  refillKinds,
  setSkills,
  skillBlock,
  useSkill,
  viewFor,
  type GameState,
  type MoveEvent,
} from "../src/engine/game";
import { chooseMove } from "../src/engine/cpu";
import { chooseSkillUse } from "../src/engine/skillcpu";
import { NO_KING, type Hand, type PieceKind, type Player } from "../src/engine/rules";
import { gaugeMax, GAUGE_UNIT, SKILLS, SKILL_ORDER, type SkillId, type SkillsState } from "../src/engine/skills";
import { at, rulesOf } from "./helpers";

/** 全方向・上乗せなし・回復なし・隠し王なしのスキルあり（ダメージ = 返した駒の数字の合計） */
const PLAIN = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { ...NO_KING } });
const EMPTY: Hand = { fu: 0, yoko: 0, gin: 0, kaku: 0, kin: 0, hi: 0 };

/** stones: { "a1": [持ち主, 駒種] } の局面から、カードを決めて始める */
function game(
  stones: Record<string, readonly [Player, PieceKind]>,
  cards: [SkillId | null, SkillId | null],
  opts: { rules?: typeof PLAIN; hp?: [number, number]; hands?: [Partial<Hand>, Partial<Hand>]; kings?: [string | null, string | null] } = {},
): GameState {
  const s = gameFrom(opts.rules ?? PLAIN, {
    stones: Object.entries(stones).map(([name, [owner, kind]]) => ({ at: at(name), owner, kind })),
    hands: opts.hands ? [{ ...EMPTY, fu: 9, ...opts.hands[0] }, { ...EMPTY, fu: 9, ...opts.hands[1] }] : undefined,
    hp: opts.hp,
    kings: opts.kings ? [opts.kings[0] ? at(opts.kings[0]) : null, opts.kings[1] ? at(opts.kings[1]) : null] : undefined,
  });
  return setSkills(s, cards);
}

/** p のゲージを満タンにする */
function full(s: GameState, p: Player = s.turn): GameState {
  const sides: SkillsState["sides"] = [s.skills!.sides[0], s.skills!.sides[1]];
  sides[p] = { ...sides[p], gauge: gaugeMax(sides[p].card!) };
  return { ...s, skills: { ...s.skills!, sides } };
}

const play = (s: GameState, name: string, kind: PieceKind = "fu", king = false) => playMove(s, ...at(name), kind, { king });
const last = (s: GameState) => lastMoveOf(s) as MoveEvent;
const gauge = (s: GameState, p: Player) => s.skills!.sides[p].gauge / GAUGE_UNIT;

describe("カード", () => {
  it("8 枚の長さと溜めマス点（長さ × 割合）", () => {
    expect(SKILL_ORDER.map((id) => [SKILLS[id].name, SKILLS[id].length, SKILLS[id].zone])).toEqual([
      ["応急手当", 20, 4],
      ["大回復", 80, 12],
      ["強打", 26, 4],
      ["全方向", 32, 4],
      ["補充", 26, 4],
      ["鉄壁", 20, 4],
      ["偵察", 20, 4],
      ["王の移し替え", 26, 4],
    ]);
  });
  it("スキルなしのルールには状態を持たない（既存の対局は変わらない）", () => {
    const s = createGame(rulesOf("std"));
    expect(s.skills).toBeUndefined();
    expect(viewFor(s, 0).skills).toBeUndefined();
    expect(skillBlock(viewFor(s, 0))).toBe("off");
  });
  it("3 枚ずつ配り、1 枚を選ぶ。両者が選ぶまで打てず、相手の候補と選んだカードは見せない", () => {
    let s = createGame(rulesOf("skill"));
    let n = 0;
    s = dealSkills(s, () => ((n = (n * 7 + 3) % 10), n / 10));
    for (const side of s.skills!.sides) {
      expect(side.offer).toHaveLength(3);
      expect(new Set(side.offer).size).toBe(3);
    }
    expect(() => dealSkills(s, Math.random)).toThrow();
    expect(() => play(s, "d3")).toThrow();
    const mine = s.skills!.sides[0].offer[1];
    const notOffered = SKILL_ORDER.find((id) => !s.skills!.sides[0].offer.includes(id))!;
    expect(() => pickSkill(s, 0, notOffered)).toThrow();
    s = pickSkill(s, 0, mine);
    expect(() => pickSkill(s, 0, s.skills!.sides[0].offer[0])).toThrow();
    // 後手から見ると、先手の候補は空・選んだカードは選び終えるまで null
    expect(viewFor(s, 1).skills!.sides[0]).toEqual({ offer: [], card: null, gauge: 0 });
    expect(viewFor(s, 0).skills!.sides[0].card).toBe(mine);
    expect(skillBlock(viewFor(s, 0))).toBe("picking");
    s = pickSkill(s, 1, s.skills!.sides[1].offer[0]);
    expect(s.skills!.ready).toBe(true);
    expect(viewFor(s, 1).skills!.sides[0].card).toBe(mine);
    expect(viewFor(s, 1).skills!.sides[0].offer).toEqual([]);
  });
  it("隠し王なしのルールでは偵察・王の移し替えを配らない", () => {
    for (let i = 0; i < 20; i++) {
      const s = dealSkills(createGame(PLAIN), () => (i + 0.5) / 20);
      for (const side of s.skills!.sides) expect(side.offer.filter((id) => id === "scout" || id === "kingmove")).toEqual([]);
    }
  });
});

describe("ゲージ", () => {
  it("返した枚数で累進（1 枚 +1・2 枚 +2・3 枚 +4・4 枚以上 +7）、受けた側はダメージ 1 点ごとに +0.15", () => {
    const expected = [1, 2, 4, 7, 7];
    for (let n = 1; n <= 5; n++) {
      const stones: Record<string, readonly [Player, PieceKind]> = { a8: [0, "fu"] };
      for (let i = 1; i <= n; i++) stones[`${"abcdefgh"[i]}8`] = [1, "fu"];
      const s = play(game(stones, ["strong", "wall"]), `${"abcdefgh"[n + 1]}8`);
      expect(last(s).targets).toHaveLength(n);
      expect(gauge(s, 0)).toBe(expected[n - 1]);
      expect(gauge(s, 1)).toBeCloseTo(n * 0.15, 10);
    }
  });
  it("溜めマス（c3・f3・c6・f6）に置く・溜めマス上の相手の駒を返すと、1 回ごとにカードの溜めマス点", () => {
    // c3 に置いて 1 枚返す: 1 + 4
    expect(gauge(play(game({ a3: [0, "fu"], b3: [1, "fu"] }, ["strong", null]), "c3"), 0)).toBe(5);
    // c3 上の相手の駒を含む 2 枚を返す: 2 + 4
    expect(gauge(play(game({ a3: [0, "fu"], b3: [1, "fu"], c3: [1, "fu"] }, ["strong", null]), "d3"), 0)).toBe(6);
    // 大回復は溜めマス 1 回で 12
    expect(gauge(play(game({ a3: [0, "fu"], b3: [1, "fu"] }, ["bigheal", null]), "c3"), 0)).toBe(13);
  });
  it("受けたダメージには王の罰も入る。カードのない人のゲージは増えない", () => {
    const rules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 1 } });
    let s = game({ a1: [0, "fu"], b1: [1, "fu"], h8: [1, "fu"], g8: [0, "fu"] }, [null, "wall"], { rules, kings: [null, "b1"] });
    s = play(s, "c1");
    expect(last(s).king?.penalty).toBe(30);
    expect(gauge(s, 1)).toBeCloseTo(31 * 0.15, 10);
    expect(s.skills!.sides[0].gauge).toBe(0);
  });
  it("満タンで止まり、使うと 0 から溜め直す", () => {
    let s = full(game({ a8: [0, "fu"], b8: [1, "fu"], c8: [1, "fu"], d8: [1, "fu"], e8: [1, "fu"], h1: [1, "fu"], g1: [0, "fu"] }, ["wall", null]));
    expect(play(s, "f8").skills!.sides[0].gauge).toBe(gaugeMax("wall"));
    s = useSkill(s, { id: "wall" });
    expect(s.skills!.sides[0].gauge).toBe(0);
    expect(skillBlock(viewFor(s, 0))).toBe("used");
    expect(gauge(play(s, "f8"), 0)).toBe(7);
  });
  it("満タンでなければ使えない", () => {
    const s = game({ a1: [0, "fu"], b1: [1, "fu"] }, ["strong", null]);
    expect(skillBlock(viewFor(s, 0))).toBe("charging");
    expect(() => useSkill(s, { id: "strong" })).toThrow();
  });
});

describe("8 枚の効果", () => {
  const base = { a1: [0, "fu"], b1: [1, "fu"] } as const;
  it("応急手当: 体力 +2。初期体力を超えず、初期値なら使えない", () => {
    const at100 = useSkill(full(game(base, ["firstaid", null], { hp: [100, 130] })), { id: "firstaid" });
    expect(at100.hp[0]).toBe(102);
    expect(at100.skills!.armed).toEqual({ id: "firstaid", heal: 2 });
    const at128 = useSkill(full(game(base, ["firstaid", null], { hp: [128, 130] })), { id: "firstaid" });
    expect(at128.hp[0]).toBe(129);
    expect(last(play(at128, "c1")).skill).toEqual({ id: "firstaid", heal: 1 });
    const fullHp = full(game(base, ["firstaid", null]));
    expect(skillBlock(viewFor(fullHp, 0))).toBe("fullHp");
    expect(() => useSkill(fullHp, { id: "firstaid" })).toThrow();
  });
  it("大回復: 体力 +10（初期体力まで）", () => {
    expect(useSkill(full(game(base, ["bigheal", null], { hp: [100, 130] })), { id: "bigheal" }).hp[0]).toBe(110);
    expect(useSkill(full(game(base, ["bigheal", null], { hp: [125, 130] })), { id: "bigheal" }).hp[0]).toBe(129);
  });
  it("強打: その手のダメージ ×1.5（端数切り捨て）。次の手には効かない", () => {
    const stones = { a8: [0, "fu"], b8: [1, "fu"], c8: [1, "fu"], d8: [1, "fu"], e8: [1, "fu"], f8: [1, "fu"], a1: [1, "fu"], b1: [0, "fu"] } as const;
    let s = useSkill(full(game(stones, ["strong", null])), { id: "strong" });
    expect(previewMove(s, ...at("g8"), "fu")).toMatchObject({ damage: 7, plain: 5, mods: ["strong"] });
    s = play(s, "g8");
    expect(last(s)).toMatchObject({ damage: 7, plain: 5, skill: { id: "strong" } });
    expect(s.hp[1]).toBe(130 - 7);
    expect(s.skills!.armed).toBeNull();
    // 後手が打ったあと、次の先手の手は元のダメージ
    s = play(s, "c1");
    expect(last(s).plain).toBeUndefined();
  });
  it("全方向: その手で置く駒だけが 8 方向に挟める", () => {
    const rules = rulesOf("skill", { anchor: "none", heal: "none", king: { ...NO_KING } });
    // 歩は縦だけ。横に挟む c1 は普段は置けない
    const stones = { a1: [0, "fu"], b1: [1, "fu"], b3: [1, "fu"], b4: [0, "fu"], a6: [1, "fu"], b6: [0, "fu"] } as const;
    let s = full(game(stones, ["omni", null], { rules }));
    expect(isLegal(s, ...at("c1"), "fu")).toBe(false);
    s = useSkill(s, { id: "omni" });
    expect(isLegal(s, ...at("c1"), "fu")).toBe(true);
    s = play(s, "c1");
    expect(s.board[0][1]?.owner).toBe(0);
    expect(s.rules.dirs).toBe("piece");
    // 次の手番からは元どおり（後手の歩は横に挟めず、横なら挟める）
    expect(s.turn).toBe(1);
    expect(isLegal(s, ...at("c6"), "fu")).toBe(false);
    expect(isLegal(s, ...at("c6"), "yoko")).toBe(true);
  });
  it("補充: 使い切った数字 3 以下の駒を 1 つ戻す。金（5）は戻せず、戻せる駒がなければ使えない", () => {
    const s = full(game(base, ["refill", null], { hands: [{ fu: 3, yoko: 0, kaku: 0, kin: 0, hi: 0 }, {}] }));
    expect(refillKinds(s)).toEqual(["yoko", "kaku", "hi"]);
    expect(() => useSkill(s, { id: "refill", kind: "kin" })).toThrow();
    expect(() => useSkill(s, { id: "refill", kind: "fu" })).toThrow();
    const after = useSkill(s, { id: "refill", kind: "hi" });
    expect(after.hands[0].hi).toBe(1);
    expect(last(playMove(after, ...at("c1"), "fu")).skill).toEqual({ id: "refill", kind: "hi" });
    // 歩・横・角・飛が残っていて、使い切ったのが金だけなら戻せる駒がない
    const none = full(game(base, ["refill", null], { hands: [{ fu: 1, yoko: 1, kaku: 1, hi: 1, kin: 0 }, {}] }));
    expect(refillKinds(none)).toEqual([]);
    expect(skillBlock(viewFor(none, 0))).toBe("noRefill");
  });
  it("鉄壁: 相手の次の手のダメージを半分（端数切り捨て）。駒は返り、その次は元どおり", () => {
    const stones = { a1: [0, "fu"], b1: [1, "fu"], a8: [1, "fu"], b8: [0, "fu"], c8: [0, "fu"], d8: [0, "fu"], e8: [0, "fu"], f8: [0, "fu"] } as const;
    let s = useSkill(full(game(stones, ["wall", null])), { id: "wall" });
    expect(s.skills!.shielded).toEqual([false, true]);
    s = play(s, "c1");
    expect(previewMove(s, ...at("g8"), "fu")).toMatchObject({ damage: 2, plain: 5, mods: ["shield"] });
    s = play(s, "g8");
    expect(last(s)).toMatchObject({ damage: 2, plain: 5, shielded: true });
    expect(last(s).targets).toHaveLength(5);
    expect(s.hp[0]).toBe(129 - 2);
    expect(s.skills!.shielded).toEqual([false, false]);
  });
  describe("偵察", () => {
    const rules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 1 } });
    /** 後手が b1 に王を置いた（期限 1 手）局面。先手の手番 */
    function hidden(): GameState {
      let s = game({ a1: [0, "fu"], b1: [1, "fu"], h8: [0, "fu"], h7: [1, "fu"] }, ["scout", "wall"], { rules, kings: [null, "b1"] });
      // 後手が期限の 1 手を打った棋譜（公開情報）
      const fake: MoveEvent = { type: "move", ply: 1, player: 1, r: 0, c: 1, kind: "fu", targets: [], damage: 0, heal: 0 };
      s = { ...s, ply: 1, history: [fake] };
      return full(s);
    }
    it("相手の王を自分にだけ特定して見せる（相手の画面と棋譜には場所が出ない）", () => {
      const s = useSkill(hidden(), { id: "scout" });
      expect(viewFor(s, 0).oppKing).toEqual({ revealed: false, candidates: [[0, 1]], scouted: true });
      expect(viewFor(s, 1).oppKing.scouted).toBe(false);
      expect(kingInfo(s, 1).seen).toBe(true);
      expect(JSON.stringify(s.skills!.armed)).not.toContain("[0,1]");
      expect(last(play(s, "h6")).skill).toEqual({ id: "scout" });
    });
    it("偵察した手でその王を返すと罰が 2 倍（−60）", () => {
      const s = play(useSkill(hidden(), { id: "scout" }), "c1");
      expect(last(s).king).toMatchObject({ penalty: 60 });
      expect(s.hp[1]).toBe(130 - 1 - 60);
      // 偵察しない手なら −30
      expect(play(hidden(), "c1").hp[1]).toBe(130 - 1 - 30);
    });
    it("相手が期限の手まで打つ前・王を返した後は使えない", () => {
      const before = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["scout", null], { rules, kings: [null, "b1"] }));
      expect(skillBlock(viewFor(before, 0))).toBe("noTarget");
      // 王を返した後に先手の手番が来ても使えない
      const s = play(hidden(), "c1");
      expect(skillBlock(viewFor(full({ ...s, turn: 0 }, 0), 0))).toBe("noTarget");
    });
  });
  describe("王の移し替え", () => {
    const rules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 7 } });
    const stones = { a1: [0, "fu"], b1: [1, "fu"], d4: [0, "fu"], d6: [0, "fu"], d7: [0, "fu"], f6: [0, "fu"], h8: [1, "fu"] } as const;
    const start = () => full(game(stones, ["kingmove", "scout"], { rules, kings: ["d4", null] }));
    it("今の王から 2 マス以内の自分の駒へ移す（3 マス以上・今の王・空きマス・相手の駒は不可）", () => {
      const s = start();
      for (const bad of ["d7", "d4", "c4", "b1"]) expect(() => useSkill(s, { id: "kingmove", to: at(bad) })).toThrow();
      const moved = useSkill(s, { id: "kingmove", to: at("f6") });
      expect(kingInfo(moved, 0).cell).toEqual(at("f6"));
      // 棋譜・相手の画面に移した先は出ない。相手から見た候補は使った時点の自分の駒すべて
      const after = play(moved, "c1");
      expect(last(after).skill).toEqual({ id: "kingmove", cands: expect.any(Array) });
      const cands = viewFor(after, 1).oppKing.candidates.map(([r, c]) => r * SIZE + c).sort((a, b) => a - b);
      expect(cands).toEqual(["a1", "d4", "d6", "d7", "f6"].map((n) => at(n)[0] * SIZE + at(n)[1]).sort((a, b) => a - b));
      expect(JSON.stringify(viewFor(after, 1))).not.toContain('"cell":[5,5]');
    });
    it("偵察で知られた王を移すと、相手はもう場所を知らない", () => {
      let s = start();
      s = { ...s, kings: [{ ...s.kings[0], seen: true }, s.kings[1]] };
      expect(kingInfo(s, 0).seen).toBe(true);
      s = useSkill(s, { id: "kingmove", to: at("d6") });
      expect(kingInfo(s, 0).seen).toBe(false);
      expect(viewFor(s, 1).oppKing.scouted).toBe(false);
    });
    it("王が隠れていない（未指定・返された後）なら使えない", () => {
      const unset = full(game(stones, ["kingmove", null], { rules }));
      expect(skillBlock(viewFor(unset, 0))).toBe("noKing");
      const revealed = start();
      const r: GameState = { ...revealed, kings: [{ ...revealed.kings[0], revealed: true }, revealed.kings[1]] };
      expect(skillBlock(viewFor(r, 0))).toBe("noKing");
    });
    it("2 マス以内に自分の駒がなければ使えない", () => {
      const lonely = full(game({ a1: [0, "fu"], b1: [1, "fu"], h8: [0, "fu"] }, ["kingmove", null], { rules, kings: ["h8", null] }));
      expect(skillBlock(viewFor(lonely, 0))).toBe("noRoom");
    });
  });
});

describe("CPU のスキル", () => {
  it("満タンでなければ使わない。回復は足りない体力が効果の 6 割以上のときだけ", () => {
    const base = { a1: [0, "fu"], b1: [1, "fu"] } as const;
    expect(chooseSkillUse(viewFor(game(base, ["firstaid", null], { hp: [100, 130] }), 0), () => 0.5)).toBeNull();
    // 応急手当（+2）は 2 以上、大回復（+10）は 6 以上足りないとき
    expect(chooseSkillUse(viewFor(full(game(base, ["firstaid", null], { hp: [128, 130] })), 0), () => 0.5)).toBeNull();
    expect(chooseSkillUse(viewFor(full(game(base, ["firstaid", null], { hp: [127, 130] })), 0), () => 0.5)).toEqual({ id: "firstaid" });
    expect(chooseSkillUse(viewFor(full(game(base, ["bigheal", null], { hp: [124, 130] })), 0), () => 0.5)).toBeNull();
    expect(chooseSkillUse(viewFor(full(game(base, ["bigheal", null], { hp: [123, 130] })), 0), () => 0.5)).toEqual({ id: "bigheal" });
  });
  it("補充は数字の大きい駒を戻す", () => {
    const s = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["refill", null], { hands: [{ fu: 3, yoko: 0, kaku: 0, kin: 0, hi: 0 }, {}] }));
    expect(chooseSkillUse(viewFor(s, 0), () => 0.5)).toEqual({ id: "refill", kind: "hi" });
  });
  it.each(SKILL_ORDER.flatMap((id) => (["easy", "normal", "hard"] as const).map((lv) => [id, lv] as const)))(
    "%s・%s: スキルを使いながら合法手だけで終局まで進む（ゲージは満タンを超えない）",
    (id, level) => {
      let seed = 7;
      const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      let s = setSkills(createGame(rulesOf("skill")), [id, SKILL_ORDER[(SKILL_ORDER.indexOf(id) + 3) % 8]]);
      let uses = 0;
      while (!s.result) {
        const p = s.turn;
        const use = chooseSkillUse(viewFor(s, p), rng);
        if (use) {
          s = useSkill(s, use);
          uses++;
        }
        const ch = chooseMove(viewFor(s, p), level, rng)!;
        expect(isLegal(s, ch.r, ch.c, ch.kind)).toBe(true);
        s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
        for (const side of s.skills!.sides) expect(side.gauge).toBeLessThanOrEqual(gaugeMax(side.card!));
        expect(s.skills!.armed).toBeNull();
      }
      expect(s.history.filter((e) => e.type === "move" && e.skill).length).toBe(uses);
    },
    30_000,
  );
});
