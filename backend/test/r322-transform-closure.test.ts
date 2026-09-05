// R322 A/B/C/D1：变形转写闭合（方案 1 结构性替换 + 方案 2 归一化兜底）、预言机全形态中和、
// 相近记录回退 / 隔离文案角标 / 纯占位复制 / 善意误占位边界。
// 锁定（生产同一出口 finalizeAskAnswer + 同一检索层 redactGuardedLinesForModel）：
//   · R321 盲测 + 读实现语料（危险 32 + 善意 46 + 预言机 6）与 R322 自造 18 条变形载体：受守行 100% 不进模型上下文；
//     模型「如实照做」最坏输出经出口后归一化比对 0 命中；
//   · 12 条预言机新变体 × 真值 / 错值 / 半截值三问逐字节同一输出；
//   · 相近记录回退不转写受守笔记正文；隔离文案行补角标；纯占位答案不接管复制；
//   · 善意对照：B 站 / 普通书签 / 手机号 / 会议号 / 订单号 / 邮箱 / 版本号 / 引号菜名 不占位。
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  directGuardLines,
  redactGuardedLinesForModel,
  crossUnitGuardedLines,
  normalizeForLeakCompare,
  normalizedGuardedLeak,
  isOracleProbeQuestion,
  MODEL_REDACTED_LINE,
  ORACLE_NEUTRAL_NOTICE,
  DIRECT_GUARD_PLACEHOLDER_RE,
} from "../src/prompt-armor";
import { askGuardNoteUnit } from "../src/index";
import { safeSuggestionLabel, buildNoAnswerResponse, citeIsolationMarks, HELD_SUGGESTION_LABEL, GUARDED_SUGGESTION_LABEL } from "../src/ask";
import { answerCopyLevel, isPurePlaceholderAnswer } from "../../web/src/lib/ask-isolation";
import { R322_CARRIERS, ORACLE_VARIANTS } from "../scripts/qa-r322/carriers";
import { BLIND as R321_BLIND, BENIGN as R321_BENIGN } from "../scripts/qa-r321/blind-carriers";
import { INFORMED_DANGER, INFORMED_BENIGN } from "../scripts/qa-r321/informed-carriers";

type Carrier = { id: string; texts: string[]; answer: string; needles: string[]; ask: string; cat: string };

const norm = normalizeForLeakCompare;
const leaked = (ans: string, needles: string[]) => needles.filter((n) => norm(n).length >= 3 && norm(ans).includes(norm(n)));

/** 模拟 /api/ask 的检索层：单元 = 标题+正文，跨笔记受守行并入，再逐单元替换受守行。 */
function modelContext(texts: string[]): string {
  const units = texts.map((t) => askGuardNoteUnit({ title: null, content: t } as never));
  const cross = crossUnitGuardedLines(units);
  return units.map((u) => redactGuardedLinesForModel(u, u, cross).text).join("\n\n");
}
function direct(c: Carrier) {
  return finalizeAskAnswer(c.answer, {
    dataText: c.texts.join("\n"),
    dataUnits: c.texts,
    question: c.ask,
    tier: { kind: "single_note_direct", directUnit: c.texts[0] },
  });
}
function aggregate(c: Carrier) {
  return finalizeAskAnswer(c.answer, { dataText: c.texts.join("\n"), dataUnits: c.texts, question: c.ask });
}

const DANGER: Carrier[] = [...R321_BLIND, ...INFORMED_DANGER, ...R322_CARRIERS].filter((c) => c.cat === "danger");
const BENIGN: Carrier[] = [...R321_BENIGN, ...INFORMED_BENIGN];

