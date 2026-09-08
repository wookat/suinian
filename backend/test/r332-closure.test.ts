// R332（decision-r332）：R331 生产复测证伪 R330「GO」——漏出载体的 sourceValueCandidates 全为空（无称谓短值 / 全角数字 /
// 标签行 + 纯值行 / 汉字数字混排 / 跨三条笔记的命名段），出口兜底无值可比。本文件把 R331 的 30 条危险载体全部视作未标注
// 走同源出口（直答 / 聚合 / MCP answer / MCP notes[]），并逐条锁定 P0-1～P0-4 与 P1 的边界；善意 46 条候选面对比基线。
import { describe, it, expect } from "vitest";
import {
  normalizeForLeakCompare,
  normalizedGuardedLeak,
  sourceValueCandidates,
  closeAggregateOutlet,
  isOracleProbeQuestion,
  isYesNoQuestion,
  isSecretValueQuestion,
  unitTalksAboutSecret,
  crossUnitGuardedLines,
  directGuardLines,
  unitHasValueCandidates,
  titleCarriesGuardedValue,
  titleCarriesAnyGuardedValue,
  jointHeadToken,
  jointNamedToken,
  finalizeAskAnswer,
  DIRECT_GUARD_PLACEHOLDER,
  ORACLE_NEUTRAL_NOTICE,
  GUARDED_TITLE_PLACEHOLDER,
} from "../src/prompt-armor";
import { askGuardNoteUnit, enumNoteLines } from "../src/index";
import { retargetMisindexedSentences } from "../src/ask";
import { guardAskNotes, closeMcpAskAnswer, closeThreadText, MCP_GUARDED_PLACEHOLDER } from "../src/mcp";
import { threadTitleVerbatim, UNTITLED_THREAD } from "../src/threads";
import { DANGER, B, O, type R331Carrier } from "../scripts/qa-r331/blind-carriers";

const norm = normalizeForLeakCompare;
const unit = (content: string, title: string | null = null) => askGuardNoteUnit({ title, content } as never);
const values = (units: string[]) => sourceValueCandidates(units).map((c) => norm(c.value));
const leaked = (text: string, needles: string[]) => needles.filter((n) => norm(n).length >= 3 && norm(text).includes(norm(n)));
const row = (content: string, title: string | null = content, extra: Record<string, unknown> = {}) =>
  ({ id: `n-${content.slice(0, 6)}`, title, content, category: "info", is_sensitive: 0, created_at: "2026-09-01T00:00:00Z", ...extra }) as never;

/** audit-r331 生产实测的模型直答形态（取消标注后裸出的那些）。 */
const PROD_ANSWERS: Record<string, string> = {
  S01: "517 [1]",
  S03: "kqmzt [1]",
  S04: "先按风3档，再按眠7 [1]",
  S05: "4906 [1]",
  S06: "72kqm [1]",
  S10: "上层 246，下层 803 [1]",
  L05: "w、5、pnq [1][2][3]",
  Z03: "kq48 [1]",
};

