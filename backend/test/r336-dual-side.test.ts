// R336（decision-r336）：按 audit-r335 §14 双侧修复——
// §2 非 answer 出口旁路（no-answer notes[] / 线索图谱实体）走同一 guarded 判定；
// §4 称谓驻留区分「称谓 + 值」与「仅谈论称谓」、承诺豁免的日常识别符直答；
// §5 折叠计数句 + 角标去重；§2.6 同会话连续问不向上文借称谓（陈旧占位卡根因）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const ai = vi.hoisted(() => ({
  chatComplete: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
}));
vi.mock("../src/ai", () => ({ chatComplete: (...args: unknown[]) => ai.chatComplete(...args) }));
vi.mock("../src/semantic", () => ({
  embedText: async () => null,
  semanticRecall: async () => [],
  cosineSim: () => 0,
  noteHasSemanticSignal: () => true,
}));

import {
  isSecretValueQuestion,
  isOracleProbeQuestion,
  unitCarriesGuardedValue,
  unitTalksAboutSecret,
  graphNameGuarded,
  crossUnitGuardedLines,
  finalizeAskAnswer,
  remoteEndpointForms,
  directGuardLines,
  sourceValueCandidates,
  ORACLE_NEUTRAL_NOTICE,
  DIRECT_GUARD_PLACEHOLDER,
} from "../src/prompt-armor";
import { extractGraph, getThreadGraph, graphGuardUnit } from "../src/graph";
import { askGuardNoteUnit, askGuardedRefNoteJson, askGuardedRefNotes, withFoldedRefCount } from "../src/index";
import { dedupeAskReferences, askTopicTerms } from "../src/ask";
import { foldedRefCountLine, FOLDED_REF_COUNT_RE, sensitiveTermScore, sensitiveTopicTerms } from "../src/sensitive-recall";
import { BENIGN, SECURITY } from "../scripts/qa-r336/corpus";
import type { Env, NoteRow } from "../src/types";

const norm = (s: string) => s.replace(/\s+/g, "");
const unitOf = (text: string) => `\n${text}\n\n`;

function noteRow(id: string, content: string, extra: Partial<NoteRow> = {}): NoteRow {
  return {
    id,
    user_id: "u1",
    content,
    title: null,
    content_enc: null,
    url: null,
    url_title: null,
    url_summary: null,
    url_titles: null,
    amount: null,
    currency: null,
    meta: null,
    is_sensitive: 0,
    category: "note",
    created_at: "2026-09-01 10:00:00",
    updated_at: "2026-09-01 10:00:00",
    ...extra,
  } as NoteRow;
}

