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
  playTimeout,
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
import { BASE_SKILLS, gaugeMax, GAUGE_UNIT, SKILLS, SKILL_ORDER, type SkillId, type SkillsState } from "../src/engine/skills";
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
  it("11 枚の長さと溜めマス点", () => {
    expect(SKILL_ORDER.map((id) => [SKILLS[id].name, SKILLS[id].tarot, SKILLS[id].length, SKILLS[id].zone])).toEqual([
      ["応急手当", "星", 20, 4],
      ["大回復", "女帝", 80, 12],
      ["強打", "力", 26, 4],
      ["全方向", "戦車", 32, 4],
      ["補充", "節制", 56, 4],
      ["鉄壁", "皇帝", 20, 4],
      ["偵察", "隠者", 30, 4],
      ["王の移し替え", "魔術師", 26, 4],
      ["連続行動", "愚者", 36, 4],
      ["運命の輪", "運命の輪", 36, 4],
      ["巻き戻し", "審判", 30, 4],
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
  it("補充: 始めの数より減った駒を 1 つ戻す。数字は問わず金・飛も戻せ、減った駒がなければ使えない", () => {
    // 始めの持ち駒は 歩 10・横 10・角 4・金 2・飛 3
    const s = full(game(base, ["refill", null], { hands: [{ fu: 9, yoko: 10, kaku: 3, kin: 0, hi: 3 }, {}] }));
    expect(refillKinds(s)).toEqual(["fu", "kaku", "kin"]);
    expect(() => useSkill(s, { id: "refill", kind: "yoko" })).toThrow();
    expect(() => useSkill(s, { id: "refill", kind: "hi" })).toThrow();
    const after = useSkill(s, { id: "refill", kind: "kaku" });
    expect(after.hands[0].kaku).toBe(4);
    expect(last(playMove(after, ...at("c1"), "fu")).skill).toEqual({ id: "refill", kind: "kaku" });
    // 金（5）も戻せる。戻すのは 1 つだけ
    const kin = useSkill(s, { id: "refill", kind: "kin" });
    expect(kin.hands[0].kin).toBe(1);
    // 使い切っていなくても、1 つでも減っていれば戻せる
    const one = full(game(base, ["refill", null], { hands: [{ fu: 10, yoko: 10, kaku: 4, kin: 2, hi: 2 }, {}] }));
    expect(refillKinds(one)).toEqual(["hi"]);
    // どれも減っていなければ戻せる駒がない
    const none = full(game(base, ["refill", null], { hands: [{ fu: 10, yoko: 10, kaku: 4, hi: 3, kin: 2 }, {}] }));
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
    const rules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 2 } });
    /** 後手が b1・h7 に置いて b1 を王にした（期限 2 手）局面。先手の手番。相手から見た王の候補は b1・h7 */
    function hidden(): GameState {
      let s = game({ a1: [0, "fu"], b1: [1, "fu"], h8: [0, "fu"], h7: [1, "fu"] }, ["scout", "wall"], { rules, kings: [null, "b1"] });
      // 後手が期限までの 2 手を打った棋譜（公開情報）
      const fake = (ply: number, [r, c]: [number, number]): MoveEvent => ({ type: "move", ply, player: 1, r, c, kind: "fu", targets: [], damage: 0, heal: 0 });
      s = { ...s, ply: 2, history: [fake(1, at("b1")), fake(2, at("h7"))] };
      return full(s);
    }
    it("相手の王を自分にだけ特定して見せる（相手の画面と棋譜には場所が出ない）", () => {
      const s = useSkill(hidden(), { id: "scout" });
      expect(viewFor(s, 0).oppKing).toEqual({ revealed: false, candidates: [[0, 1]], scouted: true });
      expect(viewFor(s, 1).oppKing.scouted).toBe(false);
      expect(kingInfo(s, 1).seen).toBe(true);
      expect(JSON.stringify(s.skills!.armed)).not.toContain("[0,1]");
      expect(last(play(s, "h6")).skill).toEqual({ id: "scout", scout: "find" });
    });
    it("偵察した手でその王を返すと罰が 2 倍（−60）", () => {
      const s = play(useSkill(hidden(), { id: "scout" }), "c1");
      expect(last(s).king).toMatchObject({ penalty: 60 });
      expect(s.hp[1]).toBe(130 - 1 - 60);
      // 偵察しない手なら −30
      expect(play(hidden(), "c1").hp[1]).toBe(130 - 1 - 30);
    });
    it("罰 2 倍は偵察した手番の後も、その王を返すまで続く（返したら終わる）", () => {
      let s = play(useSkill(hidden(), { id: "scout" }), "h6");
      expect(s.skills!.hunt).toEqual([true, false]);
      // 後手は置けずにパスし、次の先手の手番で王を返す
      expect(s.turn).toBe(0);
      expect(s.history.at(-1)).toMatchObject({ type: "pass", player: 1 });
      s = play(s, "c1");
      expect(last(s).king).toMatchObject({ penalty: 60 });
      expect(last(s).skill).toBeUndefined();
      expect(s.skills!.hunt).toBeUndefined();
    });
    it("2 回目以降（王が分かっている・返した後）は相手のゲージを半分にする（相手のゲージが空なら使えない）", () => {
      const withOpp = (s: GameState, g: number) => {
        const sides: SkillsState["sides"] = [s.skills!.sides[0], { ...s.skills!.sides[1], gauge: g }];
        return { ...s, skills: { ...s.skills!, sides } };
      };
      // 1 回目で王を特定した後の手番（場所を知っている）
      let s = play(useSkill(hidden(), { id: "scout" }), "h6");
      s = full(withOpp(s, 0), 0);
      expect(viewFor(s, 0).oppKing.scouted).toBe(true);
      expect(skillBlock(viewFor(s, 0))).toBe("noGauge");
      s = withOpp(s, 15 * GAUGE_UNIT + 1);
      const drained = useSkill(s, { id: "scout" });
      expect(drained.skills!.sides[1].gauge).toBe(Math.floor((15 * GAUGE_UNIT + 1) / 2));
      expect(drained.skills!.armed).toEqual({ id: "scout", scout: "drain", drained: 15 * GAUGE_UNIT + 1 - Math.floor((15 * GAUGE_UNIT + 1) / 2) });
      expect(drained.skills!.hunt).toEqual([true, false]);
      // 王を返した後も、相手のゲージを半分にする
      const hit = play(hidden(), "c1");
      const after = withOpp(full({ ...hit, turn: 0 }, 0), 10 * GAUGE_UNIT);
      expect(skillBlock(viewFor(after, 0))).toBeNull();
      expect(useSkill(after, { id: "scout" }).skills!.sides[1].gauge).toBe(5 * GAUGE_UNIT);
    });
    it("相手が期限の手まで打つ前は使えない", () => {
      const before = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["scout", null], { rules, kings: [null, "b1"] }));
      expect(skillBlock(viewFor(before, 0))).toBe("noTarget");
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
  it("補充は戻せる駒のうち読みが最もよくなる駒を戻す", () => {
    const s = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["refill", null], { hands: [{ fu: 3, yoko: 0, kaku: 0, kin: 0, hi: 0 }, {}] }));
    const use = chooseSkillUse(viewFor(s, 0), () => 0.5);
    expect(use?.id).toBe("refill");
    expect(refillKinds(s)).toContain(use!.kind);
    // 戻せる駒が 1 つなら、その駒
    const one = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["refill", null], { hands: [{ fu: 10, yoko: 10, kaku: 4, kin: 2, hi: 2 }, {}] }));
    expect(chooseSkillUse(viewFor(one, 0), () => 0.5)).toEqual({ id: "refill", kind: "hi" });
    // 金も戻せる駒に入る
    const kin = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["refill", null], { hands: [{ fu: 10, yoko: 10, kaku: 4, kin: 1, hi: 3 }, {}] }));
    expect(chooseSkillUse(viewFor(kin, 0), () => 0.5)).toEqual({ id: "refill", kind: "kin" });
  });
  it.each(SKILL_ORDER.flatMap((id) => (["easy", "normal", "hard"] as const).map((lv) => [id, lv] as const)))(
    "%s・%s: スキルを使いながら合法手だけで終局まで進む（ゲージは満タンを超えない）",
    (id, level) => {
      let seed = 7;
      const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      let s = setSkills(createGame(rulesOf("skill")), [id, SKILL_ORDER[(SKILL_ORDER.indexOf(id) + 3) % SKILL_ORDER.length]]);
      let uses = 0;
      const notes = (g: GameState) => g.history.filter((e) => e.type === "move" && e.skill).length;
      while (!s.result) {
        const p = s.turn;
        // 運命の輪で補充・王の移し替えが出たら、続けて指定する
        for (let k = 0; k < 2; k++) {
          const use = chooseSkillUse(viewFor(s, p), rng);
          if (!use) break;
          if (!s.skills!.armed?.aim) uses++;
          // 巻き戻しで戻した手に付いていたスキルは棋譜から消える
          const before = notes(s);
          s = useSkill(s, use, rng);
          uses -= before - notes(s);
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

describe("補充（作り直し）", () => {
  it("CPU 同士の対局で、満タンなのに戻せる駒がない手番はほぼ起きない", () => {
    let seed = 11;
    const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let fullTurns = 0;
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      let s = setSkills(createGame(rulesOf("skill")), i % 2 ? ["refill", "strong"] : ["strong", "refill"]);
      while (!s.result) {
        const p = s.turn;
        const side = s.skills!.sides[p];
        if (side.card === "refill" && side.gauge >= gaugeMax("refill")) {
          fullTurns++;
          if (skillBlock(viewFor(s, p)) === "noRefill") blocked++;
        }
        const use = chooseSkillUse(viewFor(s, p), rng);
        if (use) s = useSkill(s, use, rng);
        const ch = chooseMove(viewFor(s, p), "normal", rng)!;
        s = playMove(s, ch.r, ch.c, ch.kind, { king: ch.king });
      }
    }
    expect(fullTurns).toBeGreaterThan(0);
    expect(blocked / fullTurns).toBeLessThan(0.02);
  }, 30_000);
});

describe("連続行動", () => {
  // 1 手目 d8（2 枚）、2 手目 f1（4 枚）。後手は c4 で d4 を返せる
  const stones = {
    a8: [0, "fu"], b8: [1, "fu"], c8: [1, "fu"],
    a1: [0, "fu"], b1: [1, "fu"], c1: [1, "fu"], d1: [1, "fu"], e1: [1, "fu"],
    d4: [0, "fu"], e4: [1, "fu"],
  } as const;
  it("使うと 2 手続けて打てる。2 手目のダメージは半分（端数切り捨て）で、2 手目にはスキルを使えない", () => {
    let s = useSkill(full(game(stones, ["fool", null])), { id: "fool" });
    s = play(s, "d8");
    expect(last(s)).toMatchObject({ damage: 2, skill: { id: "fool" } });
    expect(last(s).second).toBeUndefined();
    expect(s.turn).toBe(0);
    expect(s.skills!.second).toBe(true);
    expect(skillBlock(viewFor(full(s, 0), 0))).toBe("used");
    expect(previewMove(s, ...at("f1"), "fu")).toMatchObject({ damage: 2, plain: 4, mods: ["second"] });
    s = play(s, "f1");
    expect(last(s)).toMatchObject({ damage: 2, plain: 4, second: true });
    expect(last(s).skill).toBeUndefined();
    expect(s.hp[1]).toBe(130 - 2 - 2);
    expect(s.turn).toBe(1);
    expect(s.skills!.second).toBeUndefined();
    // 2 手とも打った人のゲージに入る（2 枚 +2、4 枚 +7）
    expect(gauge(s, 0)).toBe(9);
  });
  it("1 手目で決着したら 2 手目はない", () => {
    const s = play(useSkill(full(game(stones, ["fool", null], { hp: [129, 2] })), { id: "fool" }), "d8");
    expect(s.result).toMatchObject({ winner: 0, reason: "ko" });
    expect(s.skills!.second).toBeUndefined();
  });
  it("2 手目に置ける手がなければ、ふつうに相手の番", () => {
    const s = play(useSkill(full(game({ a8: [0, "fu"], b8: [1, "fu"], h1: [1, "fu"], h2: [0, "fu"] }, ["fool", null])), { id: "fool" }), "c8");
    expect(s.turn).toBe(1);
    expect(s.skills!.second).toBeUndefined();
  });
  it("2 手目で王を返した罰は半分にしない", () => {
    const rules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 7 } });
    let s = full(game({ a8: [0, "fu"], b8: [1, "fu"], a1: [0, "fu"], b1: [1, "fu"], h4: [1, "fu"], h5: [0, "fu"] }, ["fool", null], { rules, kings: [null, "b1"] }));
    s = play(play(useSkill(s, { id: "fool" }), "c8"), "c1");
    expect(last(s)).toMatchObject({ second: true, damage: 0, plain: 1, king: { penalty: 30 } });
    expect(s.hp[1]).toBe(130 - 1 - 30);
  });
});

