# tako:run python3 sim/gate.py
"""挟将 v2 案（強い駒は弱い駒では裏返せない）の検証。

ルール:
1. オセロと同じく、相手の駒を挟んで裏返す（挟めないマスには置けない）
2. ただし、置いた駒より数字が大きい駒を含む列は裏返せない
3. 裏返した駒の数字の合計が相手へのダメージ（裏返った駒は数字そのままで自分の駒になる）
4. 体力 0 以下で負け。盤が埋まる / 両者パスで終局し、体力の多い方が勝ち
"""
from dataclasses import dataclass, field
import random
import sys

DIRS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class Rules:
    hand: dict = field(default_factory=lambda: {1: 20, 3: 8, 5: 4})
    hp: int = 40
    gate: bool = True  # False なら数字に関係なく裏返せる（比較用）


def new_board():
    b = [[None] * 8 for _ in range(8)]
    b[3][3] = (1, 1); b[4][4] = (1, 1)
    b[3][4] = (0, 1); b[4][3] = (0, 1)
    return b


def flips(rules, b, r, c, p, v):
    if b[r][c] is not None:
        return []
    out = []
    for dr, dc in DIRS:
        cells = []
        y, x = r + dr, c + dc
        while 0 <= y < 8 and 0 <= x < 8 and b[y][x] is not None and b[y][x][0] != p:
            cells.append((y, x))
            y += dr; x += dc
        if cells and 0 <= y < 8 and 0 <= x < 8 and b[y][x] is not None and b[y][x][0] == p:
            if not rules.gate or all(b[yy][xx][1] <= v for yy, xx in cells):
                out.extend(cells)
    return out


def pieces(hand):
    return [v for v, n in hand.items() if n > 0]


def moves(rules, b, hand, p):
    out = []
    for r in range(8):
        for c in range(8):
            if b[r][c] is None:
                for v in pieces(hand):
                    f = flips(rules, b, r, c, p, v)
                    if f:
                        out.append((r, c, v, f))
    return out


def apply(b, p, r, c, v, f):
    nb = [row[:] for row in b]
    nb[r][c] = (p, v)
    for y, x in f:
        nb[y][x] = (p, nb[y][x][1])
    return nb


def dmg_of(b, f):
    return sum(b[y][x][1] for y, x in f)


def bot_random(rules, b, hands, p, ms):
    return random.choice(ms)


def bot_othello(rules, b, hands, p, ms):
    """オセロ流: 裏返す枚数が最大の手（駒は数字の小さいもの）"""
    m = max(len(f) for *_, f in ms)
    c = [x for x in ms if len(x[3]) == m]
    lo = min(x[2] for x in c)
    return random.choice([x for x in c if x[2] == lo])


def bot_greedy(rules, b, hands, p, ms):
    best = max(dmg_of(b, x[3]) for x in ms)
    return random.choice([x for x in ms if dmg_of(b, x[3]) == best])


def bot_lookahead(rules, b, hands, p, ms):
    """2手読み: 自分のダメージ − 相手の最善応手のダメージ"""
    q = p ^ 1
    best, cands = None, []
    for m in ms:
        r, c, v, f = m
        d = dmg_of(b, f)
        nb = apply(b, p, r, c, v, f)
        nh = dict(hands[p]); nh[v] -= 1
        reply = 0
        for r2, c2, v2, f2 in moves(rules, nb, hands[q], q):
            reply = max(reply, dmg_of(nb, f2))
        s = d - reply
        if best is None or s > best:
            best, cands = s, [m]
        elif s == best:
            cands.append(m)
    return random.choice(cands)


def bot_look_rp(rules, b, hands, p, ms):
    """駒の種類を先にランダムで決め、その駒で置ける手から 2 手読み（駒選びの価値を測る対照）"""
    kinds = sorted({x[2] for x in ms})
    v = random.choice(kinds)
    return bot_lookahead(rules, b, hands, p, [x for x in ms if x[2] == v])


BOTS = {"random": bot_random, "othello": bot_othello, "greedy": bot_greedy,
        "lookahead": bot_lookahead, "look_rp": bot_look_rp}


