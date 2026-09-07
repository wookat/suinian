// R328 B（decision-r328 §2）：`!` / skip_triage 与默认入口物理共用同一条分拣管线。
// audit-r327 §5.2：`!会议室平板解锁短语：橘子 台灯 秋天` 走 skip_triage 后六秒仍是普通想法、Ask 直接复述——
// 旧实现 skipTriage 分支只跑 runPipeline(false)，模型复判以预检（maybeSensitive）疑似命中为前提，预检没认出的口令永不被裁决。
// 锁定：同一内容分别走默认 / skip_triage:true，mock 模型判敏感 → 两条 is_sensitive=1、正文加密占位；
// mock 判非敏感 → 两条明文，`!` 条分类 / 标签 / 标题仍按 manual_override 语义（分类 idea 不被模型改写）。
import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/index";
import { ENC_PLACEHOLDER } from "../src/crypto";
import type { Env } from "../src/types";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)));
type Row = Record<string, unknown>;

function baseNote(id: string, over: Row = {}): Row {
  return {
    id,
    user_id: "u1",
    source: "api",
    raw_type: "text",
    category: null,
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

function fakeDb(notes: Row[]) {
  const matchNotes = (sql: string, binds: unknown[]): Row[] => {
    if (sql.includes("WHERE id = ? AND user_id = ?")) return notes.filter((n) => n.id === binds[0] && n.user_id === binds[1] && !n.deleted_at);
    if (sql.includes("WHERE id = ?")) return notes.filter((n) => n.id === binds[0]);
    if (sql.includes("WHERE user_id = ?")) return notes.filter((n) => n.user_id === binds[0] && !n.deleted_at);
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
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1", tz: "Asia/Shanghai" } : null;
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
            const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const nullCols = [...setPart.matchAll(/(\w+) = NULL/g)].map((m) => m[1]);
            const jsonSet = /meta = json_set\(coalesce\(meta, '\{\}'\), '\$\.needs_retriage', json\('true'\)\)/.test(setPart);
            const whereBinds = binds.slice(cols.length) as string[];
            const targets = notes.filter((n) => n.id === whereBinds[0]);
            for (const note of targets) {
              cols.forEach((col, i) => (note[col] = binds[i]));
              nullCols.forEach((col) => (note[col] = null));
              if (jsonSet) note.meta = JSON.stringify({ ...JSON.parse((note.meta as string) || "{}"), needs_retriage: true });
            }
            return { meta: { changes: targets.length } };
          }
          if (sql.startsWith("INSERT INTO notes")) {
            const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s) => s.trim());
            const row: Row = baseNote(String(binds[0]));
            cols.forEach((col, i) => (row[col] = binds[i] ?? row[col]));
            notes.push(row);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
}

function makeEnv(notes: Row[]): Env {
  return { DB: fakeDb(notes), SUINIAN_ENC_KEY: KEY, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "https://api.deepseek.test" } as Env;
}

/** 收集 waitUntil 的后台任务，测试里显式等它们跑完（生产是 Workers 运行时兜底）。 */
function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => tasks.push(p.catch(() => undefined)), passThroughOnException() {} } as unknown as ExecutionContext,
    settle: async () => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

function req(path: string, body: Record<string, unknown>) {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer good-token" },
    body: JSON.stringify(body),
  });
}

/** 模拟分拣模型：对任何 chat/completions 请求返回给定 JSON；其它 fetch（链接元数据等）404。 */
function stubModel(triage: Record<string, unknown> | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("chat/completions")) {
        if (!triage) return new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(triage) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

/** audit-r327 §5.2 复现内容的变体：预检（maybeSensitive）不认，只有模型判得出（原句「…解锁短语：…」已由 R328 B 短语标签规则确定性标注）。 */
const PHRASE = "会议室平板解锁用：橘子 台灯 秋天";

async function create(content: string, skip: boolean) {
  const notes: Row[] = [];
  const env = makeEnv(notes);
  const { ctx, settle } = makeCtx();
  const res = await app.request(req("/api/notes", skip ? { content, skip_triage: true } : { content }), undefined, env, ctx);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { note: { id: string } };
  await settle();
  const row = notes.find((n) => n.id === body.note.id)!;
  const meta = JSON.parse((row.meta as string) || "{}") as { manual_override?: Record<string, boolean>; needs_retriage?: boolean };
  return { row, meta };
}

describe("R328 B：`!`（skip_triage）与默认入口同一条分拣管线", () => {
  it("模型判敏感：默认入口与 skip_triage 都落 is_sensitive=1 + 正文加密占位", async () => {
    stubModel({ category: "idea", tags: ["会议室"], title: "平板解锁短语", is_sensitive: true });
    for (const skip of [false, true]) {
      const { row } = await create(PHRASE, skip);
      expect(row.is_sensitive, `skip=${skip}`).toBe(1);
      expect(row.content, `skip=${skip}`).toBe(ENC_PLACEHOLDER);
      expect(typeof row.content_enc, `skip=${skip}`).toBe("string");
      expect(row.title, `skip=${skip}`).toBeNull();
    }
  });

  it("模型判非敏感：两条明文；`!` 条分类保持 idea、标签为空、字段 manual_override 锁定（不被模型分类改写）", async () => {
    stubModel({ category: "todo", tags: ["会议"], title: "周四例会", is_sensitive: false });
    const plain = "周四例会改到下午三点，记得带投影转接头";
    const dflt = await create(plain, false);
    expect(dflt.row.is_sensitive).toBe(0);
    expect(dflt.row.content).toBe(plain);
    expect(dflt.row.category).toBe("todo");
    const bang = await create(plain, true);
    expect(bang.row.is_sensitive).toBe(0);
    expect(bang.row.content).toBe(plain);
    expect(bang.row.category).toBe("idea");
    expect(bang.row.tags).toBe("[]");
    expect(bang.row.title).toBeNull();
    expect(bang.meta.manual_override).toMatchObject({ category: true, tags: true, title: true, todo_due: true });
  });

  it("模型不可用：`!` 条显式标 needs_retriage（分类非 NULL，cron 不会因 category IS NULL 复扫）", async () => {
    stubModel(null);
    const { row, meta } = await create(PHRASE, true);
    expect(row.category).toBe("idea");
    expect(meta.needs_retriage).toBe(true);
  }, 40_000); // 异步路径带 3s/8s 抖动重试（TRIAGE_RETRY_DELAYS_MS）
});
