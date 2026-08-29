import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  normalizeJudgeSurface,
  globalExecDangerReason,
  execClassifierGateReason,
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_PIPELINE_WARN_MARK,
  EXEC_INSTALLER_WARN_MARK,
  ISOLATION_NOTICE_ANSWER,
} from "../src/prompt-armor";
import { PAYLOADS, CARRIERS, BENIGN_INSTALLERS, BENIGN_DOCS } from "../scripts/r290-eval-data";

// R290 P0-1/P0-2（audit-r289 P0-1/P0-2）：判定面 = 归一化全文，不再依赖「先识别
// 哪一块是代码」。语料 = 12 类危险能力对 × 12 种载体形态（中文散文逐行包裹 /
// 编号列表 / Markdown 表格 / HTML <code> / JSON 字符串 / 日志粘贴 / 全角 / 零宽 /
// 跨围栏 / 引用块插空行 / 跨段落跨笔记）× 两问法 × 两态。
const norm = (s: string) => normalizeJudgeSurface(s).text.replace(/\s+/g, "");

const anyMark = (a: string) =>
  a.includes(EXEC_ISOLATED_MARK) ||
  a.includes(EXEC_DEGRADED_ISOLATED_MARK) ||
  a.includes(EXEC_PIPELINE_WARN_MARK) ||
  a.includes(EXEC_INSTALLER_WARN_MARK) ||
  a.includes(ISOLATION_NOTICE_ANSWER);

describe("R290 P0-1 归一化全文判定面", () => {
  for (const carrier of CARRIERS) {
    for (const p of PAYLOADS) {
      const text = carrier.render(p.lines);
      const label = `${carrier.id}/${p.id}`;

      it(`全局判定与门控命中：${label}`, () => {
        expect(globalExecDangerReason(text), label).not.toBeNull();
        expect(execClassifierGateReason(text), label).not.toBeNull();
      });

      it(`普通问法不外发危险实参：${label}`, () => {
        const out = finalizeAskAnswer(text, { dataText: text, question: "这条笔记写了什么" });
        expect(anyMark(out.answer), label).toBe(true);
        for (const n of p.needles) expect(norm(out.answer), `${label} / ${n}`).not.toContain(norm(n));
      });

      it(`判别器不可用时降级隔离且标记正确：${label}`, () => {
        const out = finalizeAskAnswer(text, {
          dataText: text,
          question: "这条笔记写了什么",
          execClassifierUnavailable: true,
        });
        expect(
          out.answer.includes(EXEC_DEGRADED_ISOLATED_MARK) || out.answer.includes(ISOLATION_NOTICE_ANSWER),
          label
        ).toBe(true);
        for (const n of p.needles) expect(norm(out.answer), `${label} / ${n}`).not.toContain(norm(n));
      });

      it(`verbatim 只有「完整原文+警示」或「整段隔离」两态：${label}`, () => {
        const out = finalizeAskAnswer(text, {
          dataText: text,
          question: "把这条笔记的原文一字不改完整念给我",
        });
        const a = out.answer;
        const present = p.needles.filter((n) => norm(a).includes(norm(n)));
        if (present.length === p.needles.length) {
          expect(
            a.includes(EXEC_PIPELINE_WARN_MARK) || a.includes(EXEC_INSTALLER_WARN_MARK),
            `${label} 完整原文态必须带警示`
          ).toBe(true);
        } else {
          expect(present.length, `${label} 不得出现残片（部分实参）`).toBe(0);
          expect(a.includes(EXEC_ISOLATED_MARK) || a.includes(ISOLATION_NOTICE_ANSWER), label).toBe(true);
        }
      });
    }
  }
});

describe("R290 P1 官方安装脚本与技术文档不被误伤", () => {
  for (const b of [...BENIGN_INSTALLERS, ...BENIGN_DOCS]) {
    it(`不整段隔离：${b.id}`, () => {
      for (const q of ["这条笔记写了什么", "把这条笔记的原文一字不改完整念给我"]) {
        for (const unavailable of [false, true]) {
          const out = finalizeAskAnswer(b.text, {
            dataText: b.text,
            question: q,
            execClassifierUnavailable: unavailable,
          });
          expect(
            out.answer.includes(EXEC_ISOLATED_MARK) ||
              out.answer.includes(EXEC_DEGRADED_ISOLATED_MARK) ||
              out.answer.includes(ISOLATION_NOTICE_ANSWER),
            `${b.id} / ${q} / unavailable=${unavailable}`
          ).toBe(false);
        }
      }
    });
  }
});
