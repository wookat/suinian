// R326（docs/decision-r326.md）：标注即占位 + 敏感笔记可找回。
//   §2 找回：recallSensitiveNotes 只在请求内解密做匹配，返回行对象仍是库内占位串；plains 只给末端复核；
//   §3 卡片：askRefNoteJson 对敏感行只给占位体 + id（title 置空、content_withheld=true），普通行不变；
//   §1 纵深：sensitiveAnswerLeak 对本次敏感明文的归一化比对（问句自供片段不计）；
//   §5 取消标记：manual_override.is_sensitive 在「用户已取消」方向同样粘性，正文改动后放开；
//   MCP ask notes[] 敏感条目只给占位体 + id。
import { describe, it, expect } from "vitest";
import { encryptContent, ENC_PLACEHOLDER } from "../src/crypto";
import {
  recallSensitiveNotes,
  sensitiveTermScore,
  sensitiveAnswerLeak,
  sensitiveOnlyAnswer,
  SENSITIVE_CARD_PLACEHOLDER,
  SENSITIVE_MODEL_LINE,
} from "../src/sensitive-recall";
import { app, applyTriage, askRefNoteJson, searchTerms } from "../src/index";
import { askTopicTerms } from "../src/ask";
import { guardAskNotes, MCP_SENSITIVE_ASK_PLACEHOLDER } from "../src/mcp";
import { maybeSensitive, detectSensitive } from "../src/triage";
import type { Env, NoteRow, TriageResult } from "../src/types";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)));

type Row = Record<string, unknown>;

function baseNote(id: string, over: Row = {}): Row {
  return {
    id,
    user_id: "u1",
    source: "api",
    raw_type: "text",
    category: "data",
    tags: "[]",
    title: null,
    url: null,
    url_title: null,
    url_summary: null,
    url_titles: null,
    meta: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    thread_id: null,
    content: `note ${id}`,
    content_enc: null,
    amount: null,
    currency: null,
    created_at: "2026-09-01 00:00:00",
    updated_at: "2026-09-01 00:00:00",
    deleted_at: null,
    ...over,
  };
}

async function sensitiveNote(id: string, plain: string, over: Row = {}): Promise<Row> {
  return baseNote(id, {
    is_sensitive: 1,
    content: ENC_PLACEHOLDER,
    content_enc: await encryptContent(KEY, plain),
    title: null,
    ...over,
  });
}

