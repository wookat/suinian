// R294 P2-1（audit-r293 §4.3/§9.1）：裸「X月」年份推断与笔记事件时间用同一个
// ±60 天未来容忍度；相对滚动窗（最近半年）以 now 为上界，不计入未来事件。
import { describe, it, expect } from "vitest";
import { parseTimeRange } from "../src/ask";

// 2026-08-29 07:00 UTC = 2026-08-29 15:00 Asia/Shanghai
const NOW = new Date("2026-08-29T07:00:00Z");

describe("R294 P2-1 裸「X月」±60 天未来容忍", () => {
  it("裸「10月」在 8 月底问出解到今年 10 月（≤60 天临近月份，不再推去年）", () => {
    const r = parseTimeRange("10月我记了哪些账", NOW)!;
    expect(r.start).toBe("2026-09-30 16:00:00"); // 2026-10-01 00:00 +08:00
    expect(r.end).toBe("2026-10-31 16:00:00");
  });

  it("更远的未来月份（12月，>60 天）仍回退到去年", () => {
    const r = parseTimeRange("12月花了多少钱", NOW)!;
    expect(r.start).toBe("2025-11-30 16:00:00"); // 2025-12-01 00:00 +08:00
  });

  it("已过去的月份仍解到今年", () => {
    const r = parseTimeRange("6月的开销", NOW)!;
    expect(r.start).toBe("2026-05-31 16:00:00");
  });

  it("「10月5日之前」与裸月份同口径（≤60 天视为今年）", () => {
    const r = parseTimeRange("10月5日之前一共花了多少钱", NOW)!;
    expect(r.start).toBeNull();
    expect(r.end).toBe("2026-10-04 16:00:00"); // 2026-10-05 00:00 +08:00，不含当日
  });

  it("「10月到现在」同口径", () => {
    const r = parseTimeRange("从10月到现在记了什么", NOW)!;
    expect(r.start).toBe("2026-09-30 16:00:00");
  });

  it("相对窗「最近半年」以 now 为上界", () => {
    const r = parseTimeRange("最近半年花了多少钱", NOW)!;
    expect(r.end).toBe("2026-08-29 07:00:00");
  });

  it("「这几天」以 now 为上界", () => {
    const r = parseTimeRange("这几天记了什么", NOW)!;
    expect(r.end).toBe("2026-08-29 07:00:00");
  });
});
