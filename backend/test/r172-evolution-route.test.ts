import { describe, it, expect, vi } from "vitest";
import { EVOLUTION_Q_RE, resolveAskEnumIntent } from "../src/ask";

type AiEnv = Parameters<typeof resolveAskEnumIntent>[0];

function fakeAiEnv(reply: string | null, onRun?: () => void): AiEnv {
  return {
    AI_MODEL: "workers-ai:test-model",
    AI: {
      run: async () => {
        onRun?.();
        return { response: reply ?? undefined };
      },
    } as unknown as Ai,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
    AI_BASE_URL: "",
  };
}

const deadAiEnv: AiEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", AI_MODEL: "", AI_BASE_URL: "" };

const GENERAL = { topic: null, list: false, extreme: null };

describe("演化/脉络类问题绕开枚举家族（R172 P1）", () => {
  it("q52 原题确定性走普通召回，不调用 LLM、不被 topic_enum 短路", async () => {
    const runs = vi.fn();
    const q = "回顾一下我所有和副业相关的尝试和想法，都有哪些进展和变化";
    const route = await resolveAskEnumIntent(fakeAiEnv('{"intent":"topic_enum","topic":"副业"}', runs), q, q);
    expect(route).toEqual(GENERAL);
    expect(runs).not.toHaveBeenCalled();
  });

  it("q52 变体（带列举线索词的演化问法）全部走普通召回", async () => {
    const variants = [
      "副业的想法是怎么变化的",
      "我对副业的想法都有哪些变化",
      "列一下我所有副业尝试的进展",
      "咖啡馆这个点子的演变过程是什么样的",
      "换工作这件事我的心路历程是怎样的",
      "健身计划的调整脉络帮我梳理一下",
      "播客这个想法从最初到现在的发展过程",
      "所有和学日语有关的记录里我的方法有什么变化",
    ];
    for (const q of variants) {
      expect(EVOLUTION_Q_RE.test(q), q).toBe(true);
      const route = await resolveAskEnumIntent(deadAiEnv, q, q);
      expect(route, q).toEqual(GENERAL);
    }
  });

  it("LLM 不可用时演化问法也不落回正则枚举兜底", async () => {
    const q = "记过哪些关于副业的想法，后来都有什么进展和变化";
    const route = await resolveAskEnumIntent(deadAiEnv, q, q);
    expect(route).toEqual(GENERAL);
  });

  it("既有枚举/极值 case 不回归（不含演化措辞时行为不变）", async () => {
    const cases: Array<{ q: string; topic: string | null; list: boolean }> = [
      { q: "我看过什么书", topic: "书", list: false },
      { q: "存过哪些菜谱", topic: "菜谱", list: false },
      { q: "记过哪些关于健身的想法", topic: "健身", list: false },
      { q: "上个月都记了些什么？", topic: null, list: true },
      { q: "上周都记了什么", topic: null, list: true },
    ];
    for (const c of cases) {
      const route = await resolveAskEnumIntent(deadAiEnv, c.q, c.q);
      expect(route, c.q).toEqual({ topic: c.topic, list: c.list, extreme: null });
    }
    const route = await resolveAskEnumIntent(
      fakeAiEnv('{"intent":"extreme","extreme":"earliest"}'),
      "我的第一条笔记是什么",
      "我的第一条笔记是什么"
    );
    expect(route).toEqual({ topic: null, list: false, extreme: "earliest" });
  });

  it("演化正则不误伤普通枚举/统计措辞", () => {
    for (const q of ["我看过什么书", "存过哪些菜谱", "上周都记了什么", "这个月花了多少钱", "最早的一条笔记是什么"]) {
      expect(EVOLUTION_Q_RE.test(q), q).toBe(false);
    }
  });
});