// ---- §4 善意 / 安全静态判定（族外语料 scripts/qa-r336/corpus.ts） ----
describe("R336 §4 称谓驻留：善意族外语料直答、真凭据守值", () => {
  function probe(note: string, question: string, extra: string[] = []) {
    const unit = unitOf(note);
    const units = [unit, ...extra.map(unitOf)];
    const cross = crossUnitGuardedLines(units);
    const ans = extra.length > 0 ? `${note}；${extra.join("；")} [1][2]` : `${note} [1]`;
    const fin = finalizeAskAnswer(ans, {
      dataText: [note, ...extra].join("\n"),
      dataUnits: units,
      question,
      tier: extra.length > 0 ? { kind: "aggregate" } : { kind: "single_note_direct", directUnit: unit },
    });
    return {
      gv: unitCarriesGuardedValue(unit, cross),
      talks: unitTalksAboutSecret(unit, cross),
      valueQ: isSecretValueQuestion(question),
      oracleQ: isOracleProbeQuestion(question, { anchored: true }),
      rewritten: norm(fin.answer) !== norm(ans),
      answer: fin.answer,
    };
  }

  for (const b of BENIGN.filter((c) => !c.boundary)) {
    it(`${b.id} 善意直答：${b.note}`, () => {
      const r = probe(b.note, b.question);
      expect(r.gv, "卡片不掩正文").toBe(false);
      expect(r.valueQ && r.talks, "不进取值闸门").toBe(false);
      expect(r.rewritten, "出口不改写原文").toBe(false);
      expect(b.mustContain.some((m) => norm(r.answer).includes(norm(m)))).toBe(true);
    });
  }

  for (const s of SECURITY) {
    it(`${s.id} 守值：${s.note}`, () => {
      const r = probe(s.note, s.question, s.extraNotes);
      for (const secret of s.secrets) expect(norm(r.answer)).not.toContain(norm(secret));
      expect(r.gv || (r.valueQ && r.talks) || r.rewritten).toBe(true);
    });
  }

  it("已知边界条目行为与 known-issues 文案一致（取件码 / 讲座 PIN 样例 / 卡号形订单号 / 称谓驻留单元碰预言机形态仍受守）", () => {
    for (const b of BENIGN.filter((c) => c.boundary)) {
      const r = probe(b.note, b.question);
      expect(r.gv || ((r.valueQ || r.oracleQ) && r.talks) || r.rewritten, b.id).toBe(true);
    }
  });

  it("§2.1 预言机锚也剥概念后缀：「公司口令策略要求几位」不是对口令的位数试探；「那串口令几位」仍是", () => {
    expect(isOracleProbeQuestion("公司口令策略要求几位？", { anchored: true })).toBe(false);
    expect(isOracleProbeQuestion("API key 管理文章列了几条最佳实践？", { anchored: true })).toBe(false);
    expect(isOracleProbeQuestion("口令策略每几天换一次？", { anchored: true })).toBe(false);
    expect(isOracleProbeQuestion("那串口令几位？", { anchored: true })).toBe(true);
    expect(isOracleProbeQuestion("路由器密码是几位？", { anchored: true })).toBe(true);
    expect(isOracleProbeQuestion("保险柜那组倒着念一下", { anchored: true })).toBe(true);
  });
});

// ---- §2.1 no-answer notes[] / 所有 refNote 序列化共用 guarded 判定 ----
describe("R336 §2.1 引用卡序列化统一走 guarded 判定", () => {
  it("携带口令值的非敏感笔记：卡片占位、guarded 标记，原值不出现在任何字段", () => {
    const n = noteRow("n1", "家里路由器 WiFi 密码 sunny2026!home", { title: "路由器", url: "https://example.com/x", url_title: "sunny2026!home 备忘" });
    const json = askGuardedRefNoteJson(n, askGuardNoteUnit(n)) as Record<string, unknown>;
    expect(json.content_withheld).toBe(true);
    expect(json.guarded).toBe(true);
    expect(JSON.stringify(json)).not.toContain("sunny2026");
    expect(json.title).toBeNull();
    expect(json.url).toBeNull();
  });

  it("仅谈论称谓概念的笔记（密码学课 / API key 文章）卡片正文可见", () => {
    for (const c of ["密码学课笔记：今天讲了 RSA 和 AES 的区别，作业下周三交", "读了一篇讲 API key 管理最佳实践的文章：不要硬编码，用 secret manager，定期轮换"]) {
      const n = noteRow("n2", c);
      const json = askGuardedRefNoteJson(n, askGuardNoteUnit(n)) as Record<string, unknown>;
      expect(json.content_withheld).toBeFalsy();
      expect(json.content).toBe(c);
    }
  });

  it("批量序列化：跨笔记指代（另一条只有裸值）也按同一判定占位", () => {
    const a = noteRow("a", "Hq7!zR2wT9pL");
    const b = noteRow("b", "路由器管理后台的密码我等下单独记一条");
    const out = askGuardedRefNotes([a, b]) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("Hq7!zR2wT9pL");
    expect(out.find((o) => o.id === "a")?.content_withheld).toBe(true);
  });
});

