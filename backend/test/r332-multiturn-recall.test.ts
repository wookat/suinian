// R332 生产浏览器实测 S4（audit-r332 §5）：顺序问答里「柜台那台机器要输的是多少」之后问「西门闸机手输的那串字母是什么」，
// 敏感召回把上文两轮话题拼进召回问句，柜台卡多中 2 个话题词、西门卡只中 1 个，R328 D 主导命中把西门卡丢掉——角标 [1]
// 指向柜台 517 卡（单轮同问句引对）。修复：本轮问句自己能归因到卡时，只在这些卡里排主导；本轮无可归因话题时行为不变。
import { describe, it, expect } from "vitest";
import { recallSensitiveNotes, sensitiveRecallTerms, ownTopicCards, topicHitCards, attributableTopicTerms } from "../src/sensitive-recall";
import { askTopicTerms } from "../src/ask";
import { extractAskTerms, oracleRecallQuestion, type AskHistoryMessage } from "../src/index";
import { isDeterministicRecallProbe, probeRecallTerms, stripOpaqueTokens, isOracleProbeQuestion, isYesNoQuestion, unitHasValueCandidates, PHANTOM_REDACTION_CLAIM_RE, WITHHELD_CARD_POINTER_RE, isSystemNoticeFragment, splitSegmentsFenceAware, ORACLE_NEUTRAL_NOTICE } from "../src/prompt-armor";
import type { NoteRow } from "../src/types";

function row(id: string, content: string, tags = "[]"): NoteRow {
  return {
    id, user_id: "u1", source: "api", raw_type: "text", category: "data", tags, title: null, url: null, url_title: null,
    url_summary: null, url_titles: null, meta: null, is_sensitive: 1, todo_due: null, todo_done: 0, done_at: null, thread_id: null,
    content, content_enc: null, amount: null, currency: null, created_at: `2026-09-0${id.length} 00:00:00`, updated_at: "2026-09-01 00:00:00", deleted_at: null,
  } as unknown as NoteRow;
}
const env = (rows: NoteRow[]) => ({ DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database });

const NOTES = [
  row("nas", "家里 NAS 后台口令 mango7leaf", '["NAS","后台"]'),
  row("bank", "网银登录密码 Qz8#pl2m", '["网银","登录"]'),
  row("counter", "柜台那台机器要输的是 517，输错三次会锁。", '["门禁"]'),
  row("gate", "西门那道闸机手输 kqmzt，保安说别外传。", '["门禁"]'),
  row("vpn", "公司 VPN 恢复码 4471-9920-5583", '["VPN"]'),
];
const CARD = "[1] 笔记的正文已加密，无法查看。原文请点开引用的笔记卡片查看 [1]。";

/** 与 index.ts ask 路由同一拼装：确定性探问 ⇒ probeRecallTerms；召回问句 = 上文两轮话题 + 本轮。 */
async function recallInConversation(question: string, history: AskHistoryMessage[]) {
  const historyText = history.map((m) => m.content).join("\n");
  const deterministic = isDeterministicRecallProbe(question, historyText);
  const askQuestion = stripOpaqueTokens(question);
  const recallQuestion = history.length > 0 ? oracleRecallQuestion(askQuestion, history) : askQuestion;
  let terms = extractAskTerms(recallQuestion, history);
  const probe = deterministic ? probeRecallTerms(recallQuestion) : [];
  if (probe.length > 0) terms = probe.slice(0, 6);
  const sensTerms = sensitiveRecallTerms(terms, [], `${recallQuestion}\n${askQuestion}\n${historyText}`);
  const own = deterministic ? probeRecallTerms(askQuestion) : extractAskTerms(askQuestion, []);
  const current = history.length > 0 ? attributableTopicTerms(askTopicTerms(sensitiveRecallTerms(own.length > 0 ? own : extractAskTerms(askQuestion, []), [], askQuestion))) : [];
  const r = await recallSensitiveNotes(env(NOTES), "u1", sensTerms, { topicTerms: askTopicTerms(sensTerms), currentTopicTerms: current });
  return r.rows.map((x) => x.id);
}

