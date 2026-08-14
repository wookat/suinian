// R30 regression guard: write endpoints must return fast without waiting on
// AI / embedding / link fetching. The heavy work runs via waitUntil (async),
// so even a hung AI provider must not delay the HTTP response.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app, capped } from "../src/index";

interface NoteRowLite {
  id: string;
  user_id: string;
  source: string;
  raw_type: string;
  content: string;
  url: string | null;
  category: string | null;
  tags: string;
  meta: string | null;
  title: string | null;
  url_title: string | null;
  url_summary: string | null;
  url_titles: string | null;
  is_sensitive: number;
  todo_due: string | null;
  todo_done: number;
  content_enc: string | null;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Minimal stateful fake D1 for users + notes + rate limits. */
function fakeDb() {
  const users = [{ id: "u_test", name: "tester", api_token: "tok", password_hash: null }];
  const notes: NoteRowLite[] = [];
  const db = {
    notes,
    async batch() {
      return [];
    },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users WHERE api_token = ?")) {
            const u = users.find((u) => u.api_token === binds[0]);
            return u ? { id: u.id } : null;
          }
          if (sql.includes("FROM users WHERE name = ?")) {
            return users.find((u) => u.name === binds[0]) ?? null;
          }
          if (sql.includes("auth_rate_limits")) return { count: 1 };
          if (sql.includes("FROM notes WHERE id = ?")) {
            return notes.find((n) => n.id === binds[0]) ?? null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO notes")) {
            notes.push({
              id: binds[0] as string,
              user_id: binds[1] as string,
              source: binds[2] as string,
              raw_type: binds[3] as string,
              content: binds[4] as string,
              url: (binds[5] as string | null) ?? null,
              category: null,
              tags: "[]",
              meta: (binds[6] as string | null) ?? null,
              title: null,
              url_title: null,
              url_summary: null,
              url_titles: null,
              is_sensitive: 0,
              todo_due: null,
              todo_done: 0,
              content_enc: null,
              thread_id: null,
              created_at: "2026-01-01 00:00:00",
              updated_at: "2026-01-01 00:00:00",
            });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

function makeEnv() {
  const DB = fakeDb();
  return {
    env: { DB, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "https://ai.invalid" },
    DB,
  };
}

/** ExecutionContext stub that collects waitUntil promises without awaiting them. */
function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    tasks,
  };
}

const hangingFetch = vi.fn(
  (_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      // resolves only via abort; simulates a hung AI provider / slow site
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })
);

describe("write endpoints return fast with a hung AI provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", hangingFetch);
    hangingFetch.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST /api/notes responds 201 in <1s without awaiting the AI pipeline", async () => {
    const { env } = makeEnv();
    const { ctx, tasks } = makeCtx();
    const t0 = performance.now();
    const res = await app.request(
      new Request("http://local/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({ content: "快速返回测试 https://example.com/a", source: "web" }),
      }),
      undefined,
      env,
      ctx
    );
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(1000);
    // heavy work was deferred to waitUntil, not awaited in the handler
    expect(tasks.length).toBeGreaterThan(0);
    const body = (await res.json()) as { note: { category: string | null } };
    expect(body.note.category).toBeNull(); // triage is async
  });

  it("POST /api/auth/register responds 201 in <1s and never calls the AI", async () => {
    const { env } = makeEnv();
    const { ctx, tasks } = makeCtx();
    const t0 = performance.now();
    const res = await app.request(
      new Request("http://local/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
        body: JSON.stringify({ name: "newuser", password: "password123" }),
      }),
      undefined,
      env,
      ctx
    );
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(1000);
    expect(hangingFetch).not.toHaveBeenCalled(); // register must not touch AI or any network
    expect(tasks.length).toBe(0);
  });

  it("POST /api/import responds 201 in <1s without triage (category NULL, cron picks up)", async () => {
    const { env, DB } = makeEnv();
    const { ctx } = makeCtx();
    const t0 = performance.now();
    const res = await app.request(
      new Request("http://local/api/import", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({ source: "text", content: "第一条笔记\n\n第二条笔记" }),
      }),
      undefined,
      env,
      ctx
    );
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(1000);
    expect(hangingFetch).not.toHaveBeenCalled();
    const stats = (await res.json()) as { imported: number };
    expect(stats.imported).toBe(2);
    expect(DB.notes.length).toBe(0); // inserts go through db.batch, which the fake stubs out
  });
});

describe("capped (waitUntil timeout guard)", () => {
  it("resolves after the timeout even when the task never settles", async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const p = capped(never, 5000, "test");
    let done = false;
    void p.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it("resolves immediately when the task finishes and swallows rejections", async () => {
    await expect(capped(Promise.resolve("ok"), 1000, "t")).resolves.toBeUndefined();
    await expect(capped(Promise.reject(new Error("boom")), 1000, "t")).resolves.toBeUndefined();
  });
});
