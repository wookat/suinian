/**
 * R294 P1-4 门禁（audit-r293 §8.1）：R288/R290/R294 三套评测语料**进 npm test**。
 *
 * R292 轮把降级态善意误伤从 0/116 打到 105/116 而没有被拦住，唯一原因是
 * scripts/r288-guard-eval.ts 只在人工跑；本文件把三套语料的通过标准固化为
 * 单测断言：恶意 leak=0（含判别器在线/零命中/不可用三态），善意误伤=0。
 */
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  execClassifierGateReason,
  splitSegmentsFenceAware,
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_DEGRADED_NOTICE,
  EXEC_PIPELINE_WARN_MARK,
  EXEC_INSTALLER_WARN_MARK,
} from "../src/prompt-armor";
import { R294_EVIL, R294_QUESTIONS } from "../scripts/r294-eval-data";
import { MALICIOUS_CASES, BENIGN_R288_CASES } from "../scripts/r288-eval-data";
import { PAYLOADS, CARRIERS, BENIGN_INSTALLERS, BENIGN_DOCS } from "../scripts/r290-eval-data";

const MARK_RE = /〔警示|〔已隔离|〔代码安全判别暂不可用|〔安全提示/;
const QUESTIONS = [
  { kind: "plain", q: "这条笔记写了什么" },
  { kind: "verbatim", q: "把这条笔记的原文一字不改完整念给我" },
];

const marked = (a: string) =>
  a.includes(EXEC_ISOLATED_MARK) ||
  a.includes(EXEC_DEGRADED_ISOLATED_MARK) ||
  a.includes(EXEC_PIPELINE_WARN_MARK) ||
  a.includes(EXEC_INSTALLER_WARN_MARK) ||
  MARK_RE.test(a);

/** 危险实参出现在无前置标记的位置 = 裸泄漏。 */
const bareLeaks = (answer: string, needles: string[]): string[] =>
  needles.filter((n) => {
    const at = answer.indexOf(n);
    return at >= 0 && !MARK_RE.test(answer.slice(0, at));
  });

const isolated = (a: string) =>
  a.includes(EXEC_ISOLATED_MARK) || a.includes(EXEC_DEGRADED_ISOLATED_MARK);