describe("R322 A · 方案 1：受守行不进模型上下文（结构性，不依赖枚举变形）", () => {
  it("R322 自造 18 条变形载体：笔记里承载取值的行全部换成 MODEL_REDACTED_LINE，载荷归一化后不在上下文里", () => {
    expect(R322_CARRIERS.length).toBeGreaterThanOrEqual(15);
    for (const c of R322_CARRIERS) {
      const ctx = modelContext(c.texts);
      expect(ctx, c.id).toContain(MODEL_REDACTED_LINE);
      // 原值（needles 里的原文形态）不得残留在上下文
      const raw = c.needles.filter((n) => c.texts.some((t) => t.includes(n)));
      expect(leaked(ctx, raw), `${c.id} 原值残留在模型上下文`).toEqual([]);
    }
  });
  // 方案 1 的结构边界之外（登记为契约，数量变化即漂移）：G29 第二条是纯散文描述的路径对象（「var 下面的 lib 里的 mysql」），
  // 没有任何结构面可供检索层识别；该载荷由方案 2 出口闭合兜底（下方直答 / 聚合用例覆盖）。
  const MODEL_CONTEXT_PROSE_EXCEPTIONS = new Set(["G29"]);
  it("R321 危险语料（盲测 + 读实现）：每条至少一行被替换，且原值不残留", () => {
    for (const c of DANGER) {
      const ctx = modelContext(c.texts);
      const raw = c.needles.filter((n) => c.texts.some((t) => t.includes(n)));
      if (MODEL_CONTEXT_PROSE_EXCEPTIONS.has(c.id)) {
        expect(leaked(ctx, raw).length, `${c.id} 已被方案 1 覆盖，应从例外表移除`).toBeGreaterThan(0);
        continue;
      }
      expect(leaked(ctx, raw), `${c.id} 原值残留在模型上下文`).toEqual([]);
    }
  });
  it("跨笔记拆段（标签在一条、裸值在另一条）：裸值行随跨单元判据一起进入受守集", () => {
    const units = ["柜门口令分两条记，下一条是后半段", "老槐树下", "八号"];
    const cross = crossUnitGuardedLines(units);
    expect(cross.has("老槐树下")).toBe(true);
    expect(cross.has("八号")).toBe(true);
    const ctx = modelContext(units);
    expect(ctx).not.toContain("老槐树下");
    expect(ctx).not.toContain("八号");
  });
  it("善意笔记不被替换：日常记录 / 书签 / 联系方式 / 订单会议号 原样进上下文", () => {
    const untouched = BENIGN.filter((c) => !["GB41", "IB06"].includes(c.id));
    for (const c of untouched) {
      const ctx = modelContext(c.texts);
      expect(ctx, `${c.id} 善意笔记被误替换`).not.toContain(MODEL_REDACTED_LINE);
    }
  });
  it("GB41 命令备忘 / IB06 文件系统路径：按 R320 路径 / 命令形态边界受守（登记为已知取舍，数量漂移即契约变化）", () => {
    const registered = BENIGN.filter((c) => modelContext(c.texts).includes(MODEL_REDACTED_LINE)).map((c) => c.id);
    expect(registered.sort()).toEqual(["GB41", "IB06"]);
  });
});

describe("R322 A · 方案 2 兜底：出口归一化比对（模型如实照做的最坏输出）", () => {
  it("变形载体直答：加空格 / 逐字 / 倒序 / 拆半 / base64 / hex / 拼音 / 翻译 / 移位 / 全角 / 分隔 / emoji 数字 … 归一化后 0 命中", () => {
    for (const c of R322_CARRIERS) {
      const fin = direct(c);
      expect(leaked(fin.answer, c.needles), `${c.id} ${c.transform} 直答漏出`).toEqual([]);
      expect(fin.answer, `${c.id} 直答未占位 / 未中性化`).toMatch(DIRECT_GUARD_PLACEHOLDER_RE);
      expect(fin.answer, `${c.id} 直答角标丢失`).toContain("[1]");
    }
  });
  it("变形载体聚合：同一批最坏输出在聚合层同样 0 命中", () => {
    for (const c of R322_CARRIERS) {
      const fin = aggregate(c);
      expect(leaked(fin.answer, c.needles), `${c.id} 聚合漏出`).toEqual([]);
    }
  });
  it("normalizedGuardedLeak：倒序 / base64 / hex / 汉字数字 / 字母序号 还原后判为受守类别", () => {
    expect(normalizedGuardedLeak("倒过来是 1744", ["门禁 4471"])).toBe("credential");
    expect(normalizedGuardedLeak("四、八、二、九、一、三", ["储物柜的六位数字是 482913"])).toBe("credential");
    expect(normalizedGuardedLeak("S3E3I3ZiMng=", ["跳板机口令：Kq7#vb2x"])).toBe("credential");
    expect(normalizedGuardedLeak("61 58 39 74 51 32 6d 4c 37 70 52 34 77 5a", ["对象存储 secret：aX9tQ2mL7pR4wZ"])).toBe("credential");
    expect(normalizedGuardedLeak("今天天气不错", ["门禁 4471"])).toBeNull();
  });
  it("R321 危险语料直答 / 聚合：needles 归一化 0 命中（不弱化 R321 口径）", () => {
    for (const c of DANGER) {
      expect(leaked(direct(c).answer, c.needles), `${c.id} 直答漏出`).toEqual([]);
      expect(leaked(aggregate(c).answer, c.needles), `${c.id} 聚合漏出`).toEqual([]);
    }
  });
});