def play(rules, bots, track_othello=False):
    b = new_board()
    hands = [dict(rules.hand), dict(rules.hand)]
    hp = [0, 0]
    traj, log = [], []
    p, passes, ply = 0, 0, 0
    same = total = 0
    while passes < 2:
        ms = moves(rules, b, hands[p], p)
        if not ms:
            passes += 1
            p ^= 1
            continue
        passes = 0
        m = BOTS[bots[p]](rules, b, hands, p, ms)
        if track_othello:
            mx = max(len(x[3]) for x in ms)
            total += 1
            same += (len(m[3]) == mx)
        r, c, v, f = m
        d = dmg_of(b, f)
        b = apply(b, p, r, c, v, f)
        hands[p][v] -= 1
        hp[p ^ 1] -= d
        ply += 1
        traj.append((ply, hp[0], hp[1]))
        log.append((ply, p, v, d, len(f)))
        p ^= 1
    return traj, log, (same / total if total else 0)


def outcome(traj, hp):
    for ply, a, b in traj:
        if hp + a <= 0:
            return 1, ply
        if hp + b <= 0:
            return 0, ply
    _, a, b = traj[-1]
    if a == b:
        return -1, None
    return (0 if a > b else 1), None


def report(name, rules, n, hps):
    random.seed(13)
    games = [play(rules, ("lookahead", "lookahead"), track_othello=True) for _ in range(n)]
    same = sum(g[2] for g in games) / n
    print(f"\n##### {name}")
    print(f"  2手読みの手が『最多返し』と一致する率: {same:.1%}（低いほどオセロと違う判断）")
    for ph, lo, hi in [("1-20手", 1, 20), ("21-40手", 21, 40), ("41手-", 41, 99)]:
        rows = [(d, nf) for _, log, _ in games for (ply, _, _, d, nf) in log if lo <= ply <= hi]
        if rows:
            print(f"  {ph}: 1手平均ダメージ {sum(r[0] for r in rows)/len(rows):.2f} / 返し枚数 {sum(r[1] for r in rows)/len(rows):.2f}")
    v5 = [ply for _, log, _ in games for (ply, _, v, _, _) in log if v == max(rules.hand)]
    if v5:
        print(f"  最強駒を置いた手数 中央値 {sorted(v5)[len(v5)//2]}")
    for hp in hps:
        res = [outcome(t, hp) for t, _, _ in games]
        kos = [k for _, k in res if k]
        first = sum((w == 0) + 0.5 * (w == -1) for w, _ in res) / n
        ko_ply = sum(kos) / len(kos) if kos else float("nan")
        cb = []
        for (t, _, _), (w, ko) in zip(games, res):
            if len(t) >= 20 and not (ko and ko <= 20):
                _, a, b = t[19]
                if a != b:
                    cb.append(w != (0 if a > b else 1))
        print(f"  体力{hp:>3}: KO {len(kos)/n:5.1%} @{ko_ply:5.1f}手 / 先手勝率 {first:5.1%} / 20手目リードの逆転率 {sum(cb)/max(1,len(cb)):.1%}")
    return games


def match(rules, a, b, n):
    win = 0
    for i in range(n):
        bots = (a, b) if i % 2 == 0 else (b, a)
        t, _, _ = play(rules, bots)
        w, _ = outcome(t, rules.hp)
        me = 0 if i % 2 == 0 else 1
        win += (w == me) + 0.5 * (w == -1)
    return win / n


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    report("比較: 数字の制限なし（返した数字の合計がダメージ）", Rules(gate=False), n, hps=(40, 60, 80))
    rules = Rules()
    report("v2 案: 置いた駒より強い駒は返せない", rules, n, hps=(30, 40, 50, 60))
    random.seed(17)
    print(f"  2手読み vs オセロ流（最多返し）: {match(rules, 'lookahead', 'othello', 200):.1%}")
    print(f"  2手読み vs 駒だけランダム: {match(rules, 'lookahead', 'look_rp', 200):.1%}")
