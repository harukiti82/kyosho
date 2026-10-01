# tako:run python3 sim/tune_c.py
"""案C の体力・後手ボーナスの調整と、腕前・駒選びの効き具合の確認"""
import random
import kyosho as k

rules = k.Rules(damage="max", heal_minus=1)
random.seed(11)
games = [k.play(rules, ("lookahead", "lookahead")) for _ in range(1500)]
print("体力 後手+ | KO率  | KO手数 | 先手勝率 | 逆転率20手 | 逆転率40手")
for hp in (60, 65, 70):
    for bonus in (0, 3, 5, 8):
        s = k.stats(rules, games, hp=hp, bonus=bonus)
        print(f"{hp:>4} {bonus:>4} | {s['ko_rate']:5.1%} | {s['ko_ply']:6.1f} | {s['first_win']:7.1%}"
              f" | {s['comeback20']:9.1%} | {s['comeback40']:9.1%}")
