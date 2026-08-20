// R212（audit-r211）：
// P2-1 语音转写严重错误静默入库——共享启发式质量信号（乱码率/循环重复/
//      纠错改动过大/长音频无文字）∪ 纠错模型语义自评，低置信只打
//      transcript_suspect 标记（前端提示+纠错入口），绝不拦截入库。
// P2-2 记录/已完成类错分待办——demoteEventLog 系统性补形态（「已+动词」、
//      结论/审批类已闭环记录降 data），真实未来动作不受影响。
// P3-1 负数明细行含「到账」等收入词不得阻断台账净额方向仲裁。
// P3-2 「退款负数 + 合计」两段式短句方向按合计符号收口。
// P3-3 图片文字识别存疑（视觉自评「清晰：否」）→ meta.ocr_suspect。
import { describe, it, expect } from "vitest";
import {
  garbledRatio,
  bigramSimilarity,
  isTranscriptSuspectHeuristic,
  parseImageExtraction,
  imageNoteFields,
} from "../src/media";
import {
  demoteEventLog,
  fixLedgerNetDirection,
  fixProseTotalDirection,
  fixAaReimburse,
} from "../src/triage";
import type { TriageResult } from "../src/types";

const t = (category: TriageResult["category"], extra: Partial<TriageResult> = {}): TriageResult => ({
  category,
  title: null,
  tags: [],
  todo_due: null,
  is_sensitive: false,
  amount: null,
  currency: null,
  ...extra,
});

describe("转写质量启发式 (R212 P2-1)", () => {
  it("正常中文转写不误伤", () => {
    const s = "今天下午买咖啡花了 35 块钱";
    expect(isTranscriptSuspectHeuristic(s, s, 60_000)).toBe(false);
  });
  it("正常英文/中英混合不误伤", () => {
    const s = "明天下午 3 点和 Bob 开会讨论 roadmap";
    expect(isTranscriptSuspectHeuristic(s, s, 60_000)).toBe(false);
  });
  it("循环重复片段（whisper 幻觉形态）判存疑", () => {
    const s = "谢谢观看谢谢观看谢谢观看谢谢观看谢谢观看";
    expect(isTranscriptSuspectHeuristic(s, s)).toBe(true);
  });
  it("乱码率异常判存疑", () => {
    const s = "今天ЖЖ§§ØØ乱码††¶¶测试";
    expect(garbledRatio(s)).toBeGreaterThan(0.15);
    expect(isTranscriptSuspectHeuristic(s, s)).toBe(true);
  });
  it("纠错前后差异过大＝原转写不可靠", () => {
    const raw = "提醒我们天气预报说有五十点的降雨量被李总打电话";
    const corrected = "提醒我带伞，天气预报说明天有大雨";
    expect(bigramSimilarity(raw, corrected)).toBeLessThan(0.45);
    expect(isTranscriptSuspectHeuristic(raw, corrected)).toBe(true);
  });
  it("轻度同音字纠错不判存疑", () => {
    const raw = "今天下午买咖啡花了三十五快钱";
    const corrected = "今天下午买咖啡花了三十五块钱";
    expect(isTranscriptSuspectHeuristic(raw, corrected)).toBe(false);
  });
  it("长音频几乎无文字判存疑；短音频短文字不误伤", () => {
    expect(isTranscriptSuspectHeuristic("嗯。", "嗯。", 500_000)).toBe(true);
    expect(isTranscriptSuspectHeuristic("好的", "好的", 20_000)).toBe(false);
  });
});