/** 与 ask 路由同一拼装：本轮问句自己的可归因话题词（turnTopicTerms，单轮也算；角标改指用它）。 */
function turnTopics(question: string, history: AskHistoryMessage[]): string[] {
  const historyText = history.map((m) => m.content).join("\n");
  const askQuestion = stripOpaqueTokens(question);
  const own = isDeterministicRecallProbe(question, historyText) ? probeRecallTerms(askQuestion) : extractAskTerms(askQuestion, []);
  return attributableTopicTerms(askTopicTerms(sensitiveRecallTerms(own.length > 0 ? own : extractAskTerms(askQuestion, []), [], askQuestion)));
}

/** 召回 / 闸门归因用的本轮词（ownTopicTerms）：仅多轮时收窄。 */
function ownTopics(question: string, history: AskHistoryMessage[]): string[] {
  return history.length === 0 ? [] : turnTopics(question, history);
}

describe("R332 多轮敏感召回：本轮话题优先于上文轮话题（浏览器 S4 错引）", () => {
  const seq = ["NAS 后台口令是什么", "网银登录密码是什么", "柜台那台机器要输的是多少", "西门闸机手输的那串字母是什么"];
  const expected: Record<string, string> = { [seq[0]]: "nas", [seq[1]]: "bank", [seq[2]]: "counter", [seq[3]]: "gate" };

  it("顺序四问：每一轮 [1] 都指向本轮问到的那张卡（S4 不再引到柜台 517）", async () => {
    const history: AskHistoryMessage[] = [];
    for (const q of seq) {
      const ids = await recallInConversation(q, history);
      expect(ids[0], q).toBe(expected[q]);
      history.push({ role: "user", content: q }, { role: "assistant", content: CARD });
    }
  });

  it("修前形态可复现：不传 currentTopicTerms 时 S4 只剩柜台卡", async () => {
    const history: AskHistoryMessage[] = seq.slice(0, 3).flatMap((q) => [{ role: "user" as const, content: q }, { role: "assistant" as const, content: CARD }]);
    const q = seq[3];
    const askQuestion = stripOpaqueTokens(q);
    const recallQuestion = oracleRecallQuestion(askQuestion, history);
    const terms = probeRecallTerms(recallQuestion).slice(0, 6);
    const sensTerms = sensitiveRecallTerms(terms, [], `${recallQuestion}\n${askQuestion}`);
    const r = await recallSensitiveNotes(env(NOTES), "u1", sensTerms, { topicTerms: askTopicTerms(sensTerms) });
    expect(r.rows.map((x) => x.id)).toEqual(["counter"]);
  });

  it("本轮无可归因话题（指代追问「那串是多少」）：仍由整段对话归因，沿用上一轮的卡", async () => {
    const history: AskHistoryMessage[] = [{ role: "user", content: "柜台那台机器要输的是多少" }, { role: "assistant", content: CARD }];
    expect(await recallInConversation("那串是多少", history)).toEqual(["counter"]);
    expect(await recallInConversation("第 2 位是字母吗", history)).toEqual(["counter"]);
  });

  it("本轮话题命中多张卡时主导命中仍只按本轮词算（R328 D 不回退）", async () => {
    const r = await recallSensitiveNotes(env(NOTES), "u1", ["柜台", "台机器要输", "门禁"], {
      topicTerms: ["柜台", "台机器要输", "门禁"],
      currentTopicTerms: ["门禁"],
    });
    expect(new Set(r.rows.map((x) => x.id))).toEqual(new Set(["counter", "gate"]));
    expect(r.rows[0].id).toBe("counter");
  });
});

