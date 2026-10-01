# tako:run python3 sim/kyosho.py
"""挟将のルールエンジンとバランス検証用ボット。

ルールは Rules で切り替える。体力はゲーム中のボットの判断に使わないため、
体力無制限で軌跡を記録し、初期体力ごとの勝敗は outcome() で後から判定する。
"""
from dataclasses import dataclass, field
import random

DIRS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class Rules:
    hand: dict = field(default_factory=lambda: {1: 14, 2: 10, 3: 6, 5: 2})
    # 駒種 -> (盤上の数値, 攻撃ボーナス[, 最大値の倍率])。hand のキーはここのキー
    pieces: dict = field(default_factory=lambda: {1: (1, 0), 2: (2, 0), 3: (3, 0), 5: (5, 0)})
    # "max": 返した駒の最大値 / "capped": min(置いた駒, 返した駒の最大値)
    # "avg": (置いた駒 + 返した駒の最大値) // 2
    damage: str = "max"
    heal_minus: int = 0  # 回復 = max(0, min(置いた駒, 端の自駒) - heal_minus)
    count_div: int = 4  # 返した枚数ボーナスの割る数
    hp: int = 60
    second_bonus: int = 0  # 後手の初期体力上乗せ


def new_board():
    b = [[None] * 8 for _ in range(8)]
    # (持ち主, 数値)。初期4駒は歩(1)
    b[3][3] = (1, 1); b[4][4] = (1, 1)
    b[3][4] = (0, 1); b[4][3] = (0, 1)
    return b


def lines_for(b, r, c, p):
    """(r, c) に p が置いたときに返る列 [(cells, 端の自駒の数値), ...]"""
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
            out.append((cells, b[y][x][1]))
    return out


def legal_moves(b, p):
    return [(r, c, ls) for r in range(8) for c in range(8) if (ls := lines_for(b, r, c, p))]


def evaluate(rules, b, lines, kind):
    """駒種 kind でその手を打ったときの (ダメージ, 回復, 返した枚数)"""
    v, atk, *rest = rules.pieces[kind]
    mult = rest[0] if rest else 1  # 返した駒の最大値に掛ける倍率
    flipped = [b[y][x][1] for cells, _ in lines for (y, x) in cells]
    top = max(flipped)
    if rules.damage == "capped":
        top = min(v, top)
    elif rules.damage == "avg":
        top = (v + top) // 2
    dmg = top * mult + len(flipped) // rules.count_div + atk
    heal = max(0, max(min(v, a) for _, a in lines) - rules.heal_minus)
    return dmg, heal, len(flipped)


def apply(b, p, r, c, lines, v):
    nb = [row[:] for row in b]
    nb[r][c] = (p, v)
    for cells, _ in lines:
        for (y, x) in cells:
            nb[y][x] = (p, nb[y][x][1])  # 色だけ変わり数値は残る
    return nb


# ---- ボット ----

def _pieces(hand):
    return [v for v, n in hand.items() if n > 0]


def bot_random(rules, b, p, moves, hands):
    r, c, ls = random.choice(moves)
    return r, c, ls, random.choice(_pieces(hands[p]))


def bot_greedy(rules, b, p, moves, hands):
    """その手の (ダメージ + 回復) が最大になる手と駒"""
    best, cands = None, []
    for r, c, ls in moves:
        for v in _pieces(hands[p]):
            d, h, _ = evaluate(rules, b, ls, v)
            s = d + h
            if best is None or s > best:
                best, cands = s, [(r, c, ls, v)]
            elif s == best:
                cands.append((r, c, ls, v))
    return random.choice(cands)


def bot_square_only(rules, b, p, moves, hands):
    """マスは greedy と同じ基準、駒はランダム（駒選びの価値を測る対照）"""
    v = random.choice(_pieces(hands[p]))
    best, cands = None, []
    for r, c, ls in moves:
        d, h, _ = evaluate(rules, b, ls, v)
        s = d + h
        if best is None or s > best:
            best, cands = s, [(r, c, ls)]
        elif s == best:
            cands.append((r, c, ls))
    r, c, ls = random.choice(cands)
    return r, c, ls, v


def bot_lookahead(rules, b, p, moves, hands):
    """2手読み: 自分の (ダメージ+回復) − 相手の最善応手の (ダメージ+回復)"""
    q = p ^ 1
    opp_pieces = _pieces(hands[q])
    best, cands = None, []
    for r, c, ls in moves:
        for v in _pieces(hands[p]):
            d, h, _ = evaluate(rules, b, ls, v)
            nb = apply(b, p, r, c, ls, rules.pieces[v][0])
            reply = 0
            if opp_pieces:
                for r2, c2, ls2 in legal_moves(nb, q):
                    for v2 in opp_pieces:
                        d2, h2, _ = evaluate(rules, nb, ls2, v2)
                        reply = max(reply, d2 + h2)
            s = d + h - reply
            if best is None or s > best:
                best, cands = s, [(r, c, ls, v)]
            elif s == best:
                cands.append((r, c, ls, v))
    return random.choice(cands)


