import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/index";
import { fallbackMarkdown, escapeMdText, generateWeeklyReport } from "../src/reports";
import { isForbiddenUrl, ssrfSafeFetch, fallbackTitleFromUrl } from "../src/linkmeta";
import type { Env, NoteRow } from "../src/types";

type Row = Record<string, unknown>;

const XSS = '<img src=x onerror=alert(1)>`code`';
const SQLI = "'; DROP TABLE notes;--";

function note(over: Row): Row {
  return {
    id: "n?",
    user_id: "u?",
    source: "api",
    raw_type: "text",
    category: "idea",
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
    thread_id: null,
    content: "hello",
    content_enc: null,
    created_at: "2026-08-03 04:00:00",
    updated_at: "2026-08-03 04:00:00",
    ...over,
  };
}

/** Stateful fake D1 for two users' notes, honoring user_id conditions like real D1. */
function fakeDb(notes: Row[], opts?: { onSql?: (sql: string, binds: unknown[]) => void }) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          opts?.onSql?.(sql, binds);
          if (sql.includes("FROM users WHERE api_token")) {
            if (binds[0] === "token-a") return { id: "u_a" };
            if (binds[0] === "token-b") return { id: "u_b" };
            return null;
          }
          if (sql.includes("FROM notes WHERE id = ? AND user_id = ?")) {
            return notes.find((n) => n.id === binds[0] && n.user_id === binds[1]) ?? null;
          }
          if (sql.includes("FROM notes WHERE id = ?")) {
            return notes.find((n) => n.id === binds[0]) ?? null;
          }
          return null;
        },
        async all() {
          opts?.onSql?.(sql, binds);
          if (sql.includes("FROM notes WHERE user_id = ?")) {
            return { results: notes.filter((n) => n.user_id === binds[0]) };
          }
          return { results: [] };
        },
        async run() {
          opts?.onSql?.(sql, binds);
          if (sql.startsWith("UPDATE notes SET")) {
            // honors the trailing WHERE id = ? AND user_id = ? binds
            const target = notes.find(
              (n) => n.id === binds[binds.length - 2] && n.user_id === binds[binds.length - 1]
            );
            if (!target) return { meta: { changes: 0 } };
            const cols = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            cols.forEach((col, i) => {
              target[col] = binds[i];
            });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO notes")) {
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(notes: Row[], opts?: { onSql?: (sql: string, binds: unknown[]) => void }) {
  return {
    DB: fakeDb(notes, opts),
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  return new Request(`http://x${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

describe("A/B account isolation", () => {
  const seed = () => [
    note({ id: "n_a", user_id: "u_a", content: "a-private" }),
    note({ id: "n_b", user_id: "u_b", content: "b-private" }),
  ];

  it("list only returns the caller's notes", async () => {
    const env = makeEnv(seed());
    const res = await app.request(req("/api/notes", { token: "token-b" }), undefined, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: { id: string }[] };
    expect(body.notes.map((n) => n.id)).toEqual(["n_b"]);
  });

  it("PATCH on another user's note returns 404 and does not modify it", async () => {
    const notes = seed();
    const env = makeEnv(notes);
    const res = await app.request(
      req("/api/notes/n_a", { method: "PATCH", token: "token-b", body: JSON.stringify({ content: "hacked" }) }),
      undefined,
      env,
      ctx
    );
    expect(res.status).toBe(404);
    expect(notes[0].content).toBe("a-private");
  });

  it("DELETE on another user's note returns 404", async () => {
    const env = makeEnv(seed());
    const res = await app.request(
      req("/api/notes/n_a", { method: "DELETE", token: "token-b" }),
      undefined,
      env,
      ctx
    );
    expect(res.status).toBe(404);
  });
});

describe("injection payloads", () => {
  it("search q with SQL metacharacters is passed as a bind, not interpolated", async () => {
    const seen: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv([], { onSql: (sql, binds) => seen.push({ sql, binds }) });
    const res = await app.request(
      req(`/api/notes?q=${encodeURIComponent(SQLI)}`, { token: "token-a" }),
      undefined,
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const listQuery = seen.find((s) => s.sql.includes("FROM notes WHERE user_id = ?"));
    expect(listQuery).toBeDefined();
    expect(listQuery!.sql).not.toContain("DROP TABLE");
    // multi-word q is split into per-term binds; every token must arrive as a bind
    for (const term of SQLI.split(/\s+/)) {
      expect(listQuery!.binds.some((b) => typeof b === "string" && b.includes(term))).toBe(true);
    }
  });
});

describe("fallback weekly report (H-1 / L-2)", () => {
  const notes = [
    note({ id: "n1", user_id: "u1", content: XSS }) as unknown as NoteRow,
    note({ id: "n2", user_id: "u1", content: "secret-password-value", is_sensitive: 1 }) as unknown as NoteRow,
  ];

  it("escapes < > ` in note text", () => {
    const md = fallbackMarkdown("2026-08-03", "2026-08-09", notes);
    expect(md).not.toContain("<img");
    expect(md).not.toContain("`");
    expect(md).toContain("&lt;img");
  });

  it("counts sensitive notes but never shows their content", () => {
    const md = fallbackMarkdown("2026-08-03", "2026-08-09", notes);
    expect(md).not.toContain("secret-password-value");
    expect(md).toContain("本周共记录 2 条（含 1 条敏感记录，仅计数不展示内容）");
    expect(md).toContain("（另有 1 条敏感记录，内容不展示）");
  });

  it("escapeMdText handles all dangerous characters", () => {
    expect(escapeMdText("<b>`&x`</b>")).toBe("&lt;b&gt;'&amp;x'&lt;/b&gt;");
  });

  it("generateWeeklyReport returns null for a week with no notes", async () => {
    const env = {
      DB: {
        prepare() {
          const stmt = {
            bind: () => stmt,
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          };
          return stmt;
        },
      },
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    expect(await generateWeeklyReport(env, "u1")).toBeNull();
  });

  it("POST /api/reports/generate returns 422 when the week is empty", async () => {
    const env = makeEnv([]);
    const res = await app.request(
      req("/api/reports/generate", { method: "POST", token: "token-a", body: JSON.stringify({ week: "this" }) }),
      undefined,
      env,
      ctx
    );
    expect(res.status).toBe(422);
  });
});

describe("SSRF guard (M-1)", () => {
  const forbidden = [
    "ftp://example.com/x",
    "file:///etc/passwd",
    "http://localhost/x",
    "http://foo.localhost/x",
    "http://metadata.google.internal/computeMetadata",
    "http://svc.cluster.internal/x",
    "http://127.0.0.1/x",
    "http://10.1.2.3/x",
    "http://172.16.0.1/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/x",
    "http://100.64.0.1/x",
    "http://2130706433/x", // 127.0.0.1 as integer
    "http://[::1]/x",
    "http://[fe80::1]/x",
    "http://[fd00::1]/x",
    "http://[::ffff:10.0.0.1]/x",
  ];
  const allowed = ["https://36kr.com/p/12345", "http://93.184.216.34/x", "https://example.com/a?b=c"];

  it("rejects private / reserved / internal targets", () => {
    for (const u of forbidden) expect(isForbiddenUrl(new URL(u)), u).toBe(true);
  });

  it("allows public http(s) targets", () => {
    for (const u of allowed) expect(isForbiddenUrl(new URL(u)), u).toBe(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("re-checks every redirect hop and blocks redirects into private ranges", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith("https://public.example.com")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      }
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await ssrfSafeFetch("https://public.example.com/a", {});
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // never fetched the private hop
  });

  it("caps redirect chains", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://pub.example.com/next" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await ssrfSafeFetch("https://pub.example.com/a", {});
    expect(res).toBeNull();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("follows safe redirects to a public host", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/start")
        ? new Response(null, { status: 301, headers: { location: "https://other.example.com/final" } })
        : new Response("final-ok")
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await ssrfSafeFetch("https://pub.example.com/start", {});
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("final-ok");
  });
});

describe("readable title fallback (P1-1)", () => {
  it("builds domain + readable path", () => {
    expect(fallbackTitleFromUrl("https://36kr.com/p/3340813269088645")).toBe("36kr.com › p/3340813269088645");
    expect(fallbackTitleFromUrl("https://example.com/")).toBe("example.com");
    expect(fallbackTitleFromUrl("https://a.com/x/%E4%B8%AD%E6%96%87")).toBe("a.com › x/中文");
  });
});

describe("security headers + CORS (M-2 / M-3)", () => {
  it("sets security headers on API responses", async () => {
    const env = makeEnv([]);
    const res = await app.request(req("/health"), undefined, env, ctx);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("preload");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("allows the production web origin", async () => {
    const env = makeEnv([]);
    const res = await app.request(
      req("/health", { headers: { origin: "https://suinian.zalize.com" } }),
      undefined,
      env,
      ctx
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://suinian.zalize.com");
  });

  it("rejects unknown origins", async () => {
    const env = makeEnv([]);
    const res = await app.request(req("/health", { headers: { origin: "https://evil.example.com" } }), undefined, env, ctx);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("limit clamping (P2)", () => {
  async function limitBindFor(qs: string): Promise<number> {
    let bind = -1;
    const env = makeEnv([], {
      onSql: (sql, binds) => {
        if (sql.includes("ORDER BY created_at DESC, id DESC LIMIT ?")) bind = binds[binds.length - 1] as number;
      },
    });
    const res = await app.request(req(`/api/notes${qs}`, { token: "token-a" }), undefined, env, ctx);
    expect(res.status).toBe(200);
    return bind;
  }

  it("clamps to [1, 100] and defaults non-numeric to 20 (bind is limit+1)", async () => {
    expect(await limitBindFor("?limit=0")).toBe(2);
    expect(await limitBindFor("?limit=-5")).toBe(2);
    expect(await limitBindFor("?limit=500")).toBe(101);
    expect(await limitBindFor("?limit=abc")).toBe(21);
    expect(await limitBindFor("")).toBe(21);
  });
});
