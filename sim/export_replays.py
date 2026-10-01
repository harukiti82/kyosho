# tako:run python3 sim/export_replays.py
"""Web 試遊版（TypeScript エンジン）との整合テスト用に、3 つのシミュレーターの棋譜を JSON に書き出す。

- v04: sim/kyosho.py（裏返す・最大値＋枚数÷4・回復は低い方−1・体力 65/66）
- v10: sim/capture.py（取って持ち駒にする・合計・体力 20・80 手）
- v2 : sim/gate.py（裏返す・置いた駒より強い駒は返せない・合計・体力 40）

各シミュレーターの部品だけを使い、play() と同じ手番・パス・手数上限の規則で打ちながら、
着手ごとの返した（取った）駒・ダメージ・回復・盤面・持ち駒を記録する（play() のログには座標が残らないため）。
2 手読みボットの手番では、局面ごとの最善スコアと同点候補の集合も書き出し、CPU の移植を検証する。

出力: web/test/fixtures/replays.json
"""
import json
import os
import random

import capture
import gate
import kyosho

OUT = os.path.join(os.path.dirname(__file__), "..", "web", "test", "fixtures", "replays.json")
# 数字 -> 盤面の文字（先手は小文字、後手は大文字）
CH = {1: "a", 2: "b", 3: "c", 5: "e"}
VALUES = (1, 2, 3, 5)
KIND = {1: "fu", 2: "gin", 3: "kin", 5: "hi"}


def dump_board(b):
    """盤面を 64 文字に: 空き '.'、先手は a/b/c/e（1/2/3/5）、後手は大文字"""
    return "".join("." if s is None else (CH[s[1]] if s[0] == 0 else CH[s[1]].upper()) for row in b for s in row)


def dump_hands(hands):
    return [[h.get(v, 0) for v in VALUES] for h in hands]


def discs(b):
    return [sum(1 for row in b for s in row if s and s[0] == i) for i in (0, 1)]


def pieces(hand):
    return [v for v, n in hand.items() if n > 0]


def ranked(items):
    """(スコア, 手) の列から (最善スコア, 同点の手) を返す"""
    best, cands = None, []
    for s, m in items:
        if best is None or s > best:
            best, cands = s, [m]
        elif s == best:
            cands.append(m)
    return best, cands


# ---- v0.4: sim/kyosho.py ----

class V04:
    id = "v04"
    rules = kyosho.Rules(damage="max", heal_minus=1, hp=65, second_bonus=1)
    hp = (65, 66)
    max_plies = 0
    bots = ("random", "greedy", "lookahead")

    def __init__(self):
        self.hand = dict(self.rules.hand)

    def can_move(self, b, hands, p):
        return bool(pieces(hands[p])) and bool(kyosho.legal_moves(b, p))

    def choose(self, bot, b, hands, p):
        r, c, _, v = kyosho.BOTS[bot](self.rules, b, p, kyosho.legal_moves(b, p), hands)
        return r, c, v

    def step(self, b, hands, p, r, c, v):
        ls = kyosho.lines_for(b, r, c, p)
        d, h, _ = kyosho.evaluate(self.rules, b, ls, v)
        cells = [cell for cs, _ in ls for cell in cs]
        nh = [dict(hands[0]), dict(hands[1])]
        nh[p][v] -= 1
        return kyosho.apply(b, p, r, c, ls, self.rules.pieces[v][0]), nh, d, h, cells

    def lookahead(self, b, hands, p):
        """bot_lookahead と同じ評価"""
        q = p ^ 1
        opp = pieces(hands[q])
        items = []
        for r, c, ls in kyosho.legal_moves(b, p):
            for v in pieces(hands[p]):
                d, h, _ = kyosho.evaluate(self.rules, b, ls, v)
                nb = kyosho.apply(b, p, r, c, ls, self.rules.pieces[v][0])
                reply = 0
                if opp:
                    for _, _, ls2 in kyosho.legal_moves(nb, q):
                        for v2 in opp:
                            d2, h2, _ = kyosho.evaluate(self.rules, nb, ls2, v2)
                            reply = max(reply, d2 + h2)
                items.append((d + h - reply, (r, c, v)))
        return ranked(items)

    def outcome(self, traj, log, b):
        return kyosho.outcome(self.rules, kyosho.Game(traj, log, discs(b)))


# ---- v1.0: sim/capture.py ----

class V10:
    id = "v10"
    rules = capture.Rules(hp=20)
    hp = (20, 20)
    max_plies = 80
    bots = ("random", "greedy", "lookahead")

    def __init__(self):
        self.hand = dict(self.rules.hand)

    def can_move(self, b, hands, p):
        return bool(pieces(hands[p])) and bool(capture.empties(b))

    def choose(self, bot, b, hands, p):
        return capture.BOTS[bot](b, hands, p)

    def step(self, b, hands, p, r, c, v):
        cells = capture.captures(b, r, c, p)
        nb, nh, d = capture.apply(b, hands, p, r, c, v)
        return nb, nh, d, 0, cells

    def lookahead(self, b, hands, p):
        q = p ^ 1
        items = []
        for r, c in capture.empties(b):
            for v in pieces(hands[p]):
                nb, nh, d = capture.apply(b, hands, p, r, c, v)
                reply = capture.best_capture(nb, q) if pieces(nh[q]) else 0
                items.append((d - reply, (r, c, v)))
        return ranked(items)

    def outcome(self, traj, log, b):
        return capture.outcome(traj, self.rules.hp, self.rules.second_bonus)


# ---- v2 案: sim/gate.py ----

