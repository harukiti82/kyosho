// スキル練習（ui/skilllessons.ts）の局面と判定: 11 枚それぞれを画面と同じ手順（名札のカードを使う → 指定 → 光っているマスに置く →
// 連続行動の 2 手目・鉄壁の相手の応手）でエンジンに打たせ、効き目がエンジンの結果どおりに文になること、違う操作でヒントが出ること、
// 隠し情報が相手の視点に漏れないこと、進み具合の保存が壊れていても始められること。

import { describe, expect, it } from "vitest";
import { parseCell } from "../src/engine/board";
import {
  kingInfo,
  kingMoveCells,
  lastMoveOf,
  legalCells,
  playMove,
  refillKinds,
  skillBlock,
  threatenedPieces,
  useSkill,
  viewFor,
  wheelPool,
  type GameState,
} from "../src/engine/game";
import { SKILL_ORDER, SKILLS, type SkillUse } from "../src/engine/skills";
import type { KeyValueStore } from "../src/net/online";
import { judgeMove, judgeUse, nextNeed, type Lesson } from "../src/ui/lessons";
import {
  loadSkillDone,
  saveSkillDone,
  SCOUT_LESSON,
  SKILL_LESSONS,
  SKILL_TUTORIAL_KEY,
  skillLessonIndex,
  skillProgressLabel,
  wheelRng,
} from "../src/ui/skilllessons";
import { TUTORIAL_KEY } from "../src/ui/lessons";

const byId = (id: string) => SKILL_LESSONS.find((l) => l.id === id)!;

/** 画面と同じ手順で 1 枚のステップを最後まで打つ。各段階の局面を返す */
function play(l: Lesson) {
  const start = l.start();
  const card = start.skills!.sides[0].card!;
  const rng = l.wheel ? wheelRng(wheelPool(start.rules), l.wheel) : undefined;
  // 補充・王の移し替えは指定を添えて使う。運命の輪は使ってから、出た効果の指定を続けて送る
  const aim: Partial<SkillUse> = card === "refill" || card === "kingmove" ? { ...l.aim } : {};
  let used = useSkill(start, { id: card, ...aim }, rng);
  if (used.skills!.armed?.aim) used = useSkill(used, { id: card, ...l.aim });
  const a = l.answers[0];
  expect(judgeMove(l, used, { r: a.at[0], c: a.at[1], kind: a.kind, king: false, skill: true }), l.id).toBeNull();
  let before: GameState = used;
  let after = playMove(used, a.at[0], a.at[1], a.kind);
  if (l.then) {
    const b = l.then.answers[0];
    const staged = { ...l, ...l.then };
    expect(judgeMove(staged, after, { r: b.at[0], c: b.at[1], kind: b.kind, king: false }), l.id).toBeNull();
    before = after;
    after = playMove(after, b.at[0], b.at[1], b.kind);
  }
  if (l.reply) {
    before = after;
    after = playMove(after, l.reply.at[0], l.reply.at[1], l.reply.kind);
  }
  const m = lastMoveOf(after)!;
  return { start, used, before, after, m, text: l.done(m, before, after) };
}

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe("スキル練習: 11 枚の局面", () => {
  it("11 枚が SKILL_ORDER の順に 1 ステップずつあり、どれも満タンの自分のカードから始まる", () => {
    expect(SKILL_LESSONS.map((l) => l.id)).toEqual(SKILL_ORDER);
    for (const l of SKILL_LESSONS) {
      const g = l.start();
      const card = g.skills!.sides[0].card!;
      expect(card, l.id).toBe(l.id);
      expect(g.turn, l.id).toBe(0);
      expect(g.result, l.id).toBeNull();
      expect(g.skills!.ready, l.id).toBe(true);
      // 練習の始めから使える（使えない理由がない）
      expect(skillBlock(viewFor(g, 0)), l.id).toBeNull();
      expect(l.title, l.id).toBe(SKILLS[card].name);
      expect(skillLessonIndex(card)).toBe(SKILL_ORDER.indexOf(card));
    }
  });

  it("偵察はスキル練習の中にある", () => {
    expect(SKILL_LESSONS).toContain(SCOUT_LESSON);
  });

  it("どのカードも使ってから置く。使う前はどのマスでも先に使うよう知らせ、名札を光らせる", () => {
    for (const l of SKILL_LESSONS) {
      const g = l.start();
      const a = l.answers[0];
      expect(a.skill, l.id).toBe(true);
      expect(judgeMove(l, g, { r: a.at[0], c: a.at[1], kind: a.kind, king: false }), l.id).toBe(`先に名札の${SKILLS[l.id as keyof typeof SKILLS].name}を押して使う`);
      expect(nextNeed(l, a.kind, false), l.id).toEqual({ skill: true });
    }
  });

  it("正解の後も終局しない（終局すると相手の王・副将が画面に出る）。! が出るのは見せたい鉄壁と王の移し替えだけ", () => {
    for (const l of SKILL_LESSONS) expect(play(l).after.result, l.id).toBeNull();
    for (const l of SKILL_LESSONS.filter((x) => !["wall", "kingmove", "scout"].includes(x.id))) {
      expect(threatenedPieces(l.start(), 0), l.id).toEqual([]);
    }
    expect(threatenedPieces(byId("wall").start(), 0)).toEqual([parseCell("b7")]);
    expect(threatenedPieces(byId("kingmove").start(), 0)).toEqual([parseCell("b7")]);
  });
});