// ---- §2.2 线索图谱 ----
describe("R336 §2.2 线索图谱实体不携带受守取值", () => {
  it("graphNameGuarded：取值面 / 受守行上的记号被剔，普通实体名放行", () => {
    const unit = "家里路由器 WiFi 密码 sunny2026!home";
    expect(graphNameGuarded("sunny2026!home", [unit])).toBe(true);
    expect(graphNameGuarded("sunny2026!home")).toBe(true);
    expect(graphNameGuarded("47-19-83", ["保险柜密码 47-19-83"])).toBe(true);
    expect(graphNameGuarded("471983", ["保险柜密码 47-19-83"])).toBe(true);
    expect(graphNameGuarded("4471")).toBe(true);
    expect(graphNameGuarded("SKY云3q", ["储物柜密码 SKY云3q"])).toBe(true);
    // 善意实体
    expect(graphNameGuarded("RSA", ["密码学课笔记：今天讲了 RSA 和 AES 的区别"])).toBe(false);
    expect(graphNameGuarded("Zoom", ["周四例会 Zoom 会议号 812 4471 0392"])).toBe(false);
    expect(graphNameGuarded("碎念")).toBe(false);
    expect(graphNameGuarded("iPhone15")).toBe(false);
    expect(graphNameGuarded("GPT-4")).toBe(false);
    expect(graphNameGuarded("老王")).toBe(false);
  });

  interface Rec {
    sql: string;
    binds: unknown[];
  }
  function fakeEnv(opts: { entities?: Array<{ id: string; name: string; type: string; note_count: number }>; threadEntities?: Array<{ id: string; name: string; type: string; note_count: number }> } = {}) {
    const recs: Rec[] = [];
    const entities = opts.entities ?? [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds = args;
            return stmt;
          },
          async all() {
            recs.push({ sql, binds });
            if (sql.includes("FROM edges e JOIN entities en")) return { results: opts.threadEntities ?? [] };
            if (sql.startsWith("SELECT * FROM entities WHERE user_id")) return { results: entities };
            if (sql.includes("FROM edges") && sql.includes("src_type = 'entity' AND dst_type = 'entity'")) return { results: [] };
            if (sql.includes("SELECT src_id AS note_id, dst_id AS entity_id")) return { results: [] };
            return { results: [] };
          },
          async first() {
            recs.push({ sql, binds });
            if (sql.startsWith("SELECT meta FROM notes")) return { meta: null };
            return null;
          },
          async run() {
            recs.push({ sql, binds });
            if (sql.startsWith("INSERT INTO entities")) {
              entities.push({ id: binds[0] as string, name: binds[2] as string, type: binds[3] as string, note_count: 0 });
            }
            return { success: true };
          },
        };
        return stmt;
      },
      async batch(stmts: unknown[]) {
        return stmts.map(() => ({ success: true }));
      },
    };
    return { env: { DB: db } as unknown as Env, recs, entities };
  }

  beforeEach(() => {
    ai.chatComplete.mockReset();
  });

  it("携带口令值的笔记不进抽取：不调模型、清掉既有图证据并标记已抽取", async () => {
    const { env, recs } = fakeEnv();
    await extractGraph(env, noteRow("n-cred", "健身房储物柜密码 5827"));
    expect(ai.chatComplete).not.toHaveBeenCalled();
    expect(recs.some((r) => r.sql.startsWith("DELETE FROM edges WHERE note_id"))).toBe(true);
    expect(recs.some((r) => r.sql.startsWith("UPDATE notes SET meta"))).toBe(true);
    expect(recs.some((r) => r.sql.startsWith("INSERT INTO entities"))).toBe(false);
  });

  it("概念称谓笔记正常抽取；模型把正文里的记号抽成实体 / 别名时被剔，所在关系一并丢弃", async () => {
    const { env, entities, recs } = fakeEnv();
    ai.chatComplete.mockResolvedValue(
      JSON.stringify({
        entities: [
          { name: "RSA", type: "concept", aliases: ["Rivest-Shamir-Adleman", "7Qm2Lp9x"] },
          { name: "x7Kp9q2z", type: "other" },
          { name: "AES", type: "concept" },
        ],
        relations: [
          { src: "x7Kp9q2z", dst: "RSA", relation: "relates_to", confidence: 0.9 },
          { src: "RSA", dst: "AES", relation: "relates_to", confidence: 0.8 },
        ],
      })
    );
    await extractGraph(env, noteRow("n-concept", "密码学课笔记：今天讲了 RSA 和 AES 的区别，作业下周三交"));
    expect(ai.chatComplete).toHaveBeenCalledTimes(1);
    const names = entities.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["RSA", "AES"]));
    expect(names).not.toContain("x7Kp9q2z");
    const inserted = recs.filter((r) => r.sql.startsWith("INSERT INTO entities"));
    for (const r of inserted) expect(JSON.stringify(r.binds)).not.toContain("7Qm2Lp9x");
    const relEdges = recs.filter((r) => r.sql.startsWith("INSERT INTO edges") && r.binds[2] === "entity");
    expect(relEdges).toHaveLength(1);
  });

  it("getThreadGraph 出口过滤：修前入库的取值实体 fail-closed，善意实体保留", async () => {
    const { env } = fakeEnv({
      threadEntities: [
        { id: "e1", name: "碎念", type: "product", note_count: 3 },
        { id: "e2", name: "4471", type: "other", note_count: 1 },
        { id: "e3", name: "sunny2026!home", type: "other", note_count: 1 },
        { id: "e4", name: "路由器", type: "product", note_count: 2 },
      ],
    });
    const g = await getThreadGraph(env, "u1", ["n1", "n2"]);
    const names = g.entities.map((e) => e.name);
    expect(names).toContain("碎念");
    expect(names).toContain("路由器");
    expect(names).not.toContain("4471");
    expect(names).not.toContain("sunny2026!home");
  });

  it("getThreadGraph 带来源单元：受守行上的记号（含无标签裸值）按来源单元剔除", async () => {
    const { env } = fakeEnv({
      threadEntities: [
        { id: "e1", name: "健身房", type: "place", note_count: 2 },
        { id: "e2", name: "SKY云3q", type: "other", note_count: 1 },
      ],
    });
    const g = await getThreadGraph(env, "u1", ["n1"], [graphGuardUnit(noteRow("n1", "储物柜密码 SKY云3q"))]);
    expect(g.entities.map((e) => e.name)).toEqual(["健身房"]);
  });
});

