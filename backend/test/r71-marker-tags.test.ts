import { describe, it, expect } from "vitest";
import { leadingMarkers, stripMarkerNoise, FALLBACK_TRIAGE, buildTriagePrompt } from "../src/triage";
import type { TriageResult } from "../src/types";

function triage(tags: string[], title = ""): TriageResult {
  return { ...FALLBACK_TRIAGE, tags, title };
}

describe("leadingMarkers", () => {
  it("extracts [xxx] and 【xxx】 prefixes, including stacked ones", () => {
    expect(leadingMarkers("[QA-EVAL] 明天交报告")).toEqual(["QA-EVAL"]);
    expect(leadingMarkers("【草稿】重写文案")).toEqual(["草稿"]);
    expect(leadingMarkers("[QA-R71]【灵感】按月折叠")).toEqual(["QA-R71", "灵感"]);
  });

  it("ignores brackets that are not a leading prefix", () => {
    expect(leadingMarkers("看了《沙丘》[电影] 不错")).toEqual([]);
    expect(leadingMarkers("买牛奶")).toEqual([]);
  });
});

describe("stripMarkerNoise", () => {
  it("drops tags copying the leading marker (whole or partial)", () => {
    const out = stripMarkerNoise("[QA-EVAL] 明天交报告", triage(["QA-EVAL", "QA", "报告"]));
    expect(out.tags).toEqual(["报告"]);
  });

  it("strips the marker from the title", () => {
    const out = stripMarkerNoise("[P0] 修复登录超时", triage(["登录"], "[P0] 修复登录超时"));
    expect(out.title).toBe("修复登录超时");
    expect(out.tags).toEqual(["登录"]);
  });

  it("leaves notes without a leading marker untouched (normal #tags unaffected)", () => {
    const t = triage(["工作", "周报"], "周五交周报");
    expect(stripMarkerNoise("周五交周报 #工作 #周报", t)).toEqual(t);
  });
});

describe("triage prompt", () => {
  it("tells the model to ignore bracket prefix markers in tags and title", () => {
    const prompt = buildTriagePrompt();
    expect(prompt).toContain("方括号前缀标记");
    expect(prompt).toContain("不能把括号里的词抽出来当标签");
  });
});