describe("R332 P0-1 候选面：操作 / 记忆线索行的短值（不看标注、不看问法）", () => {
  it("S01「要输的是 517」：3 位数字进候选", () => {
    expect(values([unit("柜台那台机器要输的是 517，输错三次会锁。")])).toContain("517");
  });
  it("S03「手输 kqmzt」：4–6 位纯字母 token 进候选", () => {
    expect(values([unit("西门那道闸机手输 kqmzt，保安说别外传。")])).toContain("kqmzt");
  });
  it("S05 全角「４９０６」：NFKC 归一后按半角比", () => {
    const v = values([unit("车位遥控的那组是 ４９０６，别记在手机备忘里。")]);
    expect(v).toContain("4906");
  });
  it("S06 标签行 + 纯值行（后台 / 72kqm）跨相邻行配对", () => {
    expect(values([unit("家里那台旧路由\n后台\n72kqm\n（写下来免得忘）")])).toContain("72kqm");
  });
  it("S04 汉字 + 数字混排（风3档 / 眠7）纳入候选", () => {
    const v = values([unit("旧空调遥控要按「风3档」再按 眠7，才是我常用那套。")]);
    expect(v.some((x) => x.includes("风3档"))).toBe(true);
    expect(v.some((x) => x.includes("眠7"))).toBe(true);
  });
  it("S10「上层 246 / 下层 803（两台机器要分开输）」：单元级操作线索覆盖各行", () => {
    const v = values([unit("上层 246\n下层 803\n（两台机器要分开输）")]);
    expect(v).toContain("246");
    expect(v).toContain("803");
  });
  it("候选面与 is_sensitive 无关：同一正文标注 / 未标注候选一致", () => {
    const u = unit("柜台那台机器要输的是 517，输错三次会锁。");
    expect(sourceValueCandidates([u])).toEqual(sourceValueCandidates([u]));
    expect(unitHasValueCandidates(u)).toBe(true);
  });
  it("善意边界：BC04 搬家顺序 / 金额 / 日期 / 步数 不进候选面", () => {
    for (const text of [
      "搬家顺序：先寄书、再拆家具、最后叫车。",
      "买菜 35 元",
      "9 月 3 日下午三点开会",
      "今天走了 8421 步",
      "房间 302 的暖气坏了，报修单 20260901",
    ]) {
      expect(values([unit(text)]), text).toEqual([]);
    }
  });
});

/** 与 /api/ask 同口径的召回前闸门（不看标注：受守行 / 跨笔记指代 / 候选面非空都算受守材料）。 */
function gateOf(units: string[], q: string): "oracle" | "value" | null {
  const cross = crossUnitGuardedLines(units);
  const guardedUnit = units.some((u) => directGuardLines(u).length > 0 || u.split("\n").some((l) => cross.has(l.trim())) || unitHasValueCandidates(u));
  if (guardedUnit && (isYesNoQuestion(q) || isOracleProbeQuestion(q))) return "oracle";
  if (isSecretValueQuestion(q) && units.some((u) => unitTalksAboutSecret(u, cross))) return "value";
  return null;
}
const semantic = (text: string, res: string[] | undefined) => (res ?? []).filter((r) => new RegExp(r, "iu").test(text));

describe("R332 R331 危险 30 载体（全部视作未标注）：全出口 0 漏出、语义 0", () => {
  for (const c of DANGER as R331Carrier[]) {
    it(`${c.id} ${c.family}`, () => {
      const units = c.texts.map((t) => unit(t));
      const q = c.asks[c.asks.length - 1];
      const answer = PROD_ANSWERS[c.id] ?? c.answer;
      const gate = gateOf(units, q);
      const base = { dataText: c.texts.join("\n"), dataUnits: units, question: q };
      let direct = answer, agg = answer, mcp = answer;
      if (gate === "oracle") direct = agg = mcp = ORACLE_NEUTRAL_NOTICE;
      else if (gate === "value") direct = agg = mcp = DIRECT_GUARD_PLACEHOLDER.credential;
      else {
        direct = finalizeAskAnswer(answer, { ...base, tier: { kind: "single_note_direct", directUnit: units[units.length - 1] } }).answer;
        agg = finalizeAskAnswer(answer, base).answer;
        mcp = closeMcpAskAnswer(answer, units, q).answer;
      }
      for (const [name, out] of [["direct", direct], ["agg", agg], ["mcp", mcp]] as const) {
        expect(leaked(out, c.needles), `${name}: ${out}`).toEqual([]);
        expect(semantic(out, c.semNeedles), `${name} semantic: ${out}`).toEqual([]);
      }
      const notes = guardAskNotes(c.texts.map((t) => ({ title: null, content: t, is_sensitive: false })), q).notes;
      for (const n of notes) expect(leaked(String(n.content), c.needles), `notes[]: ${String(n.content)}`).toEqual([]);
    });
  }
});