describe("運命の輪", () => {
  const base = { a1: [0, "fu"], b1: [1, "fu"], a8: [0, "fu"], b8: [1, "fu"], c8: [1, "fu"], d8: [1, "fu"] } as const;
  const kingRules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 7 } });
  const spin = (s: GameState, i: number) => useSkill(s, { id: "wheel" }, () => (i + 0.5) / 8);
  it("基本の 8 枚から等確率で 1 つを引く（隠し王なしのルールでは偵察・王の移し替えを除く 6 枚）", () => {
    const s = full(game(base, ["wheel", null], { rules: kingRules, hp: [100, 130] }));
    expect(BASE_SKILLS.map((_, i) => spin(s, i).skills!.armed!.effect)).toEqual([...BASE_SKILLS]);
    const plain = full(game(base, ["wheel", null], { hp: [100, 130] }));
    const drawn = new Set(Array.from({ length: 60 }, (_, i) => useSkill(plain, { id: "wheel" }, () => i / 60).skills!.armed!.effect));
    expect([...drawn].sort()).toEqual(["bigheal", "firstaid", "omni", "refill", "strong", "wall"]);
  });
  it("その場で使えない効果は不発（ゲージは 0 に戻り、置く手は打てる）", () => {
    // 体力が満タンで応急手当が出た
    const s = spin(full(game(base, ["wheel", null], { rules: kingRules })), 0);
    expect(s.skills!.armed).toEqual({ id: "wheel", effect: "firstaid", fizzle: true });
    expect(s.skills!.sides[0].gauge).toBe(0);
    expect(s.hp[0]).toBe(129);
    expect(skillBlock(viewFor(s, 0))).toBe("used");
    const after = play(s, "e8");
    expect(last(after).skill).toEqual({ id: "wheel", effect: "firstaid", fizzle: true });
    expect(last(after).damage).toBe(3);
  });
  it("引いた効果はそのカードと同じに効く（強打 ×1.5・大回復 +10）", () => {
    const strong = spin(full(game(base, ["wheel", null], { rules: kingRules })), 2);
    expect(previewMove(strong, ...at("e8"), "fu")).toMatchObject({ damage: 4, plain: 3, mods: ["strong"] });
    const heal = spin(full(game(base, ["wheel", null], { rules: kingRules, hp: [100, 130] })), 1);
    expect(heal.hp[0]).toBe(110);
    expect(heal.skills!.armed).toEqual({ id: "wheel", effect: "bigheal", heal: 10 });
  });
  it("補充が出たら戻す駒を続けて指定する（指定するまで置けない）", () => {
    let s = spin(full(game(base, ["wheel", null], { rules: kingRules, hands: [{ fu: 9, yoko: 10, kaku: 4, kin: 2, hi: 2 }, {}] })), 4);
    expect(s.skills!.armed).toEqual({ id: "wheel", effect: "refill", aim: true });
    expect(() => play(s, "e8")).toThrow();
    expect(() => useSkill(s, { id: "wheel", kind: "kin" })).toThrow();
    expect(() => useSkill(s, { id: "refill", kind: "hi" })).toThrow();
    s = useSkill(s, { id: "wheel", kind: "hi" });
    expect(s.hands[0].hi).toBe(3);
    expect(s.skills!.armed).toEqual({ id: "wheel", effect: "refill", kind: "hi" });
    expect(last(play(s, "e8")).skill).toEqual({ id: "wheel", effect: "refill", kind: "hi" });
  });
  it("王の移し替えが出たら移す先を指定する。相手から見た候補は使った時点の自分の駒", () => {
    let s = spin(full(game({ ...base, c1: [0, "fu"] }, ["wheel", null], { rules: kingRules, kings: ["a1", null] })), 7);
    expect(s.skills!.armed).toMatchObject({ effect: "kingmove", aim: true });
    s = useSkill(s, { id: "wheel", to: at("c1") });
    expect(kingInfo(s, 0).cell).toEqual(at("c1"));
    const after = play(s, "e8");
    expect(last(after).skill).toMatchObject({ id: "wheel", effect: "kingmove", cands: expect.any(Array) });
    expect(viewFor(after, 1).oppKing.candidates).toContainEqual(at("c1"));
    expect(JSON.stringify(last(after).skill)).not.toContain("[0,2]]");
  });
  it("指定を待つ間に時間切れなら、指定も自動で選んで打つ", () => {
    const s = spin(full(game(base, ["wheel", null], { rules: kingRules, hands: [{ fu: 9, yoko: 10, kaku: 4, kin: 2, hi: 3 }, {}] })), 4);
    const t = playTimeout(s, () => 0.3);
    expect(last(t)).toMatchObject({ timeout: true, skill: { id: "wheel", effect: "refill", kind: "fu" } });
  });
});

