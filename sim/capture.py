# tako:run python3 sim/capture.py
"""挟将 v1 案（取った駒が持ち駒になる）のルールエンジンと検証ボット。

ルール:
1. 持ち駒を空きマスに置く（挟めなくても置ける）
2. 置いた駒と自分の駒で一直線に挟んだ相手の駒は盤から取り、自分の持ち駒にする
3. 取った駒の数字の合計が相手へのダメージ
4. 体力 0 以下で負け。手数上限に達したら体力の多い方の勝ち（同じなら引き分け）
挟まれる位置へ自分から置いても取られない（取るのは置いた側だけ）。
"""
from dataclasses import dataclass, field
import random
import sys

DIRS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class Rules:
    hand: dict = field(default_factory=lambda: {1: 8, 3: 4, 5: 2})  # 数字 -> 個数
    hp: int = 20
    max_plies: int = 80
    second_bonus: int = 0


def new_board():
    b = [[None] * 8 for _ in range(8)]
    b[3][3] = (1, 1); b[4][4] = (1, 1)
    b[3][4] = (0, 1); b[4][3] = (0, 1)
    return b


def captures(b, r, c, p):
    """(r, c) に p が置いたときに取れるマスのリスト"""
    out = []
    for dr, dc in DIRS:
        cells = []
        y, x = r + dr, c + dc
        while 0 <= y < 8 and 0 <= x < 8 and b[y][x] is not None and b[y][x][0] != p:
            cells.append((y, x))
            y += dr; x += dc
        if cells and 0 <= y < 8 and 0 <= x < 8 and b[y][x] is not None and b[y][x][0] == p:
            out.extend(cells)
    return out


def empties(b):
    return [(r, c) for r in range(8) for c in range(8) if b[r][c] is None]


def pieces(hand):
    return [v for v, n in hand.items() if n > 0]


def best_capture(b, p):
    """p が次の 1 手で与えられる最大ダメージ（置く駒の種類はダメージに無関係）"""
    best = 0
    for r, c in empties(b):
        cap = captures(b, r, c, p)
        if cap:
            best = max(best, sum(b[y][x][1] for y, x in cap))
    return best


def apply(b, hands, p, r, c, v):
    """着手して (新盤面, 新持ち駒, ダメージ) を返す"""
    nb = [row[:] for row in b]
    nh = [dict(hands[0]), dict(hands[1])]
    cap = captures(nb, r, c, p)
    nb[r][c] = (p, v)
    nh[p][v] -= 1
    dmg = 0
    for y, x in cap:
        val = nb[y][x][1]
        dmg += val
        nh[p][val] = nh[p].get(val, 0) + 1
        nb[y][x] = None
    return nb, nh, dmg


# ---- ボット ----

def bot_random(b, hands, p):
    r, c = random.choice(empties(b))
    return r, c, random.choice(pieces(hands[p]))


def bot_greedy(b, hands, p):
    """取れる量が最大の手。駒は数字の小さいもの（取られたときの損を小さく）"""
    best, cands = -1, []
    for r, c in empties(b):
        d = sum(b[y][x][1] for y, x in captures(b, r, c, p))
        if d > best:
            best, cands = d, [(r, c)]
        elif d == best:
            cands.append((r, c))
    r, c = random.choice(cands)
    return r, c, min(pieces(hands[p]))


def bot_lookahead(b, hands, p):
    """2手読み: 自分のダメージ − 相手の最善応手のダメージ。同点はランダム"""
    q = p ^ 1
    best, cands = None, []
    for r, c in empties(b):
        for v in pieces(hands[p]):
            nb, nh, d = apply(b, hands, p, r, c, v)
            reply = best_capture(nb, q) if pieces(nh[q]) else 0
            s = d - reply
            if best is None or s > best:
                best, cands = s, [(r, c, v)]
            elif s == best:
                cands.append((r, c, v))
    return random.choice(cands)


BOTS = {"random": bot_random, "greedy": bot_greedy, "lookahead": bot_lookahead}


def play(rules, bots):
    b = new_board()
    hands = [dict(rules.hand), dict(rules.hand)]
    hp = [0, 0]  # 初期体力からの増減（体力無制限で記録し、勝敗は後で判定）
    traj, log = [], []
    p, ply, passes = 0, 0, 0
    while ply < rules.max_plies and passes < 2:
        if not pieces(hands[p]) or not empties(b):
            passes += 1
            p ^= 1
            continue
        passes = 0
        r, c, v = BOTS[bots[p]](b, hands, p)
        b, hands, d = apply(b, hands, p, r, c, v)
        hp[p ^ 1] -= d
        ply += 1
        traj.append((ply, hp[0], hp[1]))
        log.append((ply, p, v, d))
        p ^= 1
    return traj, log


def outcome(traj, hp, bonus=0):
    h0, h1 = hp, hp + bonus
    for ply, a, b in traj:
        if h0 + a <= 0:
            return 1, ply
        if h1 + b <= 0:
            return 0, ply
    if not traj:
        return -1, None
    _, a, b = traj[-1]
    if h0 + a == h1 + b:
        return -1, None
    return (0 if h0 + a > h1 + b else 1), None


def summarize(name, rules, games, hps, bonuses=(0,)):
    print(f"\n##### {name}")
    # 何手目まで 1 回も取りが起きないか / 1 手あたりダメージの分布
    first_cap = []
    for _, log in games:
        k = next((ply for ply, _, _, d in log if d > 0), None)
        first_cap.append(k if k is not None else 999)
    first_cap.sort()
    dmgs = [d for _, log in games for (_, _, _, d) in log]
    nz = [d for d in dmgs if d > 0]
    print(f"  最初の取りの手数 中央値 {first_cap[len(first_cap)//2]} / 取りが起きた手の割合 {len(nz)/len(dmgs):.1%}"
          f" / 取りの平均ダメージ {sum(nz)/max(1,len(nz)):.2f}")
    for name2, lo, hi in [("1-20手", 1, 20), ("21-40手", 21, 40), ("41手-", 41, 999)]:
        rows = [d for _, log in games for (ply, _, _, d) in log if lo <= ply <= hi]
        if rows:
            print(f"  {name2}: 1手平均ダメージ {sum(rows)/len(rows):.2f}")
    for hp in hps:
        for bonus in bonuses:
            res = [outcome(t, hp, bonus) for t, _ in games]
            n = len(res)
            kos = [k for _, k in res if k is not None]
            first = sum((w == 0) + 0.5 * (w == -1) for w, _ in res) / n
            draw = sum(w == -1 for w, _ in res) / n
            ko_ply = sum(kos) / len(kos) if kos else float("nan")
            print(f"  体力{hp:>3} 後手+{bonus}: KO {len(kos)/n:5.1%} @{ko_ply:5.1f}手 / 先手勝率 {first:5.1%} / 引分 {draw:4.1%}")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    rules = Rules()
    for bots in [("random", "random"), ("greedy", "greedy"), ("lookahead", "lookahead")]:
        random.seed(5)
        games = [play(rules, bots) for _ in range(n)]
        summarize(f"{bots[0]} 同士", rules, games, hps=(20, 30, 40, 60))