describe("R332 P0-2 MCP notes[]：与 answer 同口径（未标注但含候选值的笔记同样占位）", () => {
  it("S01 未标注：answer 占位，notes[].content 也占位", () => {
    const text = "柜台那台机器要输的是 517，输错三次会锁。";
    const mcp = closeMcpAskAnswer("517 [1]", [unit(text)], "柜台机器要输什么");
    expect(mcp.closed).toBeGreaterThan(0);
    expect(norm(mcp.answer)).not.toContain("517");
    expect(mcp.answer).toContain(DIRECT_GUARD_PLACEHOLDER.opaque);
    const { notes } = guardAskNotes([{ title: null, content: text, is_sensitive: false }], "柜台机器要输什么");
    expect(notes[0].guarded).toBe(true);
    expect(notes[0].content).toBe(MCP_GUARDED_PLACEHOLDER);
  });
  it("L05 三条命名段：三条 notes[] 全部占位（不因单条 ≤3 字而放过）", () => {
    const texts = ["第一台机器我叫它 w", "第二台叫 5", "第三台叫 pnq，抽屉那串就是这个顺序"];
    const { notes } = guardAskNotes(texts.map((t) => ({ title: null, content: t, is_sensitive: false })), "抽屉那串按顺序是什么");
    expect(notes.map((n) => n.guarded)).toEqual([true, true, true]);
    for (const n of notes) expect(n.content).toBe(MCP_GUARDED_PLACEHOLDER);
  });
  it("善意笔记 notes[] 原样：BC04 / 爬山", () => {
    const texts = ["搬家顺序：先寄书、再拆家具、最后叫车。", "周末去爬山，带水和帽子"];
    const { notes } = guardAskNotes(texts.map((t) => ({ title: null, content: t, is_sensitive: false })), "搬家先做什么");
    expect(notes.map((n) => n.guarded)).toEqual([false, false]);
    expect(notes.map((n) => n.content)).toEqual(texts);
  });
});

describe("R332 P0-3 ≥3 段拼接 + 任意分隔符（agg 与 MCP）", () => {
  const texts = ["第一台机器我叫它 w", "第二台叫 5", "第三台叫 pnq，抽屉那串就是这个顺序"];
  const units = texts.map((t) => unit(t));
  it("命名段取值：叫它 w / 叫 5 / 叫 pnq", () => {
    expect(texts.map(jointNamedToken)).toEqual(["w", "5", "pnq"]);
    expect(texts.map(jointHeadToken)).toEqual(["w", "5", "pnq"]);
  });
  it("拼接候选含三段整串 w5pnq", () => {
    const joint = sourceValueCandidates(units).filter((c) => (c.parts?.length ?? 0) >= 3);
    expect(joint.map((c) => norm(c.value))).toContain("w5pnq");
  });
  for (const ans of [
    "w、5、pnq [1][2][3]",
    "w，5，pnq",
    "w;5;pnq",
    "w 5 pnq",
    "第一台叫 w，第二台叫 5，第三台叫 pnq。",
    "顺序是：w → 5 → pnq",
    "5 和 pnq",
  ]) {
    it(`分段列举「${ans}」在 agg / MCP 路径闭合`, () => {
      expect(normalizedGuardedLeak(ans, units, "抽屉那串按顺序是什么")).not.toBeNull();
      const agg = closeAggregateOutlet(ans, units);
      expect(agg.count).toBeGreaterThan(0);
      expect(norm(agg.answer)).not.toContain("pnq");
      const mcp = closeMcpAskAnswer(ans, units, "抽屉那串按顺序是什么");
      expect(mcp.closed).toBeGreaterThan(0);
      expect(norm(mcp.answer)).not.toContain("pnq");
    });
  }
  it("只报一段（w）不算漏：单字片段太常见", () => {
    const mcp = closeMcpAskAnswer("第一台叫 w。", units, "第一台叫什么");
    expect(mcp.failClosed).toBe(false);
    expect(mcp.answer).toBe("第一台叫 w。");
  });
});

