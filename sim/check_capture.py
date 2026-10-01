# tako:run python3 sim/check_capture.py
"""v1 案（取った駒が持ち駒になる）の詳細確認"""
import random, sys
import capture as k

N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
rules = k.Rules(hp=20)

def bot_look_rp(b, hands, p):
    """2手読みでマスを選び、駒はランダム（駒選びの価値を測る対照）"""
    v = random.choice(k.pieces(hands[p]))
    only = {x: (n if x == v else 0) for x, n in hands[p].items()}
    hh = [only, hands[1]] if p == 0 else [hands[0], only]
    return k.bot_lookahead(b, hh, p)
k.BOTS["look_rp"] = bot_look_rp

random.seed(9)
games = [k.play(rules, ("lookahead", "lookahead")) for _ in range(N)]
k.summarize("lookahead 体力20", rules, games, hps=(18, 20, 22), bonuses=(-2, -1, 0))
# 取られた駒の内訳（1局あたり）
from collections import Counter
cnt = Counter()
for _, log in games:
    pass
# 再現のため飛の取られ回数は play を再実行せず、ダメージ5以上の手で近似
big = sum(1 for _, log in games for (_, _, _, d) in log if d >= 5) / N
v5 = [ply for _, log in games for (ply, _, v, _) in log if v == 5]
print(f"  ダメージ5以上の手: 1局 {big:.2f} 回 / 飛を置いた手数 中央値 {sorted(v5)[len(v5)//2]} / 1局で飛を置いた回数 {len(v5)/N:.2f}")
# 体力リーダーの逆転率（20手・40手時点）
for Nply in (20, 40):
    lost = tot = 0
    for t, _ in games:
        w, ko = k.outcome(t, 20)
        if len(t) < Nply or (ko and ko <= Nply): continue
        _, a, b = t[Nply-1]
        if a == b: continue
        tot += 1; lost += (w != (0 if a > b else 1))
    print(f"  {Nply}手目のリーダーが逆転される率: {lost/tot:.1%}")

def match(a, b, n):
    win = 0
    for i in range(n):
        bots = (a, b) if i % 2 == 0 else (b, a)
        t, _ = k.play(rules, bots)
        w, _ = k.outcome(t, rules.hp)
        me = 0 if i % 2 == 0 else 1
        win += (w == me) + 0.5 * (w == -1)
    return win / n
random.seed(10)
print(f"  2手読み vs 貪欲: {match('lookahead','greedy',200):.1%}")
print(f"  2手読み vs 駒だけランダム: {match('lookahead','look_rp',200):.1%}")