describe("图片识别清晰自评 (R212 P3-3)", () => {
  it("清晰：否 → ocr_suspect 进 meta", () => {
    const ex = parseImageExtraction("文字：会议室预定表 3F-2\n描述：白板照片\n敏感：否\n清晰：否");
    expect(ex.suspect).toBe(true);
    expect(imageNoteFields(ex).meta?.ocr_suspect).toBe(true);
  });
  it("清晰：是 → 不打标记", () => {
    const ex = parseImageExtraction("文字：会议室预定表 3F-2\n描述：白板照片\n敏感：否\n清晰：是");
    expect(ex.suspect).toBe(false);
    expect(imageNoteFields(ex).meta?.ocr_suspect).toBeUndefined();
  });
  it("清晰段缺失时 fail-open 按清晰处理（旧模型输出兼容）", () => {
    const ex = parseImageExtraction("文字：会议室预定表 3F-2\n描述：白板照片\n敏感：否");
    expect(ex.suspect).toBe(false);
  });
});

describe("完成式/记录类错分待办收口 (R212 P2-2)", () => {
  it("「已+动词」完成式降为 idea", () => {
    expect(demoteEventLog("物业费已交", t("todo")).category).toBe("idea");
    expect(demoteEventLog("回乘高铁票已买好", t("todo")).category).toBe("idea");
    expect(demoteEventLog("体检已预约好了", t("todo")).category).toBe("idea");
  });
  it("结论/审批类已闭环记录降为 data，即使模型给了 todo_due", () => {
    const r = demoteEventLog("评审会结论：接口方案通过，下周三前出正式文档", t("todo", { todo_due: "2026-08-26" }));
    expect(r.category).toBe("data");
    expect(r.todo_due).toBeNull();
    const r2 = demoteEventLog("拿到年假审批，9 月 10 号到 14 号", t("todo", { todo_due: "2026-09-10" }));
    expect(r2.category).toBe("data");
  });
  it("完成句 + 真实未来动作保持 todo", () => {
    expect(demoteEventLog("报告写完了，提醒我明天发给老板", t("todo", { todo_due: "2026-08-21" })).category).toBe("todo");
    expect(demoteEventLog("方案通过了，我负责下周三前出正式文档", t("todo", { todo_due: "2026-08-26" })).category).toBe("todo");
  });
  it("非 todo 分类不受影响", () => {
    expect(demoteEventLog("物业费已交 1200", t("expense", { amount: 1200 })).category).toBe("expense");
  });
});

describe("负数明细行收入词不阻断净额仲裁 (R212 P3-1)", () => {
  it("「报销到账,-200」负数行的到账不算整表收入证据", () => {
    const r = fixLedgerNetDirection("部门团购\n零食,300\n饮料,150\n报销到账,-200", t("income", { amount: 250 }));
    expect(r.category).toBe("expense");
    expect(r.amount).toBe(250);
  });
  it("标题/正向行的收入证据仍然生效（收入向台账不误纠）", () => {
    const r = fixLedgerNetDirection("回款台账\n项目款,8000\n客户退款,-500", t("income", { amount: 7500 }));
    expect(r.category).toBe("income");
  });
});

describe("两段式退款+合计短句方向 (R212 P3-2)", () => {
  it("「纪念品退款 -30，合计 224」按合计符号纠为 expense", () => {
    const r = fixProseTotalDirection("纪念品退款 -30，合计 224", t("income", { amount: 224 }));
    expect(r.category).toBe("expense");
    expect(r.amount).toBe(224);
  });
  it("含收入证据词时不纠（模型主判不被推翻）", () => {
    const r = fixProseTotalDirection("货款到账 -30 手续费，合计 224", t("income", { amount: 224 }));
    expect(r.category).toBe("income");
  });
  it("无退款负数段的普通收入不受影响", () => {
    expect(fixProseTotalDirection("卖二手书合计 224", t("income", { amount: 224 })).category).toBe("income");
  });
});

describe("AA/垫付收回是收入不是平移 (R212)", () => {
  it("「公司团建 AA 收回 240」→ income", () => {
    expect(fixAaReimburse("公司团建 AA 收回 240", t("transfer", { amount: 240 })).category).toBe("income");
  });
  it("普通借还往来仍是 transfer", () => {
    expect(fixAaReimburse("表弟把上次借的 1500 还给我了", t("transfer", { amount: 1500 })).category).toBe("transfer");
  });
});
