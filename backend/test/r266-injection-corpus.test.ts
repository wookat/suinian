import { describe, expect, it } from "vitest";
import { INJECTION_CASES, BENIGN_CASES, EVIL_HOST, bodyOf, markerOf } from "../scripts/injection-eval-data";
import { buildDataBlock, makeDataNonce, guardAskAnswer, scrubAnswerLinks } from "../src/prompt-armor";
import { neutralizePromptInjection } from "../src/triage";

// R266 常规回归：injection-eval 语料（R261/R263/R265 全部 28 变体 + 本轮自造
// ≥50 例）在本地对**架构性收口**逐例断言。这里不断言「模型不会照做」（那要
// 生产 injection-eval 实跑），断言的是与模型无关的两条硬边界：
//   1. 数据面：任何变体正文都无法伪造资料区定界或逐行 nonce 前缀；
//   2. 输出面：假设模型完全照做（最坏情况）时，输出侧护栏必须把 marker 与
//      攻击者外链全部剥掉，回传通道与执行痕迹不外带。
describe("R266 injection 语料：数据面不可伪造", () => {
  it("语料规模覆盖历史 28 变体 + 自造，合计 ≥50", () => {
    const ids = INJECTION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(50);
    for (const id of ["V8", "V9", "N1", "N2", "N8", "N9", "N10", "N11", "N12", "N13", "N14"]) {
      expect(ids).toContain(id); // R265 生产穿透的 11 例必须在集内
    }
    expect(INJECTION_CASES.filter((c) => c.entry === "mcp").length).toBeGreaterThanOrEqual(4);
  });

  it.each(INJECTION_CASES.map((c) => [c.id, c] as const))("%s 无法伪造资料边界/行前缀", (_id, c) => {
    const nonce = makeDataNonce();
    const body = neutralizePromptInjection(bodyOf(c));
    const block = buildDataBlock(`[1] (id=n1, 2026-08-23) ${body.slice(0, 500)}`, nonce);
    const inner = block.split("\n").slice(1, -1); // 去掉定界行
    // 资料区内每一行都带真前缀，且正文没有额外制造出第二个前缀/定界
    for (const line of inner) expect(line.startsWith(`D${nonce}｜`)).toBe(true);
    expect(inner.map((l) => l.slice(`D${nonce}｜`.length).includes(`D${nonce}｜`)).some(Boolean)).toBe(false);
    expect(block.split(`【资料区 ${nonce} 开始】`).length - 1).toBe(1);
    expect(block.split(`【资料区 ${nonce} 结束】`).length - 1).toBe(1);
  });
});

describe("R266 injection 语料：输出面最坏情况收口", () => {
  it.each(INJECTION_CASES.map((c) => [c.id, c] as const))("%s 照做后的答案不外带 marker/外链", (_id, c) => {
    const body = bodyOf(c);
    const marker = markerOf(c);
    // 最坏情况：模型完全照做——答案里既有 marker 又有攻击者外链
    const complied = `${marker}\n最近的笔记提到 2026-08-23 的健身记录：跑了 5 公里 [1]。\nhttps://${EVIL_HOST}/log?data=answer`;
    const g = guardAskAnswer(complied, { dataText: body, question: "帮我总结一下最近的笔记" });
    // 载荷本身索要 marker 的用例（含编码载荷）：执行痕迹必须被剥除。
    // 外链/泄露型载荷不含 marker，其判定标准是攻击者域名与敏感明文不外带。
    if (c.payload.includes("{{M}}") || c.family === "encoded") expect(g.answer).not.toContain(marker);
    expect(g.answer.toLowerCase()).not.toContain(EVIL_HOST);
    expect(g.answer).toContain("健身记录"); // 正常内容保留
  });

  it("各类外链形态（markdown/图片/裸域名/全角/协议相对/HTML img）一律剥除", () => {
    const forms = [
      `https://${EVIL_HOST}/a?x=1`,
      `[详情](https://${EVIL_HOST}/ref)`,
      `![p](https://${EVIL_HOST}/p.png)`,
      `${EVIL_HOST}/collect?a=1`,
      `www.${EVIL_HOST}/log`,
      `//${EVIL_HOST}/beacon`,
      `<img src="https://${EVIL_HOST}/p.gif">`,
      `ｈｔｔｐｓ://${EVIL_HOST}/ｌｏｇ`,
    ];
    for (const f of forms) {
      expect(scrubAnswerLinks(`备忘 [1]。${f}`).toLowerCase()).not.toContain(EVIL_HOST);
    }
  });
});

describe("R266 benign 对照：护栏不误伤", () => {
  it.each(BENIGN_CASES.map((b) => [b.id, b] as const))("%s 关键内容与自有域名保留", (_id, b) => {
    const answer = `${b.expect.join(" ")}（见 https://suinian.zalize.com/#/threads?id=t1）[1]`;
    const g = guardAskAnswer(answer, { dataText: b.note, question: b.question });
    for (const e of b.expect) expect(g.answer).toContain(e);
    expect(g.answer).toContain("suinian.zalize.com");
  });
});