// ---- §5 折叠计数句 + 角标去重 ----
describe("R336 §5 折叠计数句与角标去重", () => {
  it("计数句覆盖所有折叠 / 受守引用并列出角标；FOLDED_REF_COUNT_RE 能识别", () => {
    const line = foldedRefCountLine([{ index: 1 }, { index: 3 }]);
    expect(line).toContain("2 条");
    expect(line).toContain("[1]");
    expect(line).toContain("[3]");
    expect(FOLDED_REF_COUNT_RE.test(line)).toBe(true);
    expect(FOLDED_REF_COUNT_RE.test("另有 1 条敏感笔记可能相关（正文已折叠）")).toBe(true);
    expect(FOLDED_REF_COUNT_RE.test("今天跑了 5 公里")).toBe(false);
  });

  it("同一 note_id 的重复引用卡合并、角标重编号并折叠相邻重复角标", () => {
    const refs = [
      { index: 1, note_id: "A" },
      { index: 2, note_id: "B" },
      { index: 3, note_id: "A" },
      { index: 4, note_id: "C" },
    ];
    const { answer, references } = dedupeAskReferences("先看 A [1]，再看 B [2]，A 又出现 [3][1]，最后 C [4]。", refs);
    expect(references.map((r) => [r.index, r.note_id])).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
    expect(answer).not.toContain("[4]");
    expect(answer).toContain("最后 C [3]");
    expect(answer).not.toMatch(/\[1\]\s*\[1\]/);
  });
});

// ---- §2.6 同会话连续问：不向上文借称谓 ----
describe("R336 §2.6 连续问不借上文称谓（陈旧占位卡根因）", () => {
  const history = [
    "user: 家里 WiFi 密码是多少？",
    "assistant: 〔一条含口令/密钥的记录：问答区不转写，点开引用的笔记卡片查看原文〕[1]",
  ].join("\n");

  it("新话题的取值问（航班号 / 电话 / 几公里）不因上一轮问过密码而成取值问", () => {
    for (const q of ["我的航班号是多少？", "班主任电话是多少？", "今天跑了几公里？", "显示器多少钱？", "体检哪天？"]) {
      expect(isSecretValueQuestion(q, history), q).toBe(false);
      expect(isSecretValueQuestion(q), q).toBe(false);
    }
  });

  it("追问形态（指代 / 再 / 第 N 位 / 变换）仍向上文借称谓", () => {
    for (const q of ["那串是什么？", "再念一遍", "第 2 位是什么", "倒着念一下", "拆开每个字说"]) {
      expect(isSecretValueQuestion(q, history), q).toBe(true);
    }
  });

  it("无上文时追问形态不成取值问（没有可借的称谓）", () => {
    expect(isSecretValueQuestion("再念一遍")).toBe(false);
  });
});