describe("スキル練習: 効き目と文", () => {
  it("応急手当・大回復: 体力 100 から回復した分が文に出る", () => {
    const a = play(byId("firstaid"));
    expect(a.used.hp[0]).toBe(104);
    expect(a.text).toBe("応急手当で体力が 4 回復して 104 になった。ゲージは 0 に戻り、また溜めると使える。");
    const b = play(byId("bigheal"));
    expect(b.used.hp[0]).toBe(120);
    expect(b.text).toBe("大回復で体力が 20 回復して 120 になった。ゲージは 0 に戻り、また溜めると使える。");
  });

  it("強打: ダメージが 1.5 倍", () => {
    const { m, text } = play(byId("strong"));
    expect(m.plain).toBe(7);
    expect(m.damage).toBe(10);
    expect(text).toBe("強打で、ダメージ 7 が 1.5 倍の 10 になった。");
  });

  it("全方向: 使う前は歩で横に挟めず、使うと挟める", () => {
    const l = byId("omni");
    const g = l.start();
    const at = parseCell("d4");
    expect(legalCells(g, "fu").some(([r, c]) => r === at[0] && c === at[1])).toBe(false);
    const { m, text } = play(l);
    expect(m.targets).toHaveLength(2);
    expect(text).toBe("全方向で、縦にしか挟めない歩が横の金5と歩1を挟んで、7 のダメージ。");
  });

  it("補充: 戻せる駒は歩と金で、指定を選ぶ。金でない指定はヒント", () => {
    const l = byId("refill");
    const g = l.start();
    expect(refillKinds(g)).toEqual(["fu", "kin"]);
    expect(judgeUse(l, { id: "refill", kind: "fu" })).toBe("この練習では金を戻す");
    expect(judgeUse(l, { id: "refill", kind: "kin" })).toBeNull();
    const { used, text } = play(l);
    expect(used.hands[0].kin).toBe(1);
    expect(text).toBe("補充で金5が駒台に戻り、そのまま置いて斜めの歩1を裏返した。");
  });

  it("鉄壁: 相手の決めた応手のダメージが半分になる", () => {
    const { m, text } = play(byId("wall"));
    expect(m.player).toBe(1);
    expect(m.shielded).toBe(true);
    expect(m.plain).toBe(6);
    expect(m.damage).toBe(3);
    expect(text).toBe("相手が金5を裏返したが、鉄壁でダメージ 6 が半分の 3 になった。駒は裏返される。");
  });

  it("偵察: 使うと相手の王だけが候補になる。相手の視点には自分の偵察で知ったことは出ない", () => {
    const { used, text, m } = play(SCOUT_LESSON);
    expect(viewFor(used, 0).oppKing).toMatchObject({ scouted: true, candidates: [parseCell("d3")] });
    expect(viewFor(used, 1).myKing.seen).toBe(true);
    expect(m.king?.penalty).toBe(30);
    expect(text).toContain("偵察で見えた相手の王を裏返した");
  });

  it("王の移し替え: 移せるのは光っている駒だけ。移した先は相手の視点に出ない", () => {
    const l = byId("kingmove");
    const g = l.start();
    expect(kingMoveCells(viewFor(g, 0))).toEqual([parseCell("d8")]);
    expect(judgeUse(l, { id: "kingmove", to: parseCell("a8") })).toBe("光っている駒へ王を移す");
    expect(judgeUse(l, { id: "kingmove", to: parseCell("d8") })).toBeNull();
    const { used, after, text } = play(l);
    expect(kingInfo(used, 0).cell).toEqual(parseCell("d8"));
    // 移した後は王に ! が付かない
    expect(threatenedPieces(used, 0)).toEqual([parseCell("b7")]);
    const opp = viewFor(after, 1);
    expect(JSON.stringify(opp)).not.toContain('"cell":[7,3]');
    expect(opp.oppKing.candidates.length).toBeGreaterThan(1);
    expect(text).toBe("王を右の歩1へ移したので、赤い ! が消えた。相手には使ったことだけが分かり、どこへ移したかは見えない。");
  });

  it("連続行動: 1 手目の後も自分の手番で、2 手目のダメージは半分", () => {
    const l = byId("fool");
    const start = l.start();
    const used = useSkill(start, { id: "fool" });
    const a = l.answers[0];
    const mid = playMove(used, a.at[0], a.at[1], a.kind);
    expect(mid.turn).toBe(0);
    expect(mid.skills!.second).toBe(true);
    // 2 手目の段では、もう使わずに置く
    const b = l.then!.answers[0];
    expect(judgeMove({ ...l, ...l.then! }, mid, { r: a.at[0], c: a.at[1], kind: "fu", king: false })).toBe("2 手目も打てる。光っているマスに歩を置く");
    const { m, text } = play(l);
    expect(m.second).toBe(true);
    expect([m.r, m.c]).toEqual(b.at);
    expect(text).toBe("連続行動で 2 手続けて打った。1 手目は 7、2 手目は 6 の半分の 3 のダメージ。");
  });

  it("運命の輪: 練習では補充が出て、続けて戻す駒を指定する", () => {
    const l = byId("wheel");
    const g = l.start();
    const pool = wheelPool(g.rules);
    expect(pool).toHaveLength(10);
    const used = useSkill(g, { id: "wheel" }, wheelRng(pool, "refill"));
    expect(used.skills!.armed).toMatchObject({ id: "wheel", effect: "refill", aim: true });
    expect(() => wheelRng(pool, "wheel")).toThrow();
    const { text } = play(l);
    expect(text).toBe("運命の輪で補充が出て、金5を駒台に戻した。出た効果は、そのカードを使ったときと同じに効く。");
  });

  it("巻き戻し: 始めは自分の手と相手の応手を打った局面で、使うと 2 手戻って体力も戻る", () => {
    const l = byId("judge");
    const g = l.start();
    expect(g.ply).toBe(2);
    expect(g.hp[0]).toBe(g.rules.hp[0] - 8);
    const { used, text } = play(l);
    expect(used.ply).toBe(0);
    expect(used.hp[0]).toBe(g.rules.hp[0]);
    // 挟み返された手を打ち直そうとしたらヒント
    expect(judgeMove(l, used, { r: 4, c: 2, kind: "fu", king: false, skill: true })).toBe("そこはさっき挟み返された手。光っているマスに置く");
    expect(text).toBe(`巻き戻しで 2 手戻り、相手に減らされた体力も ${g.rules.hp[0]} に戻った。打ち直した手は 2 のダメージ。`);
  });
});