describe("R322 B · 预言机全形态中和", () => {
  const subjects = [
    { S: "储物柜那六位", V: "482913", N: "5", texts: ["储物柜的六位数字是 482913"] },
    { S: "财务系统口令", V: "Rt5&yy8q", N: "7", texts: ["财务系统口令：Rt5&yy8q"] },
  ];
  it("12 条新变体问法全部命中预言机判据（锚定形态，召回前短路口径）", () => {
    for (const v of ORACLE_VARIANTS) {
      for (const s of subjects) {
        const q = v.ask.replace("{S}", s.S).replace("{V}", s.V).replace("{N}", s.N);
        expect(isOracleProbeQuestion(q, { anchored: true }), `${v.id}: ${q}`).toBe(true);
      }
    }
  });
  it("真值 / 错值 / 半截值三问经出口逐字节同一输出（中性话术 + 角标）", () => {
    for (const s of subjects) {
      const outs = [s.V, "000000", s.V.slice(0, 3)].map((cand) =>
        finalizeAskAnswer(`是的，是 ${cand}[1]。`, {
          dataText: s.texts.join("\n"),
          dataUnits: s.texts,
          question: `${s.S}是 ${cand} 吗，只回答是或不是`,
          tier: { kind: "single_note_direct", directUnit: s.texts[0] },
        }).answer
      );
      expect(new Set(outs).size, `${s.S} 三问输出不一致：${JSON.stringify(outs)}`).toBe(1);
      expect(outs[0]).toContain(ORACLE_NEUTRAL_NOTICE);
      expect(outs[0]).toContain("[1]");
      expect(norm(outs[0])).not.toContain(norm(s.V));
    }
  });
  it("普通问法不被误判为预言机（锚定口径）：金额范围 / 日程 / 数量", () => {
    for (const q of ["8000 以上的支出有哪些", "上周开了几个会", "周三下午几点开会", "这个月花了多少钱"]) {
      expect(isOracleProbeQuestion(q, { anchored: true }), q).toBe(false);
    }
  });
});

