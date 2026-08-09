import { describe, it, expect } from "vitest";
import { aggregateStats, computeStreaks, localDateOf, normalizeTzOffset, parseCreatedAt } from "../src/stats";

const TZ = 480; // Asia/Shanghai
const NOW = Date.parse("2026-08-09T06:00:00Z"); // 2026-08-09 14:00 +08:00

function row(createdAt: string, over: Partial<{ category: string | null; source: string; tags: string; is_sensitive: number }> = {}) {
  return {
    created_at: createdAt,
    category: "idea" as string | null,
    source: "web",
    tags: "[]",
    is_sensitive: 0,
    ...over,
  };
}

describe("normalizeTzOffset", () => {
  it("defaults to +480 and clamps extremes", () => {
    expect(normalizeTzOffset(undefined)).toBe(480);
    expect(normalizeTzOffset("abc")).toBe(480);
    expect(normalizeTzOffset("-300")).toBe(-300);
    expect(normalizeTzOffset("99999")).toBe(840);
    expect(normalizeTzOffset("-99999")).toBe(-720);
  });
});

describe("parseCreatedAt / localDateOf", () => {
  it("treats D1 'YYYY-MM-DD HH:MM:SS' as UTC and shifts by tz", () => {
    const ms = parseCreatedAt("2026-08-08 20:00:00");
    expect(localDateOf(ms, 480)).toBe("2026-08-09"); // 20:00 UTC = next day +08:00
    expect(localDateOf(ms, 0)).toBe("2026-08-08");
  });
});

describe("computeStreaks", () => {
  it("finds current and longest runs", () => {
    const days = ["2026-08-09", "2026-08-08", "2026-08-07", "2026-08-04", "2026-08-03", "2026-08-02", "2026-08-01"];
    expect(computeStreaks(days, "2026-08-09")).toEqual({ current: 3, longest: 4 });
  });

  it("keeps a streak alive when today has no note yet", () => {
    expect(computeStreaks(["2026-08-08", "2026-08-07"], "2026-08-09")).toEqual({ current: 2, longest: 2 });
  });

  it("is 0 when the last note is 2+ days ago", () => {
    expect(computeStreaks(["2026-08-06"], "2026-08-09")).toEqual({ current: 0, longest: 1 });
  });

  it("handles empty input", () => {
    expect(computeStreaks([], "2026-08-09")).toEqual({ current: 0, longest: 0 });
  });
});

describe("aggregateStats", () => {
  it("counts daily notes in the local timezone", () => {
    const stats = aggregateStats(
      [row("2026-08-08 20:00:00"), row("2026-08-08 10:00:00"), row("2026-08-09 01:00:00")],
      0,
      { days: 365, tzOffset: TZ, now: NOW }
    );
    // 20:00 UTC on 08-08 and 01:00 UTC on 08-09 are both 08-09 in +08:00
    expect(stats.daily).toEqual([
      { date: "2026-08-08", count: 1 },
      { date: "2026-08-09", count: 2 },
    ]);
    expect(stats.total_notes).toBe(3);
  });

  it("limits the heatmap window to `days` but streaks use all history", () => {
    const stats = aggregateStats(
      [row("2020-01-01 04:00:00"), row("2026-08-09 01:00:00")],
      0,
      { days: 30, tzOffset: TZ, now: NOW }
    );
    expect(stats.daily).toEqual([{ date: "2026-08-09", count: 1 }]);
    expect(stats.streak).toEqual({ current: 1, longest: 1 });
    expect(stats.total_notes).toBe(2);
  });

  it("builds category/source distributions sorted by count", () => {
    const stats = aggregateStats(
      [
        row("2026-08-09 01:00:00", { category: "todo", source: "wechat" }),
        row("2026-08-09 01:00:00", { category: "todo", source: "web" }),
        row("2026-08-09 01:00:00", { category: null, source: "web" }),
      ],
      5,
      { days: 365, tzOffset: TZ, now: NOW }
    );
    expect(stats.categories).toEqual([
      { category: "todo", count: 2 },
      { category: "pending", count: 1 },
    ]);
    expect(stats.sources).toEqual([
      { source: "web", count: 2 },
      { source: "wechat", count: 1 },
    ]);
    expect(stats.thread_count).toBe(5);
  });

  it("keeps sensitive notes in counts but their tags out of top_tags", () => {
    const stats = aggregateStats(
      [
        row("2026-08-09 01:00:00", { tags: '["产品"]' }),
        row("2026-08-09 01:00:00", { tags: '["密码","产品"]', is_sensitive: 1 }),
        row("2026-08-09 01:00:00", { tags: "not-json" }),
      ],
      0,
      { days: 365, tzOffset: TZ, now: NOW }
    );
    expect(stats.total_notes).toBe(3);
    expect(stats.top_tags).toEqual([{ tag: "产品", count: 1 }]);
  });

  it("never surfaces the 示例 sample tag", () => {
    const stats = aggregateStats(
      [row("2026-08-09 01:00:00", { tags: '["示例","想法"]' })],
      0,
      { days: 365, tzOffset: TZ, now: NOW }
    );
    expect(stats.top_tags).toEqual([{ tag: "想法", count: 1 }]);
  });
});
