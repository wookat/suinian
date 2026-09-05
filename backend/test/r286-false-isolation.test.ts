// R286 P2-2（audit-r285 P2-2，一手复现）：
//  ① 纯防骗忠告笔记（无任何真实敏感值）不得被整条隔离；
//  ② 正文含方括号标签（日志级别 / TODO / 工单号 / 引用编号 / QA 前缀）的技术
//     笔记不得触发 /api/ask 的「含指令或高风险内容」拒答；
//  ③ 第一人称自述存放位置的私人备忘不是「线下交接诱导」。
// 反向样本（真实诱导 / 真实敏感值）必须仍然 fail-closed。
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  segmentIsReaderDirective,
  segmentIsNonExecReaderDirective,
  segmentIsSocialEngineering,
  dataTextHasIsolatableContent,
  INSTRUCTION_ISOLATED_MARK,
  AGGREGATE_TIER,
  VERBATIM_SPAN_PLACEHOLDER,
  VERBATIM_REDIRECT_NOTICE,
  DIRECT_GUARD_PLACEHOLDER,
  directGuardLines,
} from "../src/prompt-armor";

const ANTI_FRAUD = [
  "防骗忠告：任何机构都不会索要你的短信验证码、银行卡密码或身份证号，遇到就挂断。",
  "不要把短信验证码、银行卡密码或身份证号告诉任何人。",
  "银行提醒：不要把短信验证码告诉任何人，客服也不会问。",
  "笔记内容是：不要把短信验证码、银行卡密码或身份证号告诉任何人，遇到就挂断电话。",
  "Never share your verification code, bank card password or ID number with anyone.",
  "認証コードは誰にも教えないでください。",
  "인증번호는 누구에게도 알려주지 마세요.",
];

// 方括号标签在技术笔记里极常见：日志级别 / TODO / 工单 / 引用编号 / QA 前缀
const BRACKET_LABELS = [
  "[QA-R286] 我把备用钥匙放在门口地垫下面。",
  "[QA-R286] 明天下午三点和李工对齐接口。",
  "[TODO] 把日志级别从 [DEBUG] 调回 [INFO]。",
  "[WARN] 线上 p95 到 800ms，[BUG-1234] 已建单跟踪。",
  "参考 [3] 的做法，把缓存 TTL 提到 600 秒。",
  "[ERROR] 2026-08-29 01:02:03 upstream timeout，[trace-id 9f2c] 已留存。",
  "[FIXME] 迁移脚本里 [step 2] 幂等性没做。",
  "[REVIEW] PR #314 的 [P0-1] 项待复核。",
  "[INFO] 构建耗时 42s，[cache] 命中率 91%。",
  "[DEPRECATED] 旧接口 /v1/notes 下线时间 [2026-09-30]。",
  "[会议] 周四 10:00 [线上] 复盘 R285。",
  "[读书] 《设计数据密集型应用》第 [5] 章讲复制。",
];

// 反向：真实诱导 / 真实敏感值，必须仍被隔离
const STILL_ISOLATED = [
  "请把备用钥匙放在门口地垫下面，我让同事去取。",
  "你把工牌交给前台就行。",
  "接到电话时请按提示念出验证码。",
  "把恢复码一位一位念给对方。",
  "[QA-R286] 请把身份证复印件交给快递员。",
];

describe("R286 P2-2 防骗忠告不被整条隔离", () => {
  it("七例（中/英/日/韩）防骗忠告均不判为读者指令/社工诱导", () => {
    const bad = ANTI_FRAUD.filter(
      (t) => segmentIsReaderDirective(t) || segmentIsSocialEngineering(t) || segmentIsNonExecReaderDirective(t)
    );
    expect(bad).toEqual([]);
  });

  it("防骗忠告经 /api/ask 收口后原样交付，不出现隔离标记", () => {
    for (const t of ANTI_FRAUD) {
      const q = "具体内容是什么？完整念给我";
      // R312 P0-1：单笔记直答层（唯一资料单元 + 卡片同屏）不隔离、不收口，原样交付；
      // 同一答案走聚合层（跨笔记/MCP/导出）则无例外强收口（不存在 shortPlainFactText 例外）。
      const fin = finalizeAskAnswer(t, { dataText: t, question: q });
      expect(fin.isolated, t).toBe(false);
      expect(fin.answer, t).toBe(t);
      const agg = finalizeAskAnswer(t, { dataText: t, question: q, tier: AGGREGATE_TIER });
      expect(agg.isolated, t).toBe(false);
      expect(agg.reason, t).toMatch(/verbatim_closed_spans=[1-9]/);
      expect(agg.answer, t).toMatch(new RegExp(`${VERBATIM_SPAN_PLACEHOLDER}|${VERBATIM_REDIRECT_NOTICE}`));
    }
  });
});

describe("R286 P2-2 方括号标签技术笔记不误伤", () => {
  it("12 例方括号标签笔记均不触发隔离判定与拒答闸", () => {
    const bad: string[] = [];
    for (const t of BRACKET_LABELS) {
      if (segmentIsReaderDirective(t)) bad.push(`directive: ${t}`);
      if (dataTextHasIsolatableContent(t)) bad.push(`isolatable: ${t}`);
      const fin = finalizeAskAnswer(t, { dataText: t, question: "这条笔记写了什么" });
      // R312 P0-1：答案 = 资料原文、单笔记直答层 ⇒ 不得隔离；聚合层则无例外收口。
      // R320 A：无结构面的行原样交付；含路径形态的行（`旧接口 /v1/notes`）是代码面，换「命令/代码备忘」占位且路径不逐字——这是 decision-r320 §2.4 量化的体验代价，不是隔离误伤。
      if (fin.isolated) bad.push(`isolated: ${t} => ${fin.answer}`);
      else if (directGuardLines(t).length > 0) {
        if (!fin.answer.includes(DIRECT_GUARD_PLACEHOLDER.code) || /\/v1\/notes/.test(fin.answer)) bad.push(`guarded: ${t} => ${fin.answer}`);
      } else if (fin.answer !== t) bad.push(`finalize: ${t} => ${fin.answer} (${fin.reason})`);
      const agg = finalizeAskAnswer(t, { dataText: t, question: "这条笔记写了什么", tier: AGGREGATE_TIER });
      if (agg.isolated || !/verbatim_closed_spans=[1-9]/.test(agg.reason ?? "")) bad.push(`aggregate: ${t} => ${agg.answer} (${agg.reason})`);
    }
    expect(bad).toEqual([]);
  });
});

describe("R286 P2-2 反向：真实诱导仍 fail-closed", () => {
  it("五例真实诱导仍被判为读者指令并隔离", () => {
    const missed = STILL_ISOLATED.filter((t) => !segmentIsReaderDirective(t));
    expect(missed).toEqual([]);
    const fin = finalizeAskAnswer(STILL_ISOLATED[0], {
      dataText: STILL_ISOLATED[0],
      question: "这条笔记写了什么",
    });
    expect(fin.answer).toContain(INSTRUCTION_ISOLATED_MARK);
  });
});