def bot_lookahead_random_piece(rules, b, p, moves, hands):
    """2手読みでマスを選ぶが、駒は最初にランダムで決める（駒選びの価値を測る対照）"""
    v = random.choice(_pieces(hands[p]))
    only = {k: (n if k == v else 0) for k, n in hands[p].items()}
    return bot_lookahead(rules, b, p, moves, [only, hands[1]] if p == 0 else [hands[0], only])


BOTS = {"random": bot_random, "greedy": bot_greedy,
        "sq_only": bot_square_only, "lookahead": bot_lookahead,
        "look_rp": bot_lookahead_random_piece}


# ---- 対局 ----

@dataclass
class Game:
    traj: list    # 各手の後の (手数, 先手の体力増減, 後手の体力増減)
    log: list     # (手数, 手番, ダメージ, 回復, 返した枚数, 置いた駒)
    discs: list   # 終局時の石数 [先手, 後手]


def play(rules, bots):
    b = new_board()
    hands = [dict(rules.hand), dict(rules.hand)]
    hp = [0, 0]
    traj, log = [], []
    p, passes, ply = 0, 0, 0
    while passes < 2:
        moves = legal_moves(b, p) if _pieces(hands[p]) else []
        if not moves:
            passes += 1
            p ^= 1
            continue
        passes = 0
        r, c, ls, v = BOTS[bots[p]](rules, b, p, moves, hands)
        d, h, n = evaluate(rules, b, ls, v)
        hands[p][v] -= 1
        b = apply(b, p, r, c, ls, rules.pieces[v][0])
        hp[p ^ 1] -= d
        hp[p] += h
        ply += 1
        traj.append((ply, hp[0], hp[1]))
        log.append((ply, p, d, h, n, v))
        p ^= 1
    discs = [sum(1 for row in b for s in row if s and s[0] == i) for i in (0, 1)]
    return Game(traj, log, discs)


def outcome(rules, g, hp=None, bonus=None):
    """(勝者 0/1、引き分けは -1, 体力0で決着した手数 or None)"""
    h0 = rules.hp if hp is None else hp
    h1 = h0 + (rules.second_bonus if bonus is None else bonus)
    for ply, a, b in g.traj:
        if h0 + a <= 0:
            return 1, ply
        if h1 + b <= 0:
            return 0, ply
    _, a, b = g.traj[-1]
    if h0 + a != h1 + b:
        return (0 if h0 + a > h1 + b else 1), None
    if g.discs[0] != g.discs[1]:
        return (0 if g.discs[0] > g.discs[1] else 1), None
    return -1, None


# ---- 指標 ----

def stats(rules, games, hp=None, bonus=None):
    """KO率・KO平均手数・先手勝率・20/40手目リーダーの逆転率"""
    res = [outcome(rules, g, hp, bonus) for g in games]
    n = len(games)
    kos = [k for _, k in res if k is not None]
    first = sum((w == 0) + 0.5 * (w == -1) for w, _ in res) / n

    def comeback(N):
        lost = total = 0
        h0 = rules.hp if hp is None else hp
        h1 = h0 + (rules.second_bonus if bonus is None else bonus)
        for g, (w, ko) in zip(games, res):
            if len(g.traj) < N or (ko is not None and ko <= N):
                continue
            _, a, b = g.traj[N - 1]
            if h0 + a == h1 + b:
                continue
            leader = 0 if h0 + a > h1 + b else 1
            total += 1
            lost += (w != leader)
        return lost / total if total else float("nan")

    return {
        "ko_rate": len(kos) / n,
        "ko_ply": sum(kos) / len(kos) if kos else float("nan"),
        "first_win": first,
        "comeback20": comeback(20),
        "comeback40": comeback(40),
    }


def per_phase(games):
    """序盤・中盤・終盤の1手平均 (ダメージ, 回復)"""
    out = {}
    for name, lo, hi in [("序盤", 1, 20), ("中盤", 21, 40), ("終盤", 41, 99)]:
        rows = [(d, h) for g in games for (k, _, d, h, _, _) in g.log if lo <= k <= hi]
        out[name] = (sum(r[0] for r in rows) / len(rows), sum(r[1] for r in rows) / len(rows))
    return out


def match(rules, a, b, n):
    """先後を入れ替えて n 局。a の勝率"""
    win = 0
    for i in range(n):
        bots = (a, b) if i % 2 == 0 else (b, a)
        w, _ = outcome(rules, play(rules, bots))
        me = 0 if i % 2 == 0 else 1
        win += (w == me) + 0.5 * (w == -1)
    return win / n