class V2:
    id = "v2"
    rules = gate.Rules()
    hp = (40, 40)
    max_plies = 0
    bots = ("random", "greedy", "lookahead", "othello")

    def __init__(self):
        self.hand = dict(self.rules.hand)

    def can_move(self, b, hands, p):
        return bool(gate.moves(self.rules, b, hands[p], p))

    def choose(self, bot, b, hands, p):
        r, c, v, _ = gate.BOTS[bot](self.rules, b, hands, p, gate.moves(self.rules, b, hands[p], p))
        return r, c, v

    def step(self, b, hands, p, r, c, v):
        f = gate.flips(self.rules, b, r, c, p, v)
        nh = [dict(hands[0]), dict(hands[1])]
        nh[p][v] -= 1
        return gate.apply(b, p, r, c, v, f), nh, gate.dmg_of(b, f), 0, f

    def lookahead(self, b, hands, p):
        q = p ^ 1
        items = []
        for r, c, v, f in gate.moves(self.rules, b, hands[p], p):
            nb = gate.apply(b, p, r, c, v, f)
            reply = 0
            for *_, f2 in gate.moves(self.rules, nb, hands[q], q):
                reply = max(reply, gate.dmg_of(nb, f2))
            items.append((gate.dmg_of(b, f) - reply, (r, c, v)))
        return ranked(items)

    def outcome(self, traj, log, b):
        return gate.outcome(traj, self.rules.hp)


def record(sim, bots):
    """play() と同じ進行で 1 局打ち、イベント列と結果を返す（体力 0 でも止めずに最後まで進める）"""
    b = kyosho.new_board()
    hands = [dict(sim.hand), dict(sim.hand)]
    hp = [0, 0]  # 初期体力からの増減
    traj, log, events = [], [], []
    p, ply, passes = 0, 0, 0
    while (sim.max_plies == 0 or ply < sim.max_plies) and passes < 2:
        if not sim.can_move(b, hands, p):
            events.append({"t": "pass", "p": p})
            passes += 1
            p ^= 1
            continue
        passes = 0
        ev = {"t": "move", "p": p}
        if bots[p] == "lookahead":
            best, cands = sim.lookahead(b, hands, p)
            ev["best"] = best
            # 候補は "行 列 数字" の 3 文字を連結した文字列（ファイルを小さく保つため）
            ev["cands"] = "".join(f"{r}{c}{v}" for r, c, v in sorted(cands))
        r, c, v = sim.choose(bots[p], b, hands, p)
        b, hands, d, h, cells = sim.step(b, hands, p, r, c, v)
        hp[p ^ 1] -= d
        hp[p] += h
        ply += 1
        traj.append((ply, hp[0], hp[1]))
        log.append((ply, p, d, h, len(cells), v))
        ev.update({
            "r": r, "c": c, "kind": KIND[v], "cells": [[y, x] for y, x in cells], "dmg": d, "heal": h,
            "board": dump_board(b), "hands": dump_hands(hands),
        })
        events.append(ev)
        p ^= 1
    winner, ko_ply = sim.outcome(traj, log, b)
    end_ply = ko_ply if ko_ply is not None else ply
    _, a0, a1 = traj[end_ply - 1]
    return {
        "bots": list(bots),
        "events": events,
        "plies": ply,
        "winner": winner,
        "ko_ply": ko_ply,
        # 終局した時点（KO ならその手、それ以外は最終手）の体力と、最終盤面の石数
        "end_hp": [sim.hp[0] + a0, sim.hp[1] + a1],
        "discs": discs(b),
    }


def export(sim, matchups, want_draw):
    games = []
    for b0, b1, n in matchups:
        games += [record(sim, (b0, b1)) for _ in range(n)]
    # 体力が同じで終わる局（Python は引き分け、Web 版は石数で判定）を探して 1 局足す
    if want_draw and not any(g["winner"] == -1 for g in games):
        for _ in range(500):
            g = record(sim, want_draw)
            if g["winner"] == -1:
                games.append(g)
                break
    kos = sum(g["ko_ply"] is not None for g in games)
    draws = sum(g["winner"] == -1 for g in games)
    passes = sum(e["t"] == "pass" for g in games for e in g["events"])
    look = sum("cands" in e for g in games for e in g["events"])
    print(f"{sim.id}: {len(games)} 局 / 体力0決着 {kos} / Python で引き分け {draws} / パス {passes} 回 / 2手読みの局面 {look}")
    return {
        "preset": sim.id,
        "hp": list(sim.hp),
        "hand": [sim.hand.get(v, 0) for v in VALUES],
        "max_plies": sim.max_plies,
        "games": games,
    }


def main():
    random.seed(20261001)
    sets = [
        export(V04(), [
            ("random", "random", 8), ("greedy", "greedy", 4), ("lookahead", "lookahead", 4),
            ("lookahead", "random", 3), ("random", "lookahead", 3), ("greedy", "lookahead", 2), ("lookahead", "greedy", 2),
        ], None),
        export(V10(), [
            ("random", "random", 10), ("greedy", "greedy", 4), ("lookahead", "lookahead", 6),
            ("lookahead", "random", 3), ("random", "lookahead", 3), ("greedy", "lookahead", 2), ("lookahead", "greedy", 2),
        ], ("lookahead", "lookahead")),
        export(V2(), [
            ("random", "random", 8), ("greedy", "greedy", 4), ("lookahead", "lookahead", 4), ("othello", "othello", 2),
            ("lookahead", "random", 3), ("random", "lookahead", 3), ("othello", "lookahead", 2), ("lookahead", "greedy", 2),
        ], ("random", "random")),
    ]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"sets": sets}, f, separators=(",", ":"))
    print(f"-> {os.path.normpath(OUT)} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