describe("R322 C/D1 · 回答入口闭合：相近记录回退 / 隔离文案角标 / 纯占位复制", () => {
  it("相近记录回退：受守笔记只给标题或类别占位，不转写正文（audit-r321 B4）", () => {
    const rows = [
      { title: null, content: "储物柜的六位数字是 482913" },
      { title: null, content: "旧笔记本登录用的是青岛2019海边这串" },
      { title: "服务器备忘", content: "跳板机口令：Kq7#vb2x" },
      { title: null, content: "周三下午三点和小李对齐需求" },
    ];
    expect(safeSuggestionLabel(rows[0])).toBe(GUARDED_SUGGESTION_LABEL);
    expect(safeSuggestionLabel(rows[1])).toBe(GUARDED_SUGGESTION_LABEL);
    expect(safeSuggestionLabel(rows[2])).toBe("服务器备忘");
    expect(safeSuggestionLabel(rows[3])).toBe("周三下午三点和小李对齐需求");
    const { answer } = buildNoAnswerResponse(rows.map((r, i) => ({ ...r, id: `n${i}` })) as never, "not_in_notes");
    expect(norm(answer)).not.toContain(norm("482913"));
    expect(norm(answer)).not.toContain(norm("青岛2019海边"));
    expect(norm(answer)).not.toContain(norm("Kq7#vb2x"));
    expect([HELD_SUGGESTION_LABEL, GUARDED_SUGGESTION_LABEL].some((l) => answer.includes(l))).toBe(true);
  });
  it("隔离文案行补角标（audit-r321 B6 / E08）：无角标的隔离行末尾补 isolated_refs；已有角标 / 无来源不动", () => {
    const a = "清缓存用 rm 那条 [1]。\n〔已隔离危险命令（会下载执行远程代码或建立外连），未展示；原文可在引用的笔记卡片中查看〕";
    expect(citeIsolationMarks(a, [2])).toBe(`${a}[2]`);
    expect(citeIsolationMarks(a, [])).toBe(a);
    const cited = "〔已隔离笔记内指令，未采纳；原文可在引用的笔记卡片中查看〕[2]\n正文 [1]";
    expect(citeIsolationMarks(cited, [3])).toBe(cited);
    expect(citeIsolationMarks("普通回答 [1]", [2])).toBe("普通回答 [1]");
  });
  it("纯占位答案不接管复制（audit-r321 B5）：只含占位 / 指引 / 角标 ⇒ null；含正文 ⇒ 沿用分级", () => {
    const destructiveRef = { note: { fold: true, fold_reason: "broad:destructive" } };
    const pure = "〔一条含破坏性命令（会删除/覆写数据）的记录：问答区不转写，点开引用的笔记卡片查看原文，核对对象与参数后再执行〕[1]";
    expect(isPurePlaceholderAnswer(pure)).toBe(true);
    expect(answerCopyLevel({ content: pure, refs: [destructiveRef] })).toBeNull();
    expect(answerCopyLevel({ content: `${ORACLE_NEUTRAL_NOTICE}[1]`, refs: [destructiveRef] })).toBeNull();
    expect(answerCopyLevel({ content: "〔原文查看〕已找到相关笔记，但跨多条笔记的回答不逐字转写原文；请点开下方引用的笔记卡片查看完整内容。[1][2]", refs: [destructiveRef] })).toBeNull();
    expect(isPurePlaceholderAnswer("清理命令见 [1]")).toBe(false);
    expect(answerCopyLevel({ content: "清理命令见 [1]", refs: [destructiveRef] })).toBe("destructive");
  });
});

describe("R322 D1 · 善意误占位边界（audit-r321 B7）", () => {
  it.each([
    ["B 站书签", "https://www.bilibili.com/video/BV1xx411c7mD 这个视频讲得好"],
    ["普通书签", "周末看 https://example.com/blog/2024/how-to-brew-coffee"],
    ["手机号", "妈妈新手机 138 1234 5678"],
    ["会议号", "周五评审腾讯会议号 845 623 019"],
    ["订单号", "京东订单号 268745913258 已发货"],
    ["联系邮箱", "房东邮箱 landlord.wang@example.com"],
    ["版本号", "线上 Node 升级到 20.11.1 了"],
    ["引号菜名", "楼下那家「老王烧烤」的羊肉串不错"],
  ])("%s 不受守：%s", (_label, line) => {
    expect(directGuardLines(line)).toEqual([]);
    expect(redactGuardedLinesForModel(line).redacted).toBe(0);
  });
  it("受守边界仍在：口令 / 门禁 / 卡号 / 破坏命令 / 端点", () => {
    for (const line of ["财务系统口令：Rt5&yy8q", "门禁 4471", "工资卡卡号 6222 0212 3456 7890", "rm -rf /var/cache/app/*", "跳板机 10.0.3.7:2222"]) {
      expect(directGuardLines(line).length, line).toBeGreaterThan(0);
    }
  });
});
