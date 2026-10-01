# tako:run python3 sim/export_replays.py
"""Web 版（TypeScript エンジン）との整合テスト用に、v1.0（capture.py）の対局の棋譜を JSON に書き出す。

capture.py の部品（new_board / captures / apply / pieces / empties / outcome）だけを使い、
play() と同じ手番・パス・手数上限の規則で打ちながら、着手ごとの取った駒・ダメージ・盤面・持ち駒を記録する
（play() のログには座標が残らないため）。
2手読みボットの手番では、局面ごとの最善スコアと同点候補の集合も書き出し、CPU の移植を検証する。

出力: web/test/fixtures/replays.json
"""
import json
import os
import random

import capture as k

RULES = k.Rules(hp=20)  # RULES.md v1.0: 体力 20・80 手・後手ボーナスなし
# 数字 -> TS の PieceKind
KIND = {1: "fu", 3: "kin", 5: "hi"}
# (先手ボット, 後手ボット, 局数)
MATCHUPS = [
    ("random", "random", 16),
    ("greedy", "greedy", 8),
    ("lookahead", "lookahead", 8),
    ("lookahead", "random", 4),
    ("random", "lookahead", 4),
    ("greedy", "lookahead", 4),
    ("lookahead", "greedy", 4),
]
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "test", "fixtures", "replays.json")


def lookahead_scores(b, hands, p):
    """bot_lookahead と同じ評価で (最善スコア, 同点候補 [(r, c, 数字)])"""
    q = p ^ 1
    best, cands = None, []
    for r, c in k.empties(b):
        for v in k.pieces(hands[p]):
            nb, nh, d = k.apply(b, hands, p, r, c, v)
            reply = k.best_capture(nb, q) if k.pieces(nh[q]) else 0
            s = d - reply
            if best is None or s > best:
                best, cands = s, [(r, c, v)]
            elif s == best:
                cands.append((r, c, v))
    return best, cands


def dump_board(b):
    """盤面を 64 文字に: 空き '.'、先手は小文字 a/c/e（1/3/5）、後手は大文字 A/C/E"""
    ch = {1: "a", 3: "c", 5: "e"}
    return "".join(
        "." if s is None else (ch[s[1]] if s[0] == 0 else ch[s[1]].upper()) for row in b for s in row
    )


def dump_hands(hands):
    return [[h.get(v, 0) for v in (1, 3, 5)] for h in hands]


def record(bots):
    """play() と同じ進行で 1 局打ち、イベント列と結果を返す（体力 0 でも止めずに打ち切りまで進める）"""
    b = k.new_board()
    hands = [dict(RULES.hand), dict(RULES.hand)]
    hp = [0, 0]
    traj, events = [], []
    p, ply, passes = 0, 0, 0
    while ply < RULES.max_plies and passes < 2:
        if not k.pieces(hands[p]) or not k.empties(b):
            events.append({"t": "pass", "p": p})
            passes += 1
            p ^= 1
            continue
        passes = 0
        ev = {"t": "move", "p": p}
        if bots[p] == "lookahead":
            best, cands = lookahead_scores(b, hands, p)
            ev["best"] = best
            # 候補は "行 列 数字" の 3 文字を連結した文字列（ファイルを小さく保つため）
            ev["cands"] = "".join(f"{r}{c}{v}" for r, c, v in sorted(cands))
        r, c, v = k.BOTS[bots[p]](b, hands, p)
        cap = k.captures(b, r, c, p)
        b, hands, d = k.apply(b, hands, p, r, c, v)
        hp[p ^ 1] -= d
        ply += 1
        traj.append((ply, hp[0], hp[1]))
        ev.update({
            "r": r, "c": c, "kind": KIND[v], "cap": [[y, x] for y, x in cap], "dmg": d,
            "board": dump_board(b), "hands": dump_hands(hands),
        })
        events.append(ev)
        p ^= 1
    winner, ko_ply = k.outcome(traj, RULES.hp, RULES.second_bonus)
    end_ply = ko_ply if ko_ply is not None else ply
    _, a0, a1 = traj[end_ply - 1]
    return {
        "bots": list(bots),
        "events": events,
        "plies": ply,
        "winner": winner,
        "ko_ply": ko_ply,
        # 終局した時点（KO ならその手、それ以外は最終手）の体力
        "end_hp": [RULES.hp + a0, RULES.hp + RULES.second_bonus + a1],
    }


def main():
    random.seed(20261001)
    games = []
    for b0, b1, n in MATCHUPS:
        games += [record((b0, b1)) for _ in range(n)]
    # 上の組み合わせでは出にくい引き分け（2 手読み同士で約 2%）を探して 2 局足す。
    # 80 手の打ち切りは持ち駒を 26 個取り返す必要があり、ボット同士ではほぼ起きないのでユニットテストで確かめる
    draws = 0
    for _ in range(1000):
        g = record(("lookahead", "lookahead"))
        if g["winner"] == -1:
            games.append(g)
            draws += 1
            if draws == 2:
                break
    kos = sum(g["ko_ply"] is not None for g in games)
    draws = sum(g["winner"] == -1 for g in games)
    passes = sum(e["t"] == "pass" for g in games for e in g["events"])
    limit = sum(g["plies"] == RULES.max_plies and g["ko_ply"] is None for g in games)
    print(f"{len(games)} 局 / 体力0決着 {kos} / 手数切れ {limit} / 引き分け {draws} / パス {passes} 回")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"hp": RULES.hp, "max_plies": RULES.max_plies, "games": games}, f, separators=(",", ":"))
    print(f"-> {os.path.normpath(OUT)} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main()
