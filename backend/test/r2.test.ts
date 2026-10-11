import { describe, it, expect } from "vitest";
import { buildTriagePrompt, todayInShanghai, detectSensitive, sanitizeTags, parseTriageJson } from "../src/triage";
import { lastWeekRange } from "../src/reports";
import { cosineSim } from "../src/threads";

describe("buildTriagePrompt (todo_due date grounding)", () => {
  it("injects today's date in Asia/Shanghai with weekday", () => {
    // 2026-08-06 02:00 UTC = 2026-08-06 10:00 Shanghai, Thursday
    const now = new Date("2026-08-06T02:00:00Z");
    const p = buildTriagePrompt(now);
    expect(p).toContain("今天是 2026-08-06");
    expect(p).toContain("周四");
    expect(p).toContain("绝不要输出早于今天的日期");
  });

  it("crosses the date line correctly (UTC evening = next Shanghai day)", () => {
    // 2026-08-06 20:00 UTC = 2026-08-07 04:00 Shanghai, Friday
    const { iso, weekday } = todayInShanghai(new Date("2026-08-06T20:00:00Z"));
    expect(iso).toBe("2026-08-07");
    expect(weekday).toBe("周五");
  });

  it("includes user's existing tags for reuse", () => {
    const p = buildTriagePrompt(new Date(), ["产品", "浏览器"]);
    expect(p).toContain("用户已有标签");
    expect(p).toContain("产品、浏览器");
  });

  it("limits tags instruction to 1-3", () => {
    expect(buildTriagePrompt(new Date())).toContain("1-3 个");
  });
});

describe("detectSensitive (regex fallback)", () => {
  it("flags password + value patterns", () => {
    expect(detectSensitive("服务器密码是 Abc12345")).toBe(true);
    expect(detectSensitive("wifi 密码：hunter2233")).toBe(true);
    expect(detectSensitive("我的 api key: sk-abcdef1234567890")).toBe(true);
    expect(detectSensitive("银行卡号 6222021234567890123")).toBe(true);
  });

  it("does not flag ordinary notes", () => {
    expect(detectSensitive("今天想到一个关于浏览器速记入口的点子")).toBe(false);
    expect(detectSensitive("周五之前把周报写完")).toBe(false);
  });
});

describe("sanitizeTags", () => {
  it("drops secret-looking tags and caps at 3", () => {
    expect(sanitizeTags(["密码管理", "Abc12345", "123456789", "sk-abcdef", "工作", "生活", "多余"])).toEqual([
      "密码管理",
      "工作",
      "生活",
    ]);
  });

  it("dedupes near-identical spellings (space/case), keeping first", () => {
    expect(sanitizeTags(["ServiceWorker", "Service Worker", "收藏"])).toEqual(["ServiceWorker", "收藏"]);
    expect(sanitizeTags(["AI", "ai", "读书"])).toEqual(["AI", "读书"]);
    expect(sanitizeTags(["产品 思考", "产品思考"])).toEqual(["产品 思考"]);
  });
});

describe("parseTriageJson caps tags at 3", () => {
  it("keeps at most 3 tags", () => {
    const r = parseTriageJson('{"category":"idea","tags":["a1中","b2中","c3中","d4中","e5中"]}');
    expect(r?.tags).toEqual(["a1中", "b2中", "c3中"]);
  });
});

describe("lastWeekRange", () => {
  it("returns previous Monday..Sunday in Shanghai time", () => {
    // 2026-08-03 is a Monday; 00:30 Shanghai Monday = 2026-08-02 16:30 UTC
    const r = lastWeekRange(new Date("2026-08-02T16:30:00Z"));
    expect(r).toEqual({ weekStart: "2026-07-27", weekEnd: "2026-08-02" });
  });

  it("mid-week gives the same last week", () => {
    const r = lastWeekRange(new Date("2026-08-06T02:00:00Z")); // Thursday
    expect(r).toEqual({ weekStart: "2026-07-27", weekEnd: "2026-08-02" });
  });
});

describe("cosineSim", () => {
  it("computes cosine similarity", () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSim([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});