describe("R336 生产候选实测补修（out-cand-340f709）", () => {
  it("S01：「航班 CA1832，19:40 起飞」不是 host:port 端点——编号 + 时刻类折叠出的纯数字顶级标签不算地址", () => {
    const flight = "周五航班 CA1832，19:40 起飞，浦东 T2";
    expect(remoteEndpointForms(flight, { includeEmails: true })).toEqual([]);
    expect(directGuardLines(flight)).toEqual([]);
    expect(unitCarriesGuardedValue(flight)).toBe(false);
    expect(unitTalksAboutSecret(flight)).toBe(false);
    // 真 host:port（非常见端口 / 带建连语义）仍是端点
    expect(remoteEndpointForms("跳板机 relay7.example.net:4444，ssh 连上去").length).toBeGreaterThan(0);
    expect(remoteEndpointForms("203.0.113.7:4444").length).toBeGreaterThan(0);
  });

  it("F02：数量词 + 量词（两个 / 三条）是问句虚词——「两个邮箱密码分别是多少」按「邮箱」归因到两张邮箱卡，不引到别的密码卡", () => {
    const terms = ["我的两个邮箱密码分别是多少", "开了两步验证"];
    const topics = sensitiveTopicTerms(askTopicTerms(terms));
    expect(sensitiveTermScore("公司邮箱密码 Mx7!pqZa", null, terms, topics)).toBeGreaterThan(0);
    expect(sensitiveTermScore("个人邮箱密码 Lk2#zzQw", null, terms, topics)).toBeGreaterThan(0);
    expect(sensitiveTermScore("旧手机解锁密码 738291", null, terms, topics)).toBe(0);
    expect(sensitiveTermScore("健身房储物柜密码 4471", null, terms, topics)).toBe(0);
  });
});

describe("R336 终版 ee804ab 主模型实测补修：主模型生成的无空格标题把善意卡整卡占位（history S01/S02 stale 假阳）", () => {
  it("汉字粘连的识别符标题（「周五航班CA1832浦东T2」「车牌沪A12345停B2层」）不是高熵记号——字母/数字交替计数在汉字处归零", () => {
    for (const title of ["周五航班CA1832浦东T2", "车牌沪A12345停B2层", "会议室预订B203", "iPhone15Pro购买记录"]) {
      const unit = `${title}\n周五航班 CA1832，19:40 起飞，浦东 T2`;
      expect(directGuardLines(unit), title).toEqual([]);
      expect(unitCarriesGuardedValue(unit), title).toBe(false);
    }
  });

  it("汉字短语尾随数字（「班主任王老师办公室302」「取件码记录A12」）不是「标签 + 值」整行——混合记号值不含汉字", () => {
    for (const title of ["班主任王老师办公室302", "王老师办公室302", "取件码记录A12", "教学楼302"]) {
      const unit = `${title}\n班主任王老师，办公室在教学楼 302`;
      expect(sourceValueCandidates([unit]), title).toEqual([]);
      expect(unitCarriesGuardedValue(unit), title).toBe(false);
    }
  });

  it("操作线索单元里汉字粘连的识别符标题（「SSH端口改为2222」+「SSH 端口改成了 2222」）：混合记号按汉字切段、汉字+数字短记号不切半个数字串", () => {
    const unit = "SSH端口改为2222\nSSH 端口改成了 2222";
    expect(sourceValueCandidates([unit])).toEqual([]);
    expect(unitCarriesGuardedValue(unit)).toBe(false);
    // 操作线索行真取值不回退：「要按「风3档」再按 眠7」「后台 72kqm」
    expect(sourceValueCandidates(["要按「风3档」再按 眠7"]).map((c) => c.value)).toEqual(expect.arrayContaining(["风3档", "眠7"]));
    expect(sourceValueCandidates(["后台\n72kqm"]).map((c) => c.value)).toContain("72kqm");
    expect(sourceValueCandidates(["储物柜 зимаветер31"]).map((c) => c.value)).toContain("зимаветер31");
  });

  it("真「标签 + 值」整行与真高熵记号不回退", () => {
    expect(unitCarriesGuardedValue("储物柜 Ab12cd9x")).toBe(true);
    expect(unitCarriesGuardedValue("柜门口令Ab12cd")).toBe(true);
    expect(unitCarriesGuardedValue("后台 72kq8m")).toBe(true);
    expect(directGuardLines("bl72kdp9x").length).toBeGreaterThan(0);
    expect(directGuardLines("a1b2c3d4").length).toBeGreaterThan(0);
  });
});