// 有状态的 fake D1（与 r70-triage-override.test.ts 同形）。
function fakeDb(notes: Row[]) {
  const matchNotes = (sql: string, binds: unknown[]): Row[] => {
    if (sql.includes("WHERE id = ? AND user_id = ?"))
      return notes.filter((n) => n.id === binds[0] && n.user_id === binds[1] && !n.deleted_at);
    if (sql.includes("WHERE id = ?")) return notes.filter((n) => n.id === binds[0]);
    if (sql.includes("WHERE user_id = ? AND is_sensitive = 1")) {
      const limit = typeof binds[1] === "number" ? binds[1] : Infinity;
      return notes
        .filter((n) => n.user_id === binds[0] && n.is_sensitive === 1 && !n.deleted_at)
        .sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1))
        .slice(0, limit);
    }
    if (sql.includes("WHERE user_id = ?")) return notes.filter((n) => n.user_id === binds[0]);
    return notes;
  };
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("auth_rate_limits")) return { count: 1 };
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          if (sql.includes("FROM notes")) return matchNotes(sql, binds)[0] ?? null;
          return null;
        },
        async all() {
          if (sql.includes("FROM notes")) return { results: matchNotes(sql, binds).map((n) => ({ ...n })) };
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const whereIdx = sql.indexOf(" WHERE ");
            const setPart = sql.slice(0, whereIdx);
            const wherePart = sql.slice(whereIdx);
            const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const nowCols = [...setPart.matchAll(/(\w+) = datetime\('now'\)/g)].map((m) => m[1]);
            const nullCols = [...setPart.matchAll(/(\w+) = NULL/g)].map((m) => m[1]);
            const whereBinds = binds.slice(cols.length) as string[];
            let targets = notes.filter(
              (n) => n.id === whereBinds[0] && (!wherePart.includes("user_id = ?") || n.user_id === whereBinds[1])
            );
            if (wherePart.includes("updated_at = ?"))
              targets = targets.filter((n) => n.updated_at === whereBinds[whereBinds.length - 1]);
            for (const note of targets) {
              cols.forEach((col, i) => (note[col] = binds[i]));
              nowCols.forEach((col) => (note[col] = "2026-09-01 00:00:01"));
              nullCols.forEach((col) => (note[col] = null));
            }
            return { meta: { changes: targets.length } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(notes: Row[]): Env {
  return {
    DB: fakeDb(notes),
    SUINIAN_ENC_KEY: KEY,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  } as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(method: string, path: string, body?: Record<string, unknown>) {
  return new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer good-token" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const metaOf = (row: Row) => JSON.parse((row.meta as string) ?? "{}") as { manual_override?: Record<string, boolean> };

describe("R326 §2 找回：敏感笔记按解密内存匹配召回，返回行不解密", () => {
  it("命中：只有密文含检索词的敏感笔记被召回；行对象 content 仍是占位串，明文只在 plains", async () => {
    const notes = [
      await sensitiveNote("s1", "周四例会的 Zoom 会议号 8821 5570 33，密码 246810。"),
      await sensitiveNote("s2", "健身房柜子锁的密码我设成 3388，每次都一样。"),
      baseNote("p1", { content: "周四例会改到下午三点" }),
    ];
    const terms = searchTerms("周四例会的会议号是多少");
    const r = await recallSensitiveNotes(makeEnv(notes), "u1", terms, { topicTerms: askTopicTerms(terms) });
    expect(r.rows.map((n) => n.id)).toEqual(["s1"]);
    expect(r.rows[0].content).toBe(ENC_PLACEHOLDER);
    expect(r.rows[0].content_enc).toBeTruthy();
    expect(r.plains.get("s1")).toContain("8821");
    expect(r.overflow).toBe(0);
    expect(JSON.stringify(r.rows)).not.toContain("8821");
  });

  it("R325 BR 族（正当找回）10 条被标敏感后全部可按问句召回（零召回 = 0）", async () => {
    const br: Array<[string, string, string]> = [
      ["BR01", "家里 wifi 密码是 chunfeng2019，客人来了可以直接给。", "家里 wifi 密码是多少"],
      ["BR02", "周四例会的 Zoom 会议号 8821 5570 33，密码 246810。", "周四例会的会议号是多少"],
      ["BR03", "快递柜取件码 8823，今晚之前去拿。", "快递柜取件码是多少"],
      ["BR04", "身份证后四位 5512，填表老要用。", "我身份证后四位是多少"],
      ["BR05", "新车牌 沪AD82917，停车登记要填。", "我的新车牌是什么"],
      ["BR06", "京东订单号 289471553201，退货要用。", "京东订单号是多少"],
      ["BR07", "小区门禁卡编号 A2213，丢了去物业补办要报这个。", "小区门禁卡编号是多少"],
      ["BR08", "水电维修师傅电话 13905712345，姓王。", "维修师傅电话是多少"],
      ["BR09", "查日志的命令记一下：docker logs --tail=50 web", "查日志的命令是什么"],
      ["BR10", "健身房柜子锁的密码我设成 3388，每次都一样。", "健身房柜子密码是多少"],
    ];
    const notes = await Promise.all(br.map(([id, text]) => sensitiveNote(id, text)));
    const env = makeEnv(notes);
    const zero: string[] = [];
    for (const [id, , ask] of br) {
      const terms = searchTerms(ask);
      const r = await recallSensitiveNotes(env, "u1", terms, { topicTerms: askTopicTerms(terms) });
      if (!r.rows.some((n) => n.id === id)) zero.push(`${id}:${ask}`);
      for (const row of r.rows) expect(row.content, id).toBe(ENC_PLACEHOLDER);
    }
    expect(zero).toEqual([]);
  });

  it("上限与溢出：命中数超过 limit 只返回前 limit 条（按分数、时间倒序），overflow 记余数", async () => {
    const notes: Row[] = [];
    for (let i = 0; i < 8; i++)
      notes.push(await sensitiveNote(`s${i}`, `门禁密码 ${1000 + i}`, { created_at: `2026-09-0${(i % 9) + 1} 00:00:00` }));
    const r = await recallSensitiveNotes(makeEnv(notes), "u1", ["门禁"], { limit: 5 });
    expect(r.rows).toHaveLength(5);
    expect(r.overflow).toBe(3);
    expect(r.rows[0].created_at >= r.rows[4].created_at).toBe(true);
  });

  it("不命中 / 空词 / 无敏感笔记 ⇒ 空结果；已删除的敏感笔记不召回", async () => {
    const notes = [
      await sensitiveNote("s1", "门禁密码 4821"),
      await sensitiveNote("s2", "门禁密码 9999", { deleted_at: "2026-09-02 00:00:00" }),
    ];
    const env = makeEnv(notes);
    expect((await recallSensitiveNotes(env, "u1", ["咖啡"])).rows).toEqual([]);
    expect((await recallSensitiveNotes(env, "u1", [])).rows).toEqual([]);
    expect((await recallSensitiveNotes(env, "u1", ["门禁"])).rows.map((n) => n.id)).toEqual(["s1"]);
    expect((await recallSensitiveNotes(makeEnv([]), "u1", ["门禁"])).rows).toEqual([]);
  });

  it("多词打分：全部命中最高；任一话题词命中即算（长指令句也能召回）；无话题词命中不算（U2 wifi→跳板机不串）", () => {
    expect(sensitiveTermScore("家里 wifi 密码 chunfeng2019", null, ["家里", "wifi", "密码"], ["wifi"])).toBe(3);
    expect(sensitiveTermScore("跳板机口令：Kq7#vb2x", null, ["家里", "wifi", "密码"], ["wifi"])).toBe(0);
    expect(sensitiveTermScore("跳板机口令：Kq7#vb2x", null, ["跳板机", "口令", "多少"], ["跳板机"])).toBe(2);
    expect(
      sensitiveTermScore("书房柜子的暗号是 木石田", null, ["写", "四行", "小诗", "书房", "柜子", "暗号", "顺序", "每行", "开头", "背诗"], ["小诗", "书房", "柜子", "暗号", "背诗"])
    ).toBe(3);
    expect(sensitiveTermScore("跳板机口令：Kq7#vb2x", null, ["写", "小诗", "书房", "柜子", "暗号"], ["小诗", "书房", "柜子", "暗号"])).toBe(0);
    expect(sensitiveTermScore("x", '["门禁"]', ["门禁"], ["门禁"])).toBe(1);
    expect(sensitiveTermScore("x", null, [], [])).toBe(0);
  });
});

describe("R326 §3 引用卡片：askRefNoteJson 对敏感行只给占位体 + id", () => {
  it("敏感行：content=占位体、title/url 派生字段置空、content_withheld=true；不含密文与任何原文", async () => {
    const row = (await sensitiveNote("s1", "跳板机口令：Kq7#vb2x", {
      title: null,
      url_title: "x",
      url_summary: "y",
      tags: '["跳板机"]',
    })) as unknown as NoteRow;
    const json = askRefNoteJson(row) as Record<string, unknown>;
    expect(json).toMatchObject({
      id: "s1",
      content: SENSITIVE_CARD_PLACEHOLDER,
      title: null,
      url_title: null,
      url_summary: null,
      url_titles: null,
      is_sensitive: true,
      content_withheld: true,
      fold: false,
      fold_reason: null,
    });
    expect(json.content_enc).toBeUndefined();
    const s = JSON.stringify(json);
    expect(s).not.toContain("Kq7");
    expect(s).not.toContain(row.content_enc as string);
    expect(json.tags).toEqual(["跳板机"]);
  });

  it("普通行：原样序列化 + content_withheld=false", () => {
    const row = baseNote("p1", { content: "周四例会改到下午三点", title: "例会" }) as unknown as NoteRow;
    const json = askRefNoteJson(row) as Record<string, unknown>;
    expect(json).toMatchObject({ id: "p1", content: "周四例会改到下午三点", title: "例会", content_withheld: false, is_sensitive: false });
  });

  it("只命中敏感时的确定性答案带全部角标；模型上下文行不含任何原文派生物", () => {
    const a = sensitiveOnlyAnswer(2, [{ index: 1 }, { index: 2 }]);
    expect(a).toContain("[1][2]");
    expect(a).toContain("点开");
    expect(SENSITIVE_MODEL_LINE).not.toMatch(/\d{4}/);
  });
});

describe("R326 §1 纵深：sensitiveAnswerLeak 归一化比对", () => {
  const plains = ["跳板机口令：Kq7#vb2x", "周四例会的 Zoom 会议号 8821 5570 33，密码 246810。"];
  it("答案里出现明文行（含分隔符/大小写变体）⇒ 泄漏；问句自供的片段不计", () => {
    expect(sensitiveAnswerLeak("口令是 kq7#VB2X 哦", plains)).toBe(true);
    expect(sensitiveAnswerLeak("会议号 8821-5570-33，密码 24 68 10", plains)).toBe(true);
    expect(sensitiveAnswerLeak("跳板机口令：Kq7#vb2x", plains, "跳板机口令：Kq7#vb2x 对不对")).toBe(false);
    expect(sensitiveAnswerLeak("找到 1 条相关的敏感笔记，点开卡片查看原文[1]", plains)).toBe(false);
    expect(sensitiveAnswerLeak("", plains)).toBe(false);
  });
  it("长行任一 8 字窗口重合也算", () => {
    const long = ["这是一段很长的敏感备忘正文，里面藏着保险柜的开法：先左三圈再右两圈最后回到零。"];
    expect(sensitiveAnswerLeak("方法是先左三圈再右两圈最后回到零", long)).toBe(true);
    expect(sensitiveAnswerLeak("保险柜在书房", long)).toBe(false);
  });
});

const triageSensitive: TriageResult = {
  category: "data",
  tags: ["门禁"],
  title: "门禁",
  is_sensitive: true,
  todo_due: null,
  amount: null,
  currency: null,
  merchant: null,
};

describe("R326 §5 取消敏感标记：对模型复判粘性，正文改动后放开", () => {
  it("PATCH is_sensitive=false ⇒ 恢复明文 + manual_override.is_sensitive；随后模型复判 is_sensitive=true 不得重新标敏", async () => {
    const notes = [await sensitiveNote("n1", "小区门禁卡编号 A2213，丢了去物业补办要报这个。")];
    const env = makeEnv(notes);
    const res = await app.request(req("PATCH", "/api/notes/n1", { is_sensitive: false }), undefined, env, ctx);
    expect(res.status).toBe(200);
    expect(notes[0].is_sensitive).toBe(0);
    expect(notes[0].content).toBe("小区门禁卡编号 A2213，丢了去物业补办要报这个。");
    expect(notes[0].content_enc).toBeNull();
    expect(metaOf(notes[0]).manual_override?.is_sensitive).toBe(true);
    await applyTriage(env, "n1", triageSensitive, notes[0].content as string);
    expect(notes[0].is_sensitive).toBe(0);
    expect(notes[0].title).toBe("门禁");
  });

  it("手动标敏感（既有 R262 方向）仍粘：模型复判 is_sensitive=false 不降级", async () => {
    const notes = [baseNote("n1", { content: "小区门禁卡编号 A2213" })];
    const env = makeEnv(notes);
    await app.request(req("PATCH", "/api/notes/n1", { is_sensitive: true }), undefined, env, ctx);
    expect(notes[0].is_sensitive).toBe(1);
    expect(notes[0].content).toBe(ENC_PLACEHOLDER);
    await applyTriage(env, "n1", { ...triageSensitive, is_sensitive: false }, "小区门禁卡编号 A2213");
    expect(notes[0].is_sensitive).toBe(1);
  });

  it("取消后改正文（未同时显式定敏感位）⇒ 覆盖位清除，新内容含凭证走 fail-closed 预检加密", async () => {
    const notes = [
      baseNote("n1", {
        content: "小区门禁卡编号 A2213",
        meta: JSON.stringify({ manual_override: { is_sensitive: true } }),
      }),
    ];
    const env = makeEnv(notes);
    const res = await app.request(
      req("PATCH", "/api/notes/n1", { content: "小区门禁密码改成了 4821#，别外传" }),
      undefined,
      env,
      ctx
    );
    expect(res.status).toBe(200);
    expect(metaOf(notes[0]).manual_override?.is_sensitive).toBeUndefined();
    expect(notes[0].is_sensitive).toBe(1);
    expect(notes[0].content).toBe(ENC_PLACEHOLDER);
  });

  it("取消后改正文且同一请求显式 is_sensitive=false ⇒ 覆盖位保留", async () => {
    const notes = [
      baseNote("n1", {
        content: "小区门禁卡编号 A2213",
        meta: JSON.stringify({ manual_override: { is_sensitive: true } }),
      }),
    ];
    const env = makeEnv(notes);
    await app.request(
      req("PATCH", "/api/notes/n1", { content: "小区门禁卡编号 A2213，已补办", is_sensitive: false }),
      undefined,
      env,
      ctx
    );
    expect(metaOf(notes[0]).manual_override?.is_sensitive).toBe(true);
    expect(notes[0].is_sensitive).toBe(0);
  });

  it("没有覆盖位的普通笔记：模型复判 is_sensitive=true 照常加密（fail-closed 方向不受影响）", async () => {
    const notes = [baseNote("n1", { content: "小区门禁密码 4821" })];
    const env = makeEnv(notes);
    await applyTriage(env, "n1", triageSensitive, "小区门禁密码 4821");
    expect(notes[0].is_sensitive).toBe(1);
  });
});

describe("R326 §4 MCP ask notes[]：敏感条目只给占位体 + id", () => {
  it("guardAskNotes：敏感条目 content=占位指引、title=null、tags=[]、guard_kind=sensitive；普通条目原样", () => {
    const { notes } = guardAskNotes([
      { id: "s1", is_sensitive: true, content: "Kq7#vb2x", title: "跳板机", tags: ["跳板机", "Kq7#vb2x"] },
      { id: "p1", is_sensitive: false, content: "周四例会改到下午三点", title: "例会", tags: ["例会"] },
    ]);
    expect(notes[0]).toMatchObject({ id: "s1", content: MCP_SENSITIVE_ASK_PLACEHOLDER, title: null, tags: [], guarded: true, guard_kind: "sensitive" });
    expect(JSON.stringify(notes[0])).not.toContain("Kq7");
    expect(notes[1]).toMatchObject({ id: "p1", content: "周四例会改到下午三点", title: "例会" });
  });
});

describe("R326 §4 自动标注校准：宽判据补多语言 / 比喻式称谓，定论规则不变", () => {
  it("R325 漏标族（比喻 / 外语 / 口述数字称谓）进入 fail-closed 预检窗口", () => {
    const yes = [
      "la clave del wifi de casa es rosa-luna-88",
      "書斎の金庫の暗証は やまざくら7823 にした。",
      "비밀번호는 haneul-2024 로 바꿈",
      "Das Kennwort für den Schrank: Birke-77",
      "柜子暗号 木石田",
      "开门的咒语定成了 芝麻开门八八",
    ];
    for (const t of yes) expect(maybeSensitive(t), t).toBe(true);
    // 完全没有对象与称谓的裸短语（L07「定下来了：白鹭飞过水面」）规则层不认：这是模型主判 / 用户手动标注的责任面
    //（decision-r326 §4：规则只做兜底），不以拓宽规则“正则拟合”语料。
    expect(maybeSensitive("定下来了：白鹭飞过水面")).toBe(false);
  });
  it("弱称谓凭证赋值（可上锁对象 + word/那个词/那串/那个数 + 值）是定论规则：模型降级漏标时 fail-closed", () => {
    const yes = [
      "the word for the gym locker is bluefalcon, same as last year",
      "Das Wort für den Schrank ist jetzt Herbstlaterne.",
      "the combo for my bike lock is 4471",
      "柜子那个词：桃🌸花🌸源🌸记",
      "柜子那个数是三七二一，倒着输也能开。",
      "储物柜的数字是 482913",
      "楼下快递柜那串数换成了九六二五",
    ];
    for (const t of yes) expect(detectSensitive(t), t).toBe(true);
    const no = [
      "想把书房刷成浅灰，柜子换成开放式，预算三千。",
      "柜子的数量是 3 个",
      "the word for cat in French is chat",
      "the code for the project is on github",
      "门口的树是银杏",
    ];
    for (const t of no) expect(detectSensitive(t), t).toBe(false);
  });
  it("标识符类不进定论规则：车牌 / 订单号 / 门禁卡编号 / 会议号（无密码）", () => {
    const no = ["新车牌 沪AD82917，停车登记要填。", "京东订单号 289471553201，退货要用。", "小区门禁卡编号 A2213，丢了去物业补办要报这个。", "周四例会 Zoom 会议号 8821 5570 33"];
    for (const t of no) expect(detectSensitive(t), t).toBe(false);
  });
  it("防骗忠告 / 纯命令行不被宽判据卷入", () => {
    expect(maybeSensitive("防骗忠告：任何机构都不会索要你的短信验证码、银行卡密码，遇到就挂断。")).toBe(false);
    expect(maybeSensitive("查日志的命令记一下：docker logs --tail=50 web")).toBe(false);
  });
});
