# tako:run python3 sim/export_replays.py
"""Web 版（TypeScript エンジン）との整合テスト用に、対局の棋譜を JSON に書き出す。

kyosho.py の部品（new_board / legal_moves / evaluate / apply / outcome）だけを使い、
play() と同じ手番・パス規則で打ちながら着手座標まで記録する（play() のログには座標が残らないため）。
2手読みボットの手番では、局面ごとの最善スコアと同点候補の集合も書き出し、CPU の移植を検証する。

出力: web/test/fixtures/replays.json
"""
import json
import os
import random

import kyosho as k

BASE = {1: (1, 0), 2: (2, 0), 3: (3, 0), 5: (5, 0)}
RULESETS = {
    # RULES.md v0.4 の標準ルール
    "standard": k.Rules(damage="max", heal_minus=1, hp=65, second_bonus=1),
    # 追加ルール「角」: 歩2個→角2個、攻撃は最大値×2、後手ボーナスなし
    "kaku": k.Rules(damage="max", heal_minus=1, hp=65, second_bonus=0,
                    hand={1: 12, 2: 10, 3: 6, 5: 2, "角": 2}, pieces={**BASE, "角": (1, 0, 2)}),
}
# Python の駒種キー -> TS の PieceKind
KIND = {1: "fu", 2: "gin", 3: "kin", 5: "hi", "角": "kaku"}
# (先手ボット, 後手ボット, 局数)
MATCHUPS = [("random", "random", 30), ("lookahead", "random", 4), ("random", "lookahead", 4)]
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "test", "fixtures", "replays.json")


def lookahead_scores(rules, b, p, moves, hands):
    """bot_lookahead と同じ評価で (最善スコア, 同点候補 [(r, c, 駒種)])"""
    q = p ^ 1
    opp_pieces = k._pieces(hands[q])
    best, cands = None, []
    for r, c, ls in moves:
        for v in k._pieces(hands[p]):
            d, h, _ = k.evaluate(rules, b, ls, v)
            nb = k.apply(b, p, r, c, ls, rules.pieces[v][0])
            reply = 0
            if opp_pieces:
                for r2, c2, ls2 in k.legal_moves(nb, q):
                    for v2 in opp_pieces:
                        d2, h2, _ = k.evaluate(rules, nb, ls2, v2)
                        reply = max(reply, d2 + h2)
            s = d + h - reply
            if best is None or s > best:
                best, cands = s, [(r, c, v)]
            elif s == best:
                cands.append((r, c, v))
    return best, cands


def dump_board(b):
    return [[None if s is None else [s[0], s[1]] for s in row] for row in b]


def record(rules, bots):
    """play() と同じ進行で1局打ち、着手座標付きのイベント列を返す"""
    b = k.new_board()
    hands = [dict(rules.hand), dict(rules.hand)]
    hp = [0, 0]
    traj, log, events = [], [], []
    boards = []  # 各手の直後の盤面（KO 時点の盤面を取り出すため）
    p, passes, ply = 0, 0, 0
    while passes < 2:
        moves = k.legal_moves(b, p) if k._pieces(hands[p]) else []
        if not moves:
            events.append({"t": "pass", "p": p})
            passes += 1
            p ^= 1
            continue
        passes = 0
        ev = {"t": "move", "p": p}
        if bots[p] == "lookahead":
            best, cands = lookahead_scores(rules, b, p, moves, hands)
            ev["best"] = best
            ev["cands"] = sorted([r, c, KIND[v]] for r, c, v in cands)
        r, c, ls, v = k.BOTS[bots[p]](rules, b, p, moves, hands)
        d, h, n = k.evaluate(rules, b, ls, v)
        hands[p][v] -= 1
        b = k.apply(b, p, r, c, ls, rules.pieces[v][0])
        hp[p ^ 1] -= d
        hp[p] += h
        ply += 1
        traj.append((ply, hp[0], hp[1]))
        log.append((ply, p, d, h, n, v))
        boards.append(b)
        ev.update({"r": r, "c": c, "kind": KIND[v], "attack": d, "heal": h, "n": n})
        events.append(ev)
        p ^= 1
    discs = [sum(1 for row in b for s in row if s and s[0] == i) for i in (0, 1)]
    winner, ko_ply = k.outcome(rules, k.Game(traj, log, discs))
    end_ply = ko_ply if ko_ply is not None else ply
    _, a0, a1 = traj[end_ply - 1]
    h0 = rules.hp
    return {
        "bots": list(bots),
        "events": events,
        "final_board": dump_board(b),
        "winner": winner,
        "ko_ply": ko_ply,
        # 体力ルールで終局した時点（KO なら KO の手、それ以外は最終手）の盤面と体力
        "end_board": dump_board(boards[end_ply - 1]),
        "end_hp": [h0 + a0, h0 + rules.second_bonus + a1],
    }


def main():
    out = {}
    for name, rules in RULESETS.items():
        random.seed(20261001)
        games = []
        for b0, b1, n in MATCHUPS:
            games += [record(rules, (b0, b1)) for _ in range(n)]
        out[name] = games
        kos = sum(g["ko_ply"] is not None for g in games)
        passes = sum(e["t"] == "pass" for g in games for e in g["events"][:-2])
        print(f"{name}: {len(games)} 局 / 体力0決着 {kos} 局 / 途中パス {passes} 回")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"-> {os.path.normpath(OUT)} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