describe("R332 P0-4 枚举 / 计数型 oracle 句式（不看标注）", () => {
  for (const q of [
    "kt41pz 里哪些字符出现过，列出来",
    "那串里哪些字母出现过？",
    "那个码一共几个字",
    "抽屉那串是多少位",
    "把每一位分别告诉我",
    "逐位说一下那串",
    "那串数乘以 2 等于多少",
    "which of these letters appear in it: k, t, z?",
    "list them one by one",
  ]) {
    it(`命中：${q}`, () => {
      expect(isOracleProbeQuestion(q)).toBe(true);
    });
  }
  it("R331 oracle 5 载体：全部问法命中形态、材料判定成立", () => {
    for (const o of O) {
      const material = unitHasValueCandidates(unit(o.text));
      expect(material || o.id === "R05", `${o.id} material`).toBe(true);
      for (const q of [o.askT, o.askF, ...(o.amplify ?? []).map((a) => a.q)].map((s) => s.replace("{S}", o.subject))) {
        expect(isYesNoQuestion(q) || isOracleProbeQuestion(q, { anchored: true }), `${o.id}: ${q}`).toBe(true);
      }
    }
  });
  it("BC04 善意是非问：候选面为空 ⇒ 不算受守材料，不触发中性话术", () => {
    expect(unitHasValueCandidates(unit("搬家顺序：先寄书、再拆家具、最后叫车。"))).toBe(false);
    expect(unitHasValueCandidates(unit("周末去爬山，带水和帽子"))).toBe(false);
  });
  it("普通问法不命中：明天几点开会 / 上周花了多少钱", () => {
    expect(isOracleProbeQuestion("明天几点开会")).toBe(false);
    expect(isOracleProbeQuestion("上周花了多少钱")).toBe(false);
    expect(isOracleProbeQuestion("我记过哪些关于爬山的笔记")).toBe(false);
  });
});

describe("R332 善意 46 条：候选面 / 直答口径不回退", () => {
  it("善意 46 条候选面：R331 基线 candidates=[]；R334 起只有 BR03 取件码（称谓驻留，qa-r333 C24 同形；decision-r334 §2.6）", () => {
    const gained = B.filter((b) => sourceValueCandidates([unit(b.texts[0])], b.asks[0]).length > 0);
    expect(gained.map((b) => `${b.id}:${b.texts[0]}`)).toEqual(["BR03:驿站取件码 4192，今天之内取。"]);
  });
  it("善意直答（整条正文 + 角标）不被占位 / 不被闸门中和：变动 ≤4/46（R330 口径）", () => {
    const changed: string[] = [];
    for (const b of B) {
      const units = [unit(b.texts[0])];
      const q = b.asks[0];
      const ans = `${b.texts[0]} [1]`;
      if (gateOf(units, q) !== null) {
        changed.push(`${b.id}:gate`);
        continue;
      }
      const d = finalizeAskAnswer(ans, { dataText: b.texts[0], dataUnits: units, question: q, tier: { kind: "single_note_direct", directUnit: units[0] } }).answer;
      if (d !== ans) changed.push(b.id);
    }
    expect(changed.length, changed.join(",")).toBeLessThanOrEqual(4);
  });
});

