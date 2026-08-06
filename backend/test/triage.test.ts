import { describe, it, expect } from "vitest";
import { parseTriageJson, FALLBACK_TRIAGE, buildTriagePrompt, normalizeTodoDue } from "../src/triage";

describe("parseTriageJson", () => {
  it("parses valid JSON", () => {
    const r = parseTriageJson(
      '{"category":"todo","tags":["工作","会议"],"title":"约会议","is_sensitive":false,"todo_due":"2026-08-10"}'
    );
    expect(r).toEqual({
      category: "todo",
      tags: ["工作", "会议"],
      title: "约会议",
      is_sensitive: false,
      todo_due: "2026-08-10",
    });
  });

  it("parses JSON wrapped in markdown fences", () => {
    const r = parseTriageJson('```json\n{"category":"idea","tags":["创业"],"title":"t","is_sensitive":false}\n```');
    expect(r?.category).toBe("idea");
    expect(r?.tags).toEqual(["创业"]);
    expect(r?.todo_due).toBeNull();
  });

  it("parses JSON with surrounding prose", () => {
    const r = parseTriageJson('好的，结果如下：{"category":"collect","tags":[],"title":"","is_sensitive":true} 希望有帮助');
    expect(r?.category).toBe("collect");
    expect(r?.is_sensitive).toBe(true);
  });

  it("rejects invalid category", () => {
    expect(parseTriageJson('{"category":"random","tags":[]}')).toBeNull();
  });

  it("rejects non-JSON garbage", () => {
    expect(parseTriageJson("not json at all")).toBeNull();
  });

  it("caps tags at 3 and filters non-strings", () => {
    const r = parseTriageJson('{"category":"idea","tags":["a","b","c","d","e","f",1,null]}');
    expect(r?.tags).toEqual(["a", "b", "c"]);
  });

  it("fallback shape is category=idea no tags", () => {
    expect(FALLBACK_TRIAGE.category).toBe("idea");
    expect(FALLBACK_TRIAGE.tags).toEqual([]);
  });

  it("normalizes a bare time-of-day todo_due to offset ISO (+08:00)", () => {
    const r = parseTriageJson(
      '{"category":"todo","tags":["会议"],"title":"开会","is_sensitive":false,"todo_due":"2026-08-07T15:30"}'
    );
    expect(r?.todo_due).toBe("2026-08-07T15:30:00+08:00");
  });

  it("keeps an offset todo_due as offset ISO", () => {
    const r = parseTriageJson(
      '{"category":"todo","tags":[],"title":"t","is_sensitive":false,"todo_due":"2026-08-08T15:30:00+08:00"}'
    );
    expect(r?.todo_due).toBe("2026-08-08T15:30:00+08:00");
  });

  it("keeps date-only todo_due as YYYY-MM-DD", () => {
    const r = parseTriageJson('{"category":"todo","tags":[],"title":"t","is_sensitive":false,"todo_due":"2026-08-10"}');
    expect(r?.todo_due).toBe("2026-08-10");
  });
});

describe("normalizeTodoDue", () => {
  it("normalizes timed values to canonical offset ISO 8601", () => {
    expect(normalizeTodoDue("2026-08-07 15:30")).toBe("2026-08-07T15:30:00+08:00");
    expect(normalizeTodoDue("2026-08-07T15:30:00")).toBe("2026-08-07T15:30:00+08:00");
    expect(normalizeTodoDue("2026-08-07T15:30+08:00")).toBe("2026-08-07T15:30:00+08:00");
    expect(normalizeTodoDue("2026-08-07T15:30:00+0800")).toBe("2026-08-07T15:30:00+08:00");
    expect(normalizeTodoDue("2026-08-07T07:30:00Z")).toBe("2026-08-07T07:30:00+00:00");
    expect(normalizeTodoDue("2026-08-07T15:30:00-05:00")).toBe("2026-08-07T15:30:00-05:00");
  });

  it("keeps date-only values as YYYY-MM-DD", () => {
    expect(normalizeTodoDue("2026-08-10")).toBe("2026-08-10");
  });

  it("rejects non-date strings and non-strings", () => {
    expect(normalizeTodoDue("明天下午")).toBeNull();
    expect(normalizeTodoDue("")).toBeNull();
    expect(normalizeTodoDue(null)).toBeNull();
    expect(normalizeTodoDue(42)).toBeNull();
  });
});

describe("buildTriagePrompt todo_due instructions", () => {
  it("asks for YYYY-MM-DDTHH:mm when a time-of-day is present, date-only otherwise", () => {
    const p = buildTriagePrompt(new Date("2026-08-06T04:00:00Z"));
    expect(p).toContain('YYYY-MM-DDTHH:mm:00+08:00');
    expect(p).toContain("具体时刻");
    expect(p).toContain('只有日期没有时刻时仅输出 "YYYY-MM-DD"');
  });
});
