# tako:run python3 sim/compare.py
"""ルール案を並べて比較する。2手読みボット同士の自己対戦が基準。"""
import random
import sys

import kyosho as k

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1000

VARIANTS = {
    "案C 最大値 / 回復-1": k.Rules(damage="max", heal_minus=1),
    "案D 平均 / 回復そのまま": k.Rules(damage="avg"),
    "案E 平均 / 回復-1": k.Rules(damage="avg", heal_minus=1),
}
if len(sys.argv) > 2:
    VARIANTS = {key: v for key, v in VARIANTS.items() if key.startswith(sys.argv[2])}


def report(name, rules):
    random.seed(7)
    games = [k.play(rules, ("lookahead", "lookahead")) for _ in range(N)]
    print(f"\n##### {name}")
    for ph, (d, h) in k.per_phase(games).items():
        print(f"  {ph}: 攻撃 {d:.2f} / 回復 {h:.2f}")
    # 飛を置いた手数の平均（強い駒をいつ切るか）
    hi = max(rules.hand, key=lambda x: rules.pieces[x][0])
    plies = [ply for g in games for (ply, _, _, _, _, v) in g.log if v == hi]
    print(f"  最強駒を置いた平均手数: {sum(plies)/len(plies):.1f}")
    print("  体力 | KO率  | KO手数 | 先手勝率 | 逆転率20手 | 逆転率40手")
    for hp in (20, 30, 40, 50, 60):
        s = k.stats(rules, games, hp=hp)
        print(f"  {hp:>4} | {s['ko_rate']:5.1%} | {s['ko_ply']:6.1f} | {s['first_win']:7.1%}"
              f" | {s['comeback20']:9.1%} | {s['comeback40']:9.1%}")


for name, rules in VARIANTS.items():
    report(name, rules)