describe("R336 §2.1 出口静态口径：/api/ask 里所有 notes[] 序列化共用 guarded 判定", () => {
  it("index.ts 的 ask 处理器内不再有 notes: rows.map(noteToJson) / askRefNoteJson 直传（NA4「找找 Gmail 笔记」枚举分支实测漏值）", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");
    const start = src.indexOf('app.post("/api/ask"');
    const end = src.indexOf("\napp.", start + 10);
    const ask = src.slice(start, end > 0 ? end : undefined);
    const raw = ask.match(/notes:\s*[^\n]*\b(noteToJson|askRefNoteJson)\b[^\n]*/g) ?? [];
    // 唯一允许：sensRecall.rows 全是 is_sensitive=1 的行，askRefNoteJson 对其固定输出加密占位。
    expect(raw.filter((l) => !l.includes("sensRecall.rows.map(askRefNoteJson)"))).toEqual([]);
  });
});

describe("R336 §3.3 计数句：生成前确定性占位分支也要带（终版 8b3c3de 实测 F02 预言机中性分支 2 张折叠卡 0 计数句）", () => {
  const refs = [
    { index: 1, note_id: "a" },
    { index: 2, note_id: "b" },
    { index: 3, note_id: "c" },
  ];
  it("预言机中性 + 角标：追加计数句，只计 content_withheld 的卡", () => {
    const out = withFoldedRefCount(`${ORACLE_NEUTRAL_NOTICE}[1][2][3]`, refs, [{ content_withheld: true }, { content_withheld: true }, { content_withheld: false }]);
    expect(out.startsWith(`${ORACLE_NEUTRAL_NOTICE}[1][2][3]`)).toBe(true);
    expect(FOLDED_REF_COUNT_RE.test(out)).toBe(true);
    expect(out.endsWith(foldedRefCountLine([refs[0], refs[1]]))).toBe(true);
    expect(out).toContain("其中 2 条引用");
  });
  it("取值扣留占位 + 角标：同样追加；无折叠卡 / 已有计数句时不重复", () => {
    const ph = `${DIRECT_GUARD_PLACEHOLDER.credential}[1]`;
    const once = withFoldedRefCount(ph, refs.slice(0, 1), [{ content_withheld: true }]);
    expect(once).toContain("其中 1 条引用");
    expect(withFoldedRefCount(once, refs.slice(0, 1), [{ content_withheld: true }])).toBe(once);
    expect(withFoldedRefCount("普通答案 [1]", refs.slice(0, 1), [{ content_withheld: false }])).toBe("普通答案 [1]");
  });
  it("index.ts 的 ask 处理器内，ORACLE_NEUTRAL_NOTICE / DIRECT_GUARD_PLACEHOLDER 拼角标的确定性 answer 都经 withFoldedRefCount", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");
    const lines = src.split("\n").filter((l) => /answer(?:Text)?\s*[:=]\s*`\$\{(ORACLE_NEUTRAL_NOTICE|DIRECT_GUARD_PLACEHOLDER\[kind\])\}\$\{(references|marks)/.test(l));
    expect(lines).toEqual([]);
  });
});
