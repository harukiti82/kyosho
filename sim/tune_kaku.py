# tako:run python3 sim/tune_kaku.py
"""攻め駒「角」（数値1・攻撃ボーナス付き）を足す案の比較"""
import random
import kyosho as k

BASE = {1: (1, 0), 2: (2, 0), 3: (3, 0), 5: (5, 0)}
VARIANTS = {
    "v0.4": k.Rules(damage="max", heal_minus=1, hp=65, second_bonus=1),
    "角3枚 +2": k.Rules(damage="max", heal_minus=1, hp=65, second_bonus=1,
                       hand={1: 11, 2: 10, 3: 6, 5: 2, "角": 3}, pieces={**BASE, "角": (1, 2)}),
    "角2枚 x2": k.Rules(damage="max", heal_minus=1, hp=65, second_bonus=1,
                       hand={1: 12, 2: 10, 3: 6, 5: 2, "角": 2}, pieces={**BASE, "角": (1, 0, 2)}),
    "角2枚 +3": k.Rules(damage="max", heal_minus=1, hp=65, second_bonus=1,
                       hand={1: 12, 2: 10, 3: 6, 5: 2, "角": 2}, pieces={**BASE, "角": (1, 3)}),
}

import sys
if len(sys.argv) > 1:
    VARIANTS = {kk: v for kk, v in VARIANTS.items() if kk.startswith(sys.argv[1])}
for name, rules in VARIANTS.items():
    random.seed(41)
    games = [k.play(rules, ("lookahead", "lookahead")) for _ in range(1500)]
    print(f"\n##### {name}")
    print("  ", {kk: tuple(round(x, 2) for x in v) for kk, v in k.per_phase(games).items()})
    for kind in [x for x in rules.hand if x in (5, "角")]:
        rows = [(ply, d) for g in games for (ply, _, d, _, _, v) in g.log if v == kind]
        plies = sorted(p for p, _ in rows)
        q = lambda f: plies[int(len(plies) * f)]
        print(f"  {kind}: 置いた手数 中央値 {q(.5)} (25%:{q(.25)} 75%:{q(.75)}) / その手の平均ダメージ {sum(d for _, d in rows)/len(rows):.2f}")
    for hp in (60, 65, 70):
        for bonus in (0, 1, 2):
            s = k.stats(rules, games, hp=hp, bonus=bonus)
            print(f"  体力{hp} 後手+{bonus}: KO {s['ko_rate']:5.1%} @{s['ko_ply']:.1f} / 先手 {s['first_win']:.1%}"
                  f" / 逆転 20手 {s['comeback20']:.1%} 40手 {s['comeback40']:.1%}")
    random.seed(43)
    print(f"  2手読み vs 駒だけランダム: {k.match(rules, 'lookahead', 'look_rp', 400):.1%}")