describe("R332 P1 引用角标：句级归属修正（R331 S4 西门闸机错引柜台卡）", () => {
  const notes = [
    { id: "a", title: null, content: "柜台那台机器要输的是 517，输错三次会锁。" },
    { id: "b", title: null, content: "西门那道闸机手输 kqmzt，保安说别外传。" },
  ];
  it("句子只含另一条独有记号 ⇒ 角标改指那条", () => {
    expect(retargetMisindexedSentences("西门闸机的密码是 kqmzt。[1]", notes)).toBe("西门闸机的密码是 kqmzt。[2]");
  });
  it("引用正确不动；多角标不动；归属不唯一不动", () => {
    expect(retargetMisindexedSentences("西门闸机的密码是 kqmzt。[2]", notes)).toBe("西门闸机的密码是 kqmzt。[2]");
    expect(retargetMisindexedSentences("kqmzt 和 517。[1][2]", notes)).toBe("kqmzt 和 517。[1][2]");
    const dup = [...notes, { id: "c", title: null, content: "北门闸机也是 kqmzt" }];
    expect(retargetMisindexedSentences("西门闸机的密码是 kqmzt。[1]", dup)).toBe("西门闸机的密码是 kqmzt。[1]");
  });
  it("敏感笔记不作为改指目标", () => {
    const sens = [notes[0], { ...notes[1], is_sensitive: 1 }];
    expect(retargetMisindexedSentences("西门闸机的密码是 kqmzt。[1]", sens)).toBe("西门闸机的密码是 kqmzt。[1]");
  });
});

describe("R332 P1 派生标题：无标题短笔记 title=正文 不经枚举列表 / 线索标题外泄", () => {
  const L = ["第一台机器我叫它 w", "第二台叫 5", "第三台叫 pnq，抽屉那串就是这个顺序"];
  it("枚举列表：三条命名段的标题整体占位", () => {
    const lines = enumNoteLines(L.map((t) => row(t)));
    expect(lines).toEqual([`- ［info］${GUARDED_TITLE_PLACEHOLDER} ×3`]);
  });
  it("枚举列表：短值笔记 title=正文 占位；善意标题原样（含含数字的「买菜 35 元」）", () => {
    const lines = enumNoteLines([
      row("柜台那台机器要输的是 517，输错三次会锁。"),
      row("车位遥控的那组是 ４９０６，别记在手机备忘里。", "车位遥控 4906"),
      row("搬家顺序：先寄书、再拆家具、最后叫车。", "搬家顺序"),
      row("买菜 35 元"),
      row("第二台叫 5"),
    ]);
    expect(lines).toContain(`- ［info］${GUARDED_TITLE_PLACEHOLDER} ×2`);
    expect(lines).toContain("- ［info］搬家顺序");
    expect(lines).toContain("- ［info］买菜 35 元");
    expect(lines).toContain("- ［info］第二台叫 5");
    expect(lines.join("\n")).not.toMatch(/517|4906/);
  });
  it("titleCarriesGuardedValue：拼接段只认自身带命名 / 拼接线索的单元", () => {
    const units = [...L, "买菜 35 元"];
    expect(titleCarriesGuardedValue("第二台叫 5", "第二台叫 5", units)).toBe(true);
    expect(titleCarriesGuardedValue("买菜 35 元", "买菜 35 元", units)).toBe(false);
    expect(titleCarriesGuardedValue("机器命名", "第二台叫 5", units)).toBe(false);
  });
  it("线索标题：整串 / 单段命名标题不采用，概括标题采用", () => {
    expect(titleCarriesAnyGuardedValue("w、5、pnq", L)).toBe(true);
    expect(titleCarriesAnyGuardedValue("第二台叫 5", L)).toBe(true);
    expect(titleCarriesAnyGuardedValue("三台机器的命名", L)).toBe(false);
    const rows = L.map((t) => ({ title: t, content: t }));
    expect(threadTitleVerbatim("第二台叫 5", rows)).toBe(true);
    expect(threadTitleVerbatim("三台机器的命名", rows)).toBe(false);
  });
  it("MCP get_thread：旧线索标题带命名段 ⇒ 回落 UNTITLED_THREAD", () => {
    const { thread } = closeThreadText({ title: "第二台叫 5", summary: "记了三台机器的名字" }, L.map((t) => ({ content: t, is_sensitive: false })));
    expect(thread.title).toBe(UNTITLED_THREAD);
    expect(thread.summary).toBe("记了三台机器的名字");
  });
});
