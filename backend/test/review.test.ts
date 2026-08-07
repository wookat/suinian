import { describe, it, expect } from "vitest";
import { shanghaiDate, shiftDate, KIND_LABEL, MAX_REVIEW_ITEMS } from "../src/review";

describe("shanghaiDate", () => {
  it("converts UTC to Asia/Shanghai calendar date", () => {
    // 2026-08-06 20:00 UTC = 2026-08-07 04:00 Shanghai
    expect(shanghaiDate(new Date("2026-08-06T20:00:00Z"))).toBe("2026-08-07");
    expect(shanghaiDate(new Date("2026-08-07T10:00:00Z"))).toBe("2026-08-07");
    // 15:59 UTC is still the same Shanghai day; 16:00 rolls over
    expect(shanghaiDate(new Date("2026-08-07T15:59:00Z"))).toBe("2026-08-07");
    expect(shanghaiDate(new Date("2026-08-07T16:00:00Z"))).toBe("2026-08-08");
  });
});

describe("shiftDate", () => {
  it("shifts back one year / one month", () => {
    expect(shiftDate("2026-08-07", { years: 1 })).toBe("2025-08-07");
    expect(shiftDate("2026-08-07", { months: 1 })).toBe("2026-07-07");
  });
  it("clamps to the last day of the month instead of rolling over", () => {
    // 03-31 minus 1 month: February has no 31st -> last day of Feb, not Mar 03
    expect(shiftDate("2026-03-31", { months: 1 })).toBe("2026-02-28");
    expect(shiftDate("2024-03-31", { months: 1 })).toBe("2024-02-29");
    // leap day minus 1 year: 2023 has no 02-29 -> 02-28
    expect(shiftDate("2024-02-29", { years: 1 })).toBe("2023-02-28");
  });
  it("crosses year boundaries", () => {
    expect(shiftDate("2026-01-15", { months: 1 })).toBe("2025-12-15");
  });
});

describe("review constants", () => {
  it("labels every kind", () => {
    expect(KIND_LABEL.year_ago).toBe("一年前的今天");
    expect(KIND_LABEL.month_ago).toBe("一个月前的今天");
    expect(KIND_LABEL.revisit).toBe("值得回看");
  });
  it("caps daily items", () => {
    expect(MAX_REVIEW_ITEMS).toBe(3);
  });
});