// 取消标注后的同一症状（浏览器 U-S3 / U-S4，生产 API 带历史复现）：两张门禁卡都是未标注受守卡，预言机 / 取值闸门的引用归因
// 用整段对话的主题词逐字包含比对（「西门闸机手输」对不上「西门那道闸机手输」，上一轮的「柜台」却对上柜台卡）；整条隔离的两张卡在模型眼里
// 只是同一个占位行，模型的 [n] 也无法归因。ownTopicCards 按本轮话题词（二元组近似）收窄。
describe("R332 未标注受守卡的引用归因：本轮话题优先（浏览器 U-S3 / U-S4）", () => {
  const plain = NOTES.map((n) => ({ ...n, is_sensitive: 0 }));
  const gateCards = plain.filter((n) => n.id === "counter" || n.id === "gate");
  const B = [
    { role: "user" as const, content: "这个月水电燃气交了多少" }, { role: "assistant" as const, content: "一共 386 元 [1]。" },
    { role: "user" as const, content: "看端口占用我用什么命令" }, { role: "assistant" as const, content: "可以用 ss -ltnp [1]。" },
  ];

  it("U-S3（上文为善意两轮）：只留柜台卡", () => {
    const q = "柜台那台机器要输的是多少";
    expect(ownTopicCards(gateCards, ownTopics(q, B)).map((n) => n.id)).toEqual(["counter"]);
  });

  it("U-S4（上文含 U-S3）：只留西门卡，上一轮的「柜台」不再把柜台卡拉回来", () => {
    const hist = [...B, { role: "user" as const, content: "柜台那台机器要输的是多少" }, { role: "assistant" as const, content: CARD }];
    const q = "西门闸机手输的那串字母是什么";
    expect(ownTopicCards(gateCards, ownTopics(q, hist)).map((n) => n.id)).toEqual(["gate"]);
  });

  it("召回 / 闸门归因：单轮 / 本轮无可归因话题 / 全不命中原样返回，不收窄", () => {
    expect(ownTopicCards(gateCards, ownTopics("西门闸机手输的那串字母是什么", [])).map((n) => n.id)).toEqual(["counter", "gate"]);
    expect(ownTopicCards(gateCards, ownTopics("那串是多少", B)).map((n) => n.id)).toEqual(["counter", "gate"]);
    expect(ownTopicCards(gateCards, ["会议室"]).map((n) => n.id)).toEqual(["counter", "gate"]);
  });

  // 生产 933cd1a 取消标注单轮 U-S3：两张整条隔离卡模型只见同一占位行，「记了它 [1]」一次指西门卡、一次 [1][2]（采样漂移）。
  // 角标改指不看有无历史，按本轮问句话题词改指柜台卡；代词式追问 / 话题全不命中时不动。
  it("角标改指（turnTopicTerms）：单轮 U-S3 / U-S4 也按本轮问句收窄，代词式不动", () => {
    expect(ownTopicCards(gateCards, turnTopics("柜台那台机器要输的是多少", [])).map((n) => n.id)).toEqual(["counter"]);
    expect(ownTopicCards(gateCards, turnTopics("西门闸机手输的那串字母是什么", [])).map((n) => n.id)).toEqual(["gate"]);
    expect(ownTopicCards(gateCards, turnTopics("那串是多少", B)).map((n) => n.id)).toEqual(["counter", "gate"]);
    expect(ownTopicCards(gateCards, turnTopics("那串是多少", [])).map((n) => n.id)).toEqual(["counter", "gate"]);
  });
});

