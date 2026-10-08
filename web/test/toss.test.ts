// 先手・後手の抽選の演出（ui/fx.ts の toss）: 石の最後の向きが手番の色と合うこと、長さがサーバーの猶予に収まること

import { describe, expect, it } from "vitest";
import { TOSS_LAND_MS, TOSS_MS, TOSS_REDUCED_MS, TOSS_TURNS, tossAngle, tossMs } from "../src/ui/fx";
import { TOSS_GRACE_MS } from "../src/net/protocol";

describe("抽選の演出", () => {
  it("先手は表（黒、0 度）、後手は裏（白、180 度）が上を向いて止まる。どちらも同じ回数だけ回る", () => {
    expect(tossAngle(0) % 360).toBe(0);
    expect(tossAngle(1) % 360).toBe(180);
    expect(Math.floor(tossAngle(0) / 360)).toBe(TOSS_TURNS);
    expect(Math.floor(tossAngle(1) / 360)).toBe(TOSS_TURNS);
    expect(TOSS_TURNS).toBeGreaterThanOrEqual(3);
  });

  it("長さは 2 秒以内で、オンラインの最初の締め切りに足す猶予に収まる。動きを減らす設定では短い", () => {
    expect(tossMs(false)).toBe(TOSS_MS);
    expect(tossMs(true)).toBe(TOSS_REDUCED_MS);
    expect(TOSS_MS).toBeLessThanOrEqual(2000);
    expect(TOSS_MS).toBeLessThanOrEqual(TOSS_GRACE_MS);
    expect(TOSS_REDUCED_MS).toBeLessThan(TOSS_MS);
    // 落ちてから結果を読む間がある
    expect(TOSS_MS - TOSS_LAND_MS).toBeGreaterThanOrEqual(600);
  });
});
