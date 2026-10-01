# tako:run python3 sim/check_c.py
"""案C（体力65）の最終確認: 後手ボーナス微調整・腕前の差・駒選びの効き"""
import random
import kyosho as k

rules = k.Rules(damage="max", heal_minus=1, hp=65)
random.seed(23)
games = [k.play(rules, ("lookahead", "lookahead")) for _ in range(3000)]
for bonus in (0, 1, 2):
    s = k.stats(rules, games, bonus=bonus)
    print(f"後手+{bonus}: KO {s['ko_rate']:.1%} @{s['ko_ply']:.1f}手 / 先手勝率 {s['first_win']:.1%}"
          f" / 逆転率 20手 {s['comeback20']:.1%} 40手 {s['comeback40']:.1%}")
print("per phase:", {kk: tuple(round(x, 2) for x in v) for kk, v in k.per_phase(games).items()})
rules.second_bonus = 1
random.seed(29)
print(f"2手読み vs 貪欲        : {k.match(rules, 'lookahead', 'greedy', 600):.1%}")
print(f"貪欲 vs ランダム        : {k.match(rules, 'greedy', 'random', 600):.1%}")
print(f"2手読み vs 駒だけランダム: {k.match(rules, 'lookahead', 'look_rp', 600):.1%}")