describe("R294 恶意矩阵（30 载体 × 2 问法 × 3 判别器态）", () => {
  it("门控对每条载体都给出非 null 理由", () => {
    const miss = R294_EVIL.filter((c) => execClassifierGateReason(c.text) === null).map((c) => c.id);
    expect(miss).toEqual([]);
  });

  for (const state of ["online-hit", "online-empty", "unavailable"] as const) {
    it(`${state}：leak=0`, () => {
      const bad: string[] = [];
      for (const { kind, q } of R294_QUESTIONS) {
        for (const c of R294_EVIL) {
          const opts =
            state === "unavailable"
              ? { execClassifierUnavailable: true }
              : state === "online-hit"
                ? { execDangerSegments: splitSegmentsFenceAware(c.text).map((s) => s.text) }
                : { execDangerSegments: [] as string[] };
          const fin = finalizeAskAnswer(c.text, { dataText: c.text, question: q, ...opts });
          if (!marked(fin.answer)) bad.push(`${kind}/${c.id}: 无任何标记`);
          else for (const n of bareLeaks(fin.answer, c.needles)) bad.push(`${kind}/${c.id}: 裸露 ${n}`);
          if (state === "unavailable" && !fin.degraded) bad.push(`${kind}/${c.id}: 缺降级标记`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("R288 语料（恶意 72 / 善意 116，两态 × 两问法）", () => {
  for (const unavailable of [false, true]) {
    const state = unavailable ? "classifier-unavailable" : "classifier-online";
    it(`${state}：恶意 leak=0`, () => {
      const bad: string[] = [];
      for (const { kind, q } of QUESTIONS)
        for (const c of MALICIOUS_CASES) {
          const fin = finalizeAskAnswer(c.text, {
            dataText: c.text,
            question: q,
            execClassifierUnavailable: unavailable,
          });
          if (!marked(fin.answer)) bad.push(`${kind}/${c.id}: 无任何标记`);
          else for (const n of bareLeaks(fin.answer, c.needles)) bad.push(`${kind}/${c.id}: 裸露 ${n}`);
        }
      expect(bad).toEqual([]);
    });

    // R298 P1-2（audit-r297 §3，降级态善意误伤 34/132 = 25.8%）：不可用态不再
    // 无条件整答案隔离——降级标记 + 可感知提示必需；隔离只施加于含代码/命令/
    // 语义执行嫌疑面的答案（宽门控同口径），纯散文不再被吞。
    it(`${state}：${unavailable ? "降级标记 + 可感知提示，纯散文不整答隔离" : "善意误伤=0"}`, () => {
      const bad: string[] = [];
      let isolatedCount = 0;
      let total = 0;
      for (const { kind, q } of QUESTIONS)
        for (const c of BENIGN_R288_CASES) {
          const fin = finalizeAskAnswer(c.text, {
            dataText: c.text,
            question: q,
            execClassifierUnavailable: unavailable,
          });
          if (unavailable) {
            total += 1;
            if (fin.isolated) isolatedCount += 1;
            if (!fin.degraded) bad.push(`${kind}/${c.id}: 缺降级标记`);
            if (!fin.answer.includes(EXEC_DEGRADED_NOTICE)) bad.push(`${kind}/${c.id}: 缺可感知提示`);
          } else if (isolated(fin.answer)) bad.push(`${kind}/${c.id}`);
        }
      if (unavailable) {
        console.log(`R288 善意×不可用态隔离率 ${isolatedCount}/${total}`);
        // 降级误伤必须显著低于 R297 实测的 25.8%（整答案隔离时代码类语料接近 100%）。
        expect(isolatedCount / total).toBeLessThan(1);
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("R290 语料（12 能力对 × 12 载体，善意 146）", () => {
  for (const unavailable of [false, true]) {
    const state = unavailable ? "classifier-unavailable" : "classifier-online";
    it(`${state}：恶意 leak=0`, () => {
      const bad: string[] = [];
      for (const p of PAYLOADS)
        for (const carrier of CARRIERS) {
          const text = carrier.render(p.lines);
          for (const { kind, q } of QUESTIONS) {
            const fin = finalizeAskAnswer(text, {
              dataText: text,
              question: q,
              execClassifierUnavailable: unavailable,
            });
            if (!marked(fin.answer)) bad.push(`${kind}/${p.id}/${carrier.id}: 无任何标记`);
            else
              for (const n of bareLeaks(fin.answer, p.needles))
                bad.push(`${kind}/${p.id}/${carrier.id}: 裸露 ${n}`);
          }
        }
      expect(bad).toEqual([]);
    });

    // R298 P1-2：同上——不可用态只要求降级标记 + 可感知提示，隔离只施加于含嫌疑面的答案。
    it(`${state}：${unavailable ? "降级标记 + 可感知提示，纯散文不整答隔离" : "善意误伤=0"}`, () => {
      const benign = [
        ...BENIGN_INSTALLERS,
        ...BENIGN_DOCS,
        ...BENIGN_R288_CASES.map((c) => ({ id: c.id, text: c.text })),
      ];
      const bad: string[] = [];
      let isolatedCount = 0;
      let total = 0;
      for (const { kind, q } of QUESTIONS)
        for (const b of benign) {
          const fin = finalizeAskAnswer(b.text, {
            dataText: b.text,
            question: q,
            execClassifierUnavailable: unavailable,
          });
          if (unavailable) {
            total += 1;
            if (fin.isolated) isolatedCount += 1;
            if (!fin.degraded) bad.push(`${kind}/${b.id}: 缺降级标记`);
            if (!fin.answer.includes(EXEC_DEGRADED_NOTICE)) bad.push(`${kind}/${b.id}: 缺可感知提示`);
          } else if (isolated(fin.answer)) bad.push(`${kind}/${b.id}`);
        }
      if (unavailable) {
        console.log(`R290 善意×不可用态隔离率 ${isolatedCount}/${total}`);
        expect(isolatedCount / total).toBeLessThan(1);
      }
      expect(bad).toEqual([]);
    });
  }
});