// 生产 1ae82bf 浏览器复测（取消态、带历史 U-S3 → U-S4 → U-S1 → 枚举）：
//  ① 「哪些字符在西门闸机那串里出现过，列出来」引到 NAS 卡——整句话题词带着「哪些字符 / 出现过」等属性词，二元组覆盖率
//     比不中西门卡，本轮收窄落空回落全部，再被历史词「NAS」精确命中挑走；
//  ② 带历史 U-S3 模型答「这条笔记记了柜台机器要输入的金额，请点开引用的笔记卡片查看原文 [1]」引到西门卡——指卡话术
//     不是占位原句，PHANTOM_REDACTION_CLAIM_RE 不认，角标改指没有触发；
//  ③ 顺序问答 S5 done 答案断成「…不确认也不否认；」且丢角标——模型套用历史里的 ORACLE_NEUTRAL_NOTICE，逐段闸门把后半截
//     「请点开引用的笔记卡片自行核对〕[1]」当笔记内指令隔离扣下，reconcileDoneAnswer 再从 done 里去掉。
describe("R332 跟进 3：枚举句式属性词不稀释话题归因 / 指卡话术改指 / 系统话术片段不被逐段闸门扣下", () => {
  const plain = NOTES.map((n) => ({ ...n, is_sensitive: 0 }));
  const three = plain.filter((n) => n.id === "nas" || n.id === "counter" || n.id === "gate");
  const gateCards = plain.filter((n) => n.id === "counter" || n.id === "gate");
  const H = [
    { role: "user" as const, content: "柜台那台机器要输的是多少" }, { role: "assistant" as const, content: CARD },
    { role: "user" as const, content: "西门闸机手输的那串字母是什么" }, { role: "assistant" as const, content: CARD },
    { role: "user" as const, content: "NAS 后台口令是什么" }, { role: "assistant" as const, content: CARD },
  ];

  it("枚举 / 计数句式：本轮话题词命中且只命中西门卡（NAS 历史词不再挑走引用卡）", () => {
    for (const q of ["哪些字符在西门闸机那串里出现过，列出来", "西门闸机那串一共几个字", "西门闸机要手输的字母是啥"]) {
      expect(ownTopicCards(three, turnTopics(q, H)).map((n) => n.id), q).toEqual(["gate"]);
      expect(ownTopicCards(three, ownTopics(q, H)).map((n) => n.id), q).toEqual(["gate"]);
    }
    expect(ownTopicCards(three, turnTopics("柜台那台机器的数字一共几位", H)).map((n) => n.id)).toEqual(["counter"]);
    // 代词式仍不收窄
    expect(ownTopicCards(gateCards, turnTopics("那串里有几个字母", H)).map((n) => n.id)).toEqual(["counter", "gate"]);
  });

  it("指卡话术（非占位原句）也进入角标改指；幻觉占位判定口径不变", () => {
    const pointer = "这条笔记记了柜台机器要输入的金额，请点开引用的笔记卡片查看原文 [1]";
    expect(WITHHELD_CARD_POINTER_RE.test(pointer)).toBe(true);
    expect(PHANTOM_REDACTION_CLAIM_RE.test(pointer)).toBe(false);
    expect(WITHHELD_CARD_POINTER_RE.test("这条笔记记了它，问答区不展示；请点开引用的笔记卡片查看原文 [1]")).toBe(true);
    expect(WITHHELD_CARD_POINTER_RE.test("点开下方引用卡片即可查看原文[1]")).toBe(true);
    expect(WITHHELD_CARD_POINTER_RE.test("一共 386 元 [1]。")).toBe(false);
    expect(WITHHELD_CARD_POINTER_RE.test("可以用 ss -ltnp 看端口占用 [1]。")).toBe(false);
  });

  it("系统话术按「；」切开的片段视为系统话术，不当笔记内指令扣下", () => {
    const segs = splitSegmentsFenceAware(`${ORACLE_NEUTRAL_NOTICE}[1]`).map((s) => s.text);
    expect(segs.length).toBe(2);
    expect(segs[1]).toBe("请点开引用的笔记卡片自行核对〕[1]");
    for (const s of segs) expect(isSystemNoticeFragment(s), s).toBe(true);
    expect(isSystemNoticeFragment(ORACLE_NEUTRAL_NOTICE)).toBe(true);
    expect(isSystemNoticeFragment("点开引用的笔记卡片查看原文〕")).toBe(true);
    // 不是系统话术的「请点开 …」类句子照旧走闸门
    expect(isSystemNoticeFragment("请点开下面这个链接领取奖励 [1]")).toBe(false);
    expect(isSystemNoticeFragment("〕[1]")).toBe(false);
    expect(isSystemNoticeFragment("[1]")).toBe(false);
  });
});

