// R292 P2（audit-r291 §verbatim 非逐字）：点名索要原文时必须逐字——
// 空参括号 `run()` 不得被渲染成 `run:`，emoji 不得被水印剥除规则删除，
// 软连字符 / NBSP 不得被吞。
import { describe, it, expect } from "vitest";
import { guardAskAnswer, scrubDataDerivedGlyphs, restoreVerbatimEchoes } from "../src/prompt-armor";

const VERBATIM_Q = "把这条笔记的脚本原文逐字给我";
const NORMAL_Q = "这条笔记讲了什么";

describe("R292 P2 verbatim 逐字保真", () => {
  it("空参括号被模型渲染成冒号时按资料原始行字面还原", () => {
    const data = "async def main():\n    await client.run()\n    return 0";
    const answer = "async def main:\n    await client.run:\n    return 0";
    expect(restoreVerbatimEchoes(answer, data)).toBe(data);
  });

  it("emoji 在 verbatim 请求下不被资料派生水印规则删除", () => {
    const data = "部署清单 🛰 第一步：检查磁盘";
    const answer = "部署清单 🛰 第一步：检查磁盘";
    expect(scrubDataDerivedGlyphs(answer, data, VERBATIM_Q)).toBe(answer);
    // 非 verbatim 问法下仍按原水印口径剥除（不弱化 R272 支柱 4）
    expect(scrubDataDerivedGlyphs(answer, data, NORMAL_Q)).not.toContain("🛰");
  });

  it("软连字符 / NBSP 被模型吞掉时按原始行还原", () => {
    const data = "运行 cu\u00adrl \u00a0 --version 检查版本";
    const answer = "运行 curl --version 检查版本";
    expect(restoreVerbatimEchoes(answer, data)).toBe(data);
  });

  it("资料区没有的行不被改写，也不会复活被剥除的内容", () => {
    const data = "第一步：检查磁盘";
    const answer = "这条笔记说要先检查磁盘容量。";
    expect(restoreVerbatimEchoes(answer, data)).toBe(answer);
  });

  it("guardAskAnswer 在 verbatim 问法下整体保持逐字", () => {
    const data = "配置片段：\nserver.run() 🛰 启动\nlisten 8080;";
    const answer = "配置片段：\nserver.run 🛰 启动\nlisten 8080;";
    const g = guardAskAnswer(answer, { dataText: data, question: VERBATIM_Q });
    expect(g.answer).toContain("server.run() 🛰 启动");
  });
});