describe("巻き戻し", () => {
  // 先手 c8（1 枚）→ 後手 c1（b1 を返す）→ 先手の手番
  const stones = { a8: [0, "fu"], b8: [1, "fu"], a1: [1, "fu"], b1: [0, "fu"], h4: [1, "fu"], h5: [0, "fu"] } as const;
  const twoMoves = (opts: Parameters<typeof game>[2] = {}, king = false) => {
    const s0 = game(stones, ["judge", "strong"], opts);
    return { s0, s: playMove(play(s0, "c8"), ...at("c1"), "fu", { king }) };
  };
  it("自分の直前の手と相手の応手をまとめて戻す。自分のゲージは 0、相手のゲージは戻した局面のもの", () => {
    const { s0, s } = twoMoves();
    expect(s.turn).toBe(0);
    expect(gauge(s, 1)).toBeGreaterThan(0);
    const back = useSkill(full(s, 0), { id: "judge" });
    expect(back.board).toEqual(s0.board);
    expect(back.hp).toEqual(s0.hp);
    expect(back.history).toEqual(s0.history);
    expect(back.ply).toBe(0);
    expect(back.turn).toBe(0);
    expect(back.skills!.sides.map((x) => x.gauge)).toEqual([0, 0]);
    expect(back.skills!.armed).toEqual({ id: "judge", back: 2, redo: { r: 7, c: 2, kind: "fu" } });
    // 戻した局面から打ち直す。棋譜の手に巻き戻しの印
    const again = play(back, "c8");
    expect(last(again).skill).toEqual({ id: "judge", back: 2, redo: { r: 7, c: 2, kind: "fu" } });
  });
  it("まだ打っていない（戻す手がない）なら使えない", () => {
    const s = full(game(stones, ["judge", null]));
    expect(skillBlock(viewFor(s, 0))).toBe("noUndo");
    expect(() => useSkill(s, { id: "judge" })).toThrow();
    // 戻した直後も、次に自分が打つまでは戻せない
    const back = useSkill(full(twoMoves().s, 0), { id: "judge" });
    expect(viewFor(full({ ...back, skills: { ...back.skills!, armed: null } }, 0), 0).skills!.undoable).toEqual([false, false]);
  });
  it("終局した後は使えない（相手の応手で体力が 0 になった）", () => {
    const { s } = twoMoves({ hp: [1, 130] });
    expect(s.result).toMatchObject({ winner: 1 });
    expect(skillBlock(viewFor(full(s, 0), 0))).toBe("over");
  });
  it("戻す局面は相手に送らない（戻せるかだけを見せる）", () => {
    const { s } = twoMoves();
    expect(s.skills!.undo![0]).not.toBeNull();
    for (const p of [0, 1] as const) {
      expect(viewFor(s, p).skills!.undo).toBeUndefined();
      expect(JSON.stringify(viewFor(s, p))).not.toContain('"kings"');
      expect(viewFor(s, p).skills!.undoable).toEqual([true, false]);
    }
  });
  it("相手の王の指定は戻さない: 応手で指定した王は、相手が次に置く駒がそのまま王になる", () => {
    const rules = rulesOf("skill", { dirs: "all", anchor: "none", heal: "none", king: { on: true, penalty: "hp", amount: 30, deadline: 7 } });
    const { s } = twoMoves({ rules }, true);
    expect(kingInfo(s, 1).cell).toEqual(at("c1"));
    let back = useSkill(full(s, 0), { id: "judge" });
    expect(back.kings[1]).toEqual({ cell: null, auto: false, revealed: false, kept: true });
    // 先手から見た相手の王の情報には何も出ない
    expect(viewFor(back, 0).oppKing).toEqual({ revealed: false, candidates: [], scouted: false });
    back = play(back, "c8");
    expect(kingInfo(back, 1)).toMatchObject({ status: "unset", kept: true, canDesignate: true, forcedNow: true });
    // 王の指定をしなくても、次に置いた駒が王（自分で指定した扱い）
    back = play(back, "h6");
    expect(kingInfo(back, 1)).toMatchObject({ status: "hidden", cell: at("h6"), auto: false, kept: false });
  });
  it("戻せる手番の判定は CPU も同じ。相手の応手で 15 以上減ったら CPU は使い、同じ手を打ち直さない", () => {
    // 後手の応手 e1 で金 3 枚（15）を返す
    const big = {
      a8: [0, "fu"], b8: [1, "fu"],
      a1: [1, "fu"], b1: [0, "kin"], c1: [0, "kin"], d1: [0, "kin"],
      h4: [1, "fu"], h5: [0, "fu"],
    } as const;
    let s = play(game(big, ["judge", "strong"]), "c8");
    s = full(play(s, "e1"), 0);
    expect(s.hp[0]).toBe(129 - 15);
    expect(chooseSkillUse(viewFor(s, 0), () => 0.5)).toEqual({ id: "judge" });
    const back = useSkill(s, { id: "judge" });
    const ch = chooseMove(viewFor(back, 0), "normal", () => 0.5)!;
    expect([ch.r, ch.c]).not.toEqual(at("c8"));
    // 小さい応手（1）なら使わない
    const small = full(twoMoves().s, 0);
    expect(chooseSkillUse(viewFor(small, 0), () => 0.5)).toBeNull();
  });
});

