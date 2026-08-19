// R202（audit-r201）：
// P3-1 「是否为/是否是/是不是为 N 块钱」双动词验证式变体也走极值前提路径，
//      不再落 RAG 答非极值。
// P3-3 财务极值零命中且带时间短语时，明示「时间范围按笔记记录时间划定」
//      口径（沿袭 R199 P3-5 的口径差异可见化）。
// §1   SW 注册失败上报 beacon：公开端点、IP 限频、只收错误名称/消息。
import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import {
  financeExtremeIntent,
  financeExtremePremise,
  financeExtremeTopicTerms,
  buildFinanceExtremeAnswer,
} from "../src/ask";
import { buildTriagePrompt } from "../src/triage";

describe("验证式金额前提双动词变体 (R202 P3-1)", () => {
  it("「是否为 N 块钱」解析出前提（audit-r201 生产原文）", () => {
    expect(financeExtremePremise("最贵的一笔支出是否为 459 块钱")).toEqual({ amount: 459, currency: "CNY" });
  });
  it("「是否是/是不是为」变体同样解析", () => {
    expect(financeExtremePremise("最贵的一笔支出是否是 459 元")).toEqual({ amount: 459, currency: "CNY" });
    expect(financeExtremePremise("最贵的一笔支出是不是为 25 美元")).toEqual({ amount: 25, currency: "USD" });
    expect(financeExtremePremise("最贵支出是否为 368.5 元")).toEqual({ amount: 368.5, currency: "CNY" });
  });
  it("premise 随 financeExtremeIntent 返回且不产生主题词残渣", () => {
    const q = "我最贵的一笔支出是否为 459 块钱";
    expect(financeExtremeIntent(q)?.premise).toEqual({ amount: 459, currency: "CNY" });
    expect(financeExtremeTopicTerms(q)).toBeNull();
  });
  it("R200 既有变体不回归", () => {
    expect(financeExtremePremise("最贵的一笔支出是 400 元吗")).toEqual({ amount: 400, currency: "CNY" });
    expect(financeExtremePremise("最贵的一笔支出是不是 400")).toEqual({ amount: 400, currency: null });
    expect(financeExtremePremise("金额第 2 大的支出是哪笔")).toBeNull();
    expect(financeExtremePremise("2026年7月最贵的支出是哪笔")).toBeNull();
    expect(financeExtremePremise("最贵的一笔支出是多少钱")).toBeNull();
  });
});

describe("「最大收入/最小支出」无「一笔」的极值问法 (R202 生产 QA 回归修复)", () => {
  it("「本月最大收入是 4500 元吗」走精确极值路径且无主题词残渣", () => {
    const q = financeExtremeIntent("本月最大收入是 4500 元吗");
    expect(q).toMatchObject({ kind: "max", direction: "income", rank: 1 });
    expect(q?.premise).toEqual({ amount: 4500, currency: "CNY" });
    expect(financeExtremeTopicTerms("本月最大收入是 4500 元吗")).toBeNull();
  });
  it("「最小的支出是哪笔」同族收口", () => {
    expect(financeExtremeIntent("最小的支出是哪笔")).toMatchObject({ kind: "min", direction: "expense", rank: 1 });
    expect(financeExtremeTopicTerms("最小的支出是哪笔")).toBeNull();
  });
  it("非财务的「最高/最大」不误收（歧义保护不回归）", () => {
    expect(financeExtremeIntent("最高的山是哪座")).toBeNull();
  });
});

describe("财务极值零命中的时间口径明示 (R202 P3-3)", () => {
  const q = financeExtremeIntent("本月最大的一笔收入是 4500 元吗")!;
  it("带时间短语零命中时明示记录时间口径", () => {
    const md = buildFinanceExtremeAnswer(q, [], 0, "本月");
    expect(md).toContain("没有已识别出金额的单笔收入");
    expect(md).toContain("时间范围按笔记记录时间划定，不按正文里写的时间");
  });
  it("无时间短语零命中时不加口径说明", () => {
    const md = buildFinanceExtremeAnswer(q, [], 0, null);
    expect(md).not.toContain("时间范围按笔记记录时间划定");
  });
});

describe("分拣金额不按用量换算 (R202 P3-2)", () => {
  it("提示词包含用量不改变支付金额的规则与判例", () => {
    const p = buildTriagePrompt();
    expect(p).toContain("用量/份量/使用次数绝不改变支付金额");
    expect(p).toContain("一次用半瓶");
    expect(p).toContain("绝不是 12.5");
  });
});

/** 最小 fake D1：只覆盖 checkRateLimit 的 auth_rate_limits UPSERT。 */
function rateLimitOnlyDb() {
  const counts = new Map<string, number>();
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (!sql.includes("auth_rate_limits")) return null;
              const key = String(args[0]);
              const next = (counts.get(key) ?? 0) + 1;
              counts.set(key, next);
              return { count: next };
            },
            async run() {
              return { meta: { changes: 0 } };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("SW 注册失败上报 beacon (R202, audit-r201 §1)", () => {
  const env = { DB: rateLimitOnlyDb() };
  const post = (body: unknown) =>
    new Request("http://x/api/metrics/sw-error", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify(body),
    });

  it("无需认证即可上报，返回 ok", async () => {
    const res = await app.request(post({ name: "TypeError", message: "Failed to fetch", retry: 0 }), undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("畸形 body 也不报错（上报是 best-effort）", async () => {
    const res = await app.request(post("not-an-object"), undefined, env);
    expect(res.status).toBe(200);
  });

  it("同 IP 超过限频返回 429", async () => {
    const freshEnv = { DB: rateLimitOnlyDb() };
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await app.request(post({ name: "e", message: "m" }), undefined, freshEnv)).status;
    }
    expect(last).toBe(429);
  });
});