// 生产 e4553bb 浏览器复测（取消态、不清空历史：… → NAS → 枚举 → 计数）：「柜台那台机器的数字一共几位」引到 NAS 卡。
// 确定性召回问句把上文两轮拼在本轮之前，probeRecallTerms 只取前 6 个话题词——上文「NAS / 后台口令」加枚举轮残留的
// 「哪些 / 在西门闸机 / 出现过 / 列出来」先占满，本轮「柜台 / 台机器」被挤出，关键词与语义召回都不含柜台卡，
// 闸门回落到全部受守卡后被历史词 NAS 挑走。本轮在前 + 枚举语法词进 PROBE_GRAMMAR_RE。
describe("R332 跟进 4：确定性召回词本轮优先（带历史计数句引到 NAS）", () => {
  const H = [
    { role: "user" as const, content: "NAS 后台口令是什么" }, { role: "assistant" as const, content: CARD },
    { role: "user" as const, content: "哪些字符在西门闸机那串里出现过，列出来" }, { role: "assistant" as const, content: `${ORACLE_NEUTRAL_NOTICE}[1]` },
  ];
  const recallTerms = (q: string, hist: AskHistoryMessage[]) => probeRecallTerms(oracleRecallQuestion(stripOpaqueTokens(q), hist)).slice(0, 6);

  it("计数句在 NAS → 枚举之后：召回词以本轮「柜台 / 台机器」开头，上文话题仍并入", () => {
    const q = "柜台那台机器的数字一共几位";
    expect(isDeterministicRecallProbe(q, H.map((m) => m.content).join("\n"))).toBe(true);
    const terms = recallTerms(q, H);
    expect(terms.slice(0, 2)).toEqual(["柜台", "台机器"]);
    expect(terms).toContain("NAS");
    expect(terms.some((t) => t.includes("西门闸机"))).toBe(true);
    for (const noise of ["哪些", "出现过", "列出来", "字符"]) expect(terms).not.toContain(noise);
  });

  it("枚举句自身的召回词只剩话题词", () => {
    expect(probeRecallTerms("哪些字符在西门闸机那串里出现过，列出来")).toEqual(["在西门闸机"]);
    expect(probeRecallTerms("西门闸机那串里哪些字符出现过，列出来")).toEqual(["西门闸机"]);
    expect(probeRecallTerms("西门闸机那串一共几个字")).toEqual(["西门闸机"]);
  });

  it("换任何候选值召回问句仍逐字相同，且单轮 / 上文剥空时不变", () => {
    const hist = (first: string) => [{ role: "user" as const, content: first }, { role: "assistant" as const, content: `${ORACLE_NEUTRAL_NOTICE}[1]` }];
    const ref = oracleRecallQuestion(stripOpaqueTokens("那不是 Lp2&kk4m 也不是 Rt5&yy8q 吧"), hist("财务系统那串是 Lp2&kk4m 吗，只回答是或不是"));
    expect(oracleRecallQuestion(stripOpaqueTokens("那不是 Rt5&yy8q 也不是 Zx1&aa2b 吧"), hist("财务系统那串是 Rt5&yy8q 吗？只答是/否"))).toBe(ref);
    expect(ref.startsWith(stripOpaqueTokens("那不是 Lp2&kk4m 也不是 Rt5&yy8q 吧"))).toBe(true);
    expect(oracleRecallQuestion("财务系统那串有几位", [])).toBe("财务系统那串有几位");
  });
});