describe("新しいカードの CPU", () => {
  it("運命の輪は満タンならいつも使い、補充が出たら戻す駒も選ぶ", () => {
    const s = full(game({ a1: [0, "fu"], b1: [1, "fu"] }, ["wheel", null], { hands: [{ fu: 9, yoko: 10, kaku: 4, kin: 2, hi: 3 }, {}] }));
    expect(chooseSkillUse(viewFor(s, 0), () => 0.5)).toEqual({ id: "wheel" });
    const aim = useSkill(s, { id: "wheel" }, () => 4.5 / 6);
    expect(aim.skills!.armed).toMatchObject({ effect: "refill", aim: true });
    expect(chooseSkillUse(viewFor(aim, 0), () => 0.5)).toEqual({ id: "wheel", kind: "fu" });
  });
  it("連続行動は 2 手の読みが使わないときより 6 以上よいときに使う", () => {
    // どちらの列も金 3 枚（15）。1 手目 15 ＋ 2 手目 7
    const stones = {
      a8: [0, "fu"], b8: [1, "kin"], c8: [1, "kin"], d8: [1, "kin"],
      a1: [0, "fu"], b1: [1, "kin"], c1: [1, "kin"], d1: [1, "kin"],
      h4: [1, "fu"], h5: [0, "fu"],
    } as const;
    expect(chooseSkillUse(viewFor(full(game(stones, ["fool", null])), 0), () => 0.5)).toEqual({ id: "fool" });
    expect(chooseSkillUse(viewFor(full(game({ a8: [0, "fu"], b8: [1, "fu"], h1: [1, "fu"], h2: [0, "fu"] }, ["fool", null])), 0), () => 0.5)).toBeNull();
  });
});
