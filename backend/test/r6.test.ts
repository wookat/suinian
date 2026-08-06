import { describe, it, expect } from "vitest";
import { normalizeStoredTodoDue } from "../src/index";

describe("normalizeStoredTodoDue (legacy read compat)", () => {
  it("appends +08:00 to legacy offset-less datetimes", () => {
    expect(normalizeStoredTodoDue("2026-08-08T15:30")).toBe("2026-08-08T15:30:00+08:00");
    expect(normalizeStoredTodoDue("2026-08-08T15:30:00")).toBe("2026-08-08T15:30:00+08:00");
  });

  it("keeps already-offset datetimes untouched", () => {
    expect(normalizeStoredTodoDue("2026-08-08T15:30:00+08:00")).toBe("2026-08-08T15:30:00+08:00");
    expect(normalizeStoredTodoDue("2026-08-08T15:30:00-05:00")).toBe("2026-08-08T15:30:00-05:00");
  });

  it("keeps date-only and null values untouched", () => {
    expect(normalizeStoredTodoDue("2026-08-10")).toBe("2026-08-10");
    expect(normalizeStoredTodoDue(null)).toBeNull();
  });
});
