import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildTriagePrompt,
  normalizeTodoDue,
  tzOffsetString,
  zonedDate,
  nextMondayIn,
  isValidTimezone,
  triageNote,
} from "../src/triage";
import { chatComplete } from "../src/ai";

vi.mock("../src/ai", () => ({ chatComplete: vi.fn() }));
const chatCompleteMock = vi.mocked(chatComplete);

afterEach(() => {
  chatCompleteMock.mockReset();
});

// 2026-08-11T12:00:00Z: 20:00 in Shanghai, 08:00 in New York (EDT), 12:00 UTC
const NOW = new Date("2026-08-11T12:00:00Z");

describe("tzOffsetString", () => {
  it("Asia/Shanghai is +08:00", () => {
    expect(tzOffsetString(NOW, "Asia/Shanghai")).toBe("+08:00");
  });
  it("America/New_York is -04:00 in summer (DST)", () => {
    expect(tzOffsetString(NOW, "America/New_York")).toBe("-04:00");
  });
  it("Europe/London is +01:00 in summer", () => {
    expect(tzOffsetString(NOW, "Europe/London")).toBe("+01:00");
  });
  it("UTC is +00:00", () => {
    expect(tzOffsetString(NOW, "UTC")).toBe("+00:00");
  });
  it("half-hour offsets work (Asia/Kolkata +05:30)", () => {
    expect(tzOffsetString(NOW, "Asia/Kolkata")).toBe("+05:30");
  });
});

describe("zonedDate", () => {
  it("same instant is different calendar dates across timezones", () => {
    // 2026-08-11T23:00:00Z = 08-12 07:00 Shanghai, 08-11 19:00 New York
    const lateUtc = new Date("2026-08-11T23:00:00Z");
    expect(zonedDate(lateUtc, "Asia/Shanghai").iso).toBe("2026-08-12");
    expect(zonedDate(lateUtc, "America/New_York").iso).toBe("2026-08-11");
  });
  it("offsetDays shifts the local date", () => {
    expect(zonedDate(NOW, "Asia/Shanghai", 1).iso).toBe("2026-08-12");
  });
});

describe("nextMondayIn", () => {
  it("computes next Monday in the given timezone", () => {
    // 2026-08-11 is a Tuesday in both zones at this instant
    expect(nextMondayIn(NOW, "Asia/Shanghai").iso).toBe("2026-08-17");
    expect(nextMondayIn(NOW, "America/New_York").iso).toBe("2026-08-17");
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects garbage", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("'; DROP TABLE")).toBe(false);
  });
});

describe("buildTriagePrompt timezone awareness", () => {
  it("defaults to Asia/Shanghai", () => {
    const p = buildTriagePrompt(NOW);
    expect(p).toContain("Asia/Shanghai");
    expect(p).toContain("+08:00");
    expect(p).toContain("2026-08-11");
  });
  it("uses the user timezone for today/tomorrow and offsets", () => {
    const p = buildTriagePrompt(NOW, [], "America/New_York");
    expect(p).toContain("America/New_York");
    expect(p).toContain("-04:00");
    expect(p).not.toContain("+08:00");
    // 12:00Z on 08-11 is 08:00 on 08-11 in New York
    expect(p).toContain("今天是 2026-08-11");
    expect(p).toContain("2026-08-12T15:00:00-04:00");
  });
  it("date rolls over per timezone", () => {
    const lateUtc = new Date("2026-08-11T23:00:00Z");
    expect(buildTriagePrompt(lateUtc, [], "Asia/Shanghai")).toContain("今天是 2026-08-12");
    expect(buildTriagePrompt(lateUtc, [], "America/New_York")).toContain("今天是 2026-08-11");
  });
});

describe("normalizeTodoDue default offset", () => {
  it("keeps explicit offsets untouched", () => {
    expect(normalizeTodoDue("2026-08-12T10:00:00-04:00", "+08:00")).toBe("2026-08-12T10:00:00-04:00");
  });
  it("applies the user offset to bare local times", () => {
    expect(normalizeTodoDue("2026-08-12T10:00", "-04:00")).toBe("2026-08-12T10:00:00-04:00");
    expect(normalizeTodoDue("2026-08-12 10:00:00", "+05:30")).toBe("2026-08-12T10:00:00+05:30");
  });
  it("defaults to +08:00 for backwards compatibility", () => {
    expect(normalizeTodoDue("2026-08-12T10:00")).toBe("2026-08-12T10:00:00+08:00");
  });
  it("date-only values stay date-only", () => {
    expect(normalizeTodoDue("2026-08-12", "-04:00")).toBe("2026-08-12");
  });
});

describe("triageNote end-to-end timezone", () => {
  it("「明天上午10点」in New York stores a -04:00 due, not +08:00", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      // model returns a bare local time: the user offset must be attached
      chatCompleteMock.mockResolvedValue(
        '{"category":"todo","tags":["会议"],"title":"开会","is_sensitive":false,"todo_due":"2026-08-12T10:00:00"}'
      );
      const r = await triageNote("明天上午10点开会", {} as never, [], "America/New_York");
      expect(r?.todo_due).toBe("2026-08-12T10:00:00-04:00");
      const prompt = (chatCompleteMock.mock.calls[0][1] as { messages: { content: string }[] }).messages[0].content;
      expect(prompt).toContain("America/New_York");
    } finally {
      vi.useRealTimers();
    }
  });
});
