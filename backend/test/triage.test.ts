import { describe, it, expect } from "vitest";
import { parseTriageJson, FALLBACK_TRIAGE } from "../src/triage";

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

  it("caps tags at 5 and filters non-strings", () => {
    const r = parseTriageJson('{"category":"idea","tags":["a","b","c","d","e","f",1,null]}');
    expect(r?.tags).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("fallback shape is category=idea no tags", () => {
    expect(FALLBACK_TRIAGE.category).toBe("idea");
    expect(FALLBACK_TRIAGE.tags).toEqual([]);
  });
});