describe("スキル練習: 進み具合の保存", () => {
  it("保存がない・壊れている・形が違う・版が違うときは 1 枚も終えていない", () => {
    expect(loadSkillDone(memStore())).toEqual([]);
    for (const raw of ["{", "null", "[]", '"x"', '{"v":1}', '{"v":1,"done":"strong"}', '{"v":2,"done":["strong"]}', '{"done":["strong"]}']) {
      expect(loadSkillDone(memStore({ [SKILL_TUTORIAL_KEY]: raw })), raw).toEqual([]);
    }
  });

  it("知らない id・重なりは捨て、SKILL_ORDER の順で読む", () => {
    const store = memStore({ [SKILL_TUTORIAL_KEY]: JSON.stringify({ v: 1, done: ["judge", "x", 3, "strong", "judge"] }) });
    expect(loadSkillDone(store)).toEqual(["strong", "judge"]);
  });

  it("保存して読み直せる。メインの遊び方の保存には触らない", () => {
    const store = memStore({ [TUTORIAL_KEY]: "keep" });
    saveSkillDone(store, ["wheel", "firstaid", "wheel"]);
    expect(loadSkillDone(store)).toEqual(["firstaid", "wheel"]);
    expect(store.data[TUTORIAL_KEY]).toBe("keep");
  });

  it("メニューに添える状態", () => {
    expect(skillProgressLabel([])).toBe("11 枚");
    expect(skillProgressLabel(["strong", "wall"])).toBe("2/11");
    expect(skillProgressLabel(SKILL_ORDER)).toBe("クリア済み");
  });
});