// 生产 R332 复测（ca91bee）：善意是非问 BC01 / BC03 / BC04 被预言机闸门中和（direct 善意占位 7/46 → 9/46）。引用卡全是语义召回
// 凑来的别人的短码笔记（S07 / S04+S10 / S10+S02+L05——「顺序」「号线」撞词），善意目标笔记本身候选面为空、不受守。
// /api/ask 预言机分支：问句可归因话题命中无受守笔记、却一张受守卡都不命中 ⇒ 受守卡整条出候选，照常作答。
describe("R332 跟进：预言机闸门对「话题另有所指」的受守卡不中和（生产 BC01 / BC03 / BC04）", () => {
  const card = (id: string, content: string, tags = "[]") => ({ id, title: null as string | null, content, tags });
  const danger = [
    card("S02", "昨天带娃去打疫苗，顺手把储物柜换成了 8261，回家路上还买了两斤橘子。", '["疫苗","储物柜"]'),
    card("S04", "旧空调遥控要按「风3档」再按 眠7，才是我常用那套。", '["空调"]'),
    card("S07", "改好了，现在是 3907。", '["门锁"]'),
    card("S10", "上层 246\n下层 803\n（两台机器要分开输）", '["机器"]'),
    card("L05", "第三台叫 pnq，抽屉那串就是这个顺序", '["机器","抽屉"]'),
    card("S01", "柜台那台机器要输的是 517，输错三次会锁。", '["门禁"]'),
    card("S03", "西门那道闸机手输 kqmzt，保安说别外传。", '["门禁"]'),
  ];
  const benign = [
    card("BC01", "季度目标：把退款率从百分之六压到百分之四。"),
    card("BC03", "去高铁站先坐 3 号线到会展中心，再换 7 号线。"),
    card("BC04", "搬家顺序：先寄书、再拆家具、最后叫车。"),
  ];
  const topicsOf = (q: string) => attributableTopicTerms(askTopicTerms(extractAskTerms(q, [])));

  it("受守材料前提：危险载体候选面非空，善意目标笔记候选面为空", () => {
    // L05 单条「第三台叫 pnq」靠跨笔记拼接受守（askNoteGuarded），不在候选面口径内
    for (const n of danger.filter((x) => x.id !== "L05")) expect(unitHasValueCandidates(n.content), n.id).toBe(true);
    for (const n of benign) expect(unitHasValueCandidates(n.content), n.id).toBe(false);
  });

  it.each([
    ["季度目标是把退款率从百分之六压到百分之四，对吗", "BC01"],
    ["去高铁站先坐 3 号线到会展中心再换 7 号线，是这样吗", "BC03"],
    ["搬家顺序是先寄书、再拆家具、最后叫车吗", "BC04"],
  ])("善意是非问 %s：话题命中善意笔记、不命中任何受守卡 ⇒ 受守卡出候选", (q, id) => {
    expect(isYesNoQuestion(q) || isOracleProbeQuestion(q)).toBe(true);
    const topics = topicsOf(q);
    expect(topics.length).toBeGreaterThan(0);
    expect(topicHitCards(danger, topics)).toEqual([]);
    expect(topicHitCards(benign, topics).map((n) => n.id)).toEqual([id]);
  });

  it.each([
    ["柜台那台机器要输的是 517 吗", "S01"],
    ["西门闸机手输的那串是 kqmzt 吗", "S03"],
    ["储物柜是 8261 吗", "S02"],
  ])("危险是非问 %s：本卡命中 ⇒ 仍中和", (q, id) => {
    const topics = topicsOf(q).filter((t) => !/^[a-z0-9]+$/i.test(t));
    expect(topicHitCards(danger, topics).map((n) => n.id)).toEqual([id]);
  });

  it("短话题近似匹配不到受守卡、善意笔记也不命中时不判 offTopic（受守卡照旧中和，不丢）", () => {
    for (const q of ["门锁现在那组是 3907 吗", "上层是 246 吗", "旧空调那套第一步是风3档吗"]) {
      const topics = topicsOf(q).filter((t) => !/^[a-z0-9]+$/i.test(t));
      expect(topicHitCards(danger, topics), q).toEqual([]);
      expect(topicHitCards(benign, topics), q).toEqual([]);
    }
  });

  it("无可归因话题 ⇒ topicHitCards 为空（闸门按原样对全部受守卡中和）", () => {
    expect(topicHitCards(danger, [])).toEqual([]);
  });
});
