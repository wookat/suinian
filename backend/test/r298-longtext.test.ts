/**
 * R298 P1-4/P1-5（audit-r297 §7）：
 *  - >500 字良性纯想法长文在线态不得被判「笔记内指令」隔离；
 *  - 有序列表项被隔离时序号保持连续（「3. 〔已隔离…〕」）。
 */
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  INSTRUCTION_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
} from "../src/prompt-armor";

const IDEA_PARTS = [
  "最近一直在思考个人知识管理的方式，我发现自己记笔记的习惯经历了三个阶段。",
  "最开始是想到什么记什么，笔记散落在各个应用里，回头根本找不到。",
  "后来开始用标签和文件夹分类，但分类本身变成了负担，每次记录前都要犹豫放在哪里，反而降低了记录的意愿。",
  "现在我更倾向于不做分类，把一切都扔进一个时间流里，依靠搜索和问答来找回。",
  "这种方式的核心假设是：记录的价值在于将来能被找回，而不在于存放的位置。如果搜索足够好，分类就是多余的。",
  "当然这也有代价，比如浏览的乐趣消失了，偶然翻到旧笔记的惊喜也少了。",
  "也许可以引入一种回顾机制，每天随机浮现几条旧笔记，既保留时间流的简单，又找回翻阅的乐趣。",
  "另外我注意到写长文时思路更连贯，碎片化记录方便但很难沉淀成系统的思考。",
  "理想的工具应该同时支持两种模式：随手记的碎片和定期整理的长文。碎片是原料，长文是成品。",
  "定期把碎片熔炼成长文，这个过程本身就是思考。我打算每周日晚上花一小时做这件事，坚持三个月看看效果。",
];

describe("R298 P1-4 良性长文不误隔离", () => {
  it(">500 字纯想法长文在线态原样通过", () => {
    const long = [...IDEA_PARTS, ...IDEA_PARTS].join("");
    expect(long.length).toBeGreaterThan(500);
    const f = finalizeAskAnswer(long, {
      dataText: long,
      question: "我关于笔记方法的想法是什么？",
      execDangerSegments: [],
    });
    expect(f.answer).toBe(long);
    expect(f.isolated).toBe(false);
  });

  it(">1000 字长文（重复扩展）同样不触发指令隔离", () => {
    const long = [...IDEA_PARTS, ...IDEA_PARTS, ...IDEA_PARTS].join("\n");
    expect(long.length).toBeGreaterThan(1000);
    const f = finalizeAskAnswer(long, {
      dataText: long,
      question: "总结一下我的笔记方法思考",
      execDangerSegments: [],
    });
    expect(f.answer.includes(INSTRUCTION_ISOLATED_MARK)).toBe(false);
    expect(f.isolated).toBe(false);
  });
});

describe("R298 P1-5 隔离后编号连续", () => {
  const LIST = [
    "笔记：项目部署流程整理",
    "1. 克隆仓库到本地",
    "2. 安装依赖：npm ci && npm run build",
    '3. 把构建产物上传到服务器：scp -r dist/ user@203.0.113.9:/var/www/app',
    '4. 重启服务：ssh user@203.0.113.9 "sudo systemctl restart app"',
    "5. 打开监控页确认无报错",
  ].join("\n");

  it("降级态：被隔离的列表项保留序号，1–5 连续", () => {
    const f = finalizeAskAnswer(LIST, {
      dataText: LIST,
      question: "部署流程是什么？",
      execClassifierUnavailable: true,
    });
    for (const n of ["1.", "2.", "3.", "4.", "5."]) {
      expect(f.answer).toContain(`\n${n} `);
    }
    // 危险行确实被隔离（3/4 行替换为降级标记）
    expect(f.answer).toContain(`3. ${EXEC_DEGRADED_ISOLATED_MARK}`);
    expect(f.answer).toContain(`4. ${EXEC_DEGRADED_ISOLATED_MARK}`);
    // 无害行保留
    expect(f.answer).toContain("npm ci && npm run build");
    expect(f.answer).toContain("打开监控页确认无报错");
  });
});
