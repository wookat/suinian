import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseTriageJson,
  FALLBACK_TRIAGE,
  buildTriagePrompt,
  normalizeTodoDue,
  nextMondayInShanghai,
  shanghaiDate,
  triageNote,
} from "../src/triage";
import { chatComplete } from "../src/ai";

vi.mock("../src/ai", () => ({ chatComplete: vi.fn() }));
const chatCompleteMock = vi.mocked(chatComplete);

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
      amount: null,
      currency: null,
      merchant: null,
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

describe("relative date grounding (R9)", () => {
  // 2026-08-07 10:00 Shanghai = Friday
  const friday = new Date("2026-08-07T02:00:00Z");

  it("computes 明天 and 下周一 from a Friday", () => {
    expect(shanghaiDate(friday, 1)).toEqual({ iso: "2026-08-08", weekday: "周六" });
    expect(nextMondayInShanghai(friday)).toEqual({ iso: "2026-08-10", weekday: "周一" });
  });

  it("下周一 on a Monday is next week's Monday, not today", () => {
    const monday = new Date("2026-08-10T02:00:00Z");
    expect(nextMondayInShanghai(monday).iso).toBe("2026-08-17");
  });

  it("下周一 on a Sunday is tomorrow", () => {
    const sunday = new Date("2026-08-09T02:00:00Z");
    expect(nextMondayInShanghai(sunday).iso).toBe("2026-08-10");
  });

  it("prompt includes 北京时间, today's weekday and worked 明天/下周一 examples", () => {
    const p = buildTriagePrompt(friday);
    expect(p).toContain("今天是 2026-08-07（周五）");
    expect(p).toContain("北京时间");
    expect(p).toContain("「明天」= 2026-08-08（周六）");
    expect(p).toContain("「下周一」= 2026-08-10");
    expect(p).toContain("2026-08-10T20:00:00+08:00");
  });

  it("prompt includes category examples and tag prefix rule", () => {
    const p = buildTriagePrompt(friday);
    expect(p).toContain("公司报销流程");
    expect(p).toContain("不得照抄内容开头的括号前缀");
  });
});

describe("triageNote prompt injection (mocked chatComplete)", () => {
  afterEach(() => {
    chatCompleteMock.mockReset();
    vi.useRealTimers();
  });

  it("sends a system prompt with the correct 今天/周X for the mocked clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T02:00:00Z")); // Friday in Shanghai
    chatCompleteMock.mockResolvedValue(
      '{"category":"todo","tags":["邮件"],"title":"给客户回邮件","is_sensitive":false,"todo_due":"2026-08-10T20:00:00+08:00"}'
    );
    const result = await triageNote("下周一晚上8点提醒我给客户回邮件", {} as never);
    const system = chatCompleteMock.mock.calls[0][1].messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("今天是 2026-08-07（周五）");
    expect(system.content).toContain("「下周一」= 2026-08-10");
    expect(result?.todo_due).toBe("2026-08-10T20:00:00+08:00");
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
