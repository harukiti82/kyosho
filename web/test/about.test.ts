// このゲームについて（版の表記）と、想定外のエラーの知らせで拾うエラーの見分け
import { describe, expect, it } from "vitest";
import { APP_VERSION, versionLabel } from "../src/ui/about";
import { isAppError } from "../src/ui/crash";
import pkg from "../package.json";

describe("版", () => {
  it("package.json の version と同じ", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toBe("1.0.0");
  });

  it("末尾の .0 だけを落とす", () => {
    expect(versionLabel()).toBe("1.0");
    expect(versionLabel("1.0.0")).toBe("1.0");
    expect(versionLabel("1.2.0")).toBe("1.2");
    expect(versionLabel("1.0.1")).toBe("1.0.1");
    expect(versionLabel("2.10.0")).toBe("2.10");
    expect(versionLabel("1.0.10")).toBe("1.0.10");
  });
});

describe("想定外のエラーの見分け", () => {
  const origin = "https://kyosho.rukiharukichi.com";
  it("この画面のスクリプトの例外は知らせる", () => {
    expect(isAppError("TypeError: x is undefined", `${origin}/assets/index-abc.js`, true, origin)).toBe(true);
    // ファイル名のないもの（インラインのスクリプトなど）も知らせる
    expect(isAppError("Error: boom", "", true, origin)).toBe(true);
  });

  it("別のオリジンのスクリプトの中身の見えないエラーと ResizeObserver の警告は知らせない", () => {
    expect(isAppError("Script error.", "", false, origin)).toBe(false);
    expect(isAppError("Error", "https://static.cloudflareinsights.com/beacon.min.js", true, origin)).toBe(false);
    expect(isAppError("Error", "chrome-extension://abc/content.js", true, origin)).toBe(false);
    expect(isAppError("ResizeObserver loop completed with undelivered notifications.", "", false, origin)).toBe(false);
    // 同じ名前で始まる別のオリジンは別物
    expect(isAppError("Error", `${origin}.evil.example/x.js`, true, origin)).toBe(false);
  });
});
