import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichLinkInto } from "../src/extract";
import { parseHtmlMeta, isBlockedTitle } from "../src/linkmeta";
import type { Env, NoteRow } from "../src/types";

function noteRow(over: Partial<NoteRow>): NoteRow {
  return {
    id: "n1",
    user_id: "u1",
    source: "wechat",
    raw_type: "link",
    content: "https://mp.weixin.qq.com/s/abc",
    url: "https://mp.weixin.qq.com/s/abc",
    url_title: null,
    url_summary: null,
    url_titles: null,
    category: "collect",
    tags: "[]",
    title: null,
    thread_id: null,
    is_sensitive: 0,
    content_enc: null,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    amount: null,
    currency: null,
    meta: null,
    created_at: "2026-08-07T00:00:00Z",
    updated_at: "2026-08-07T00:00:00Z",
    deleted_at: null,
    ...over,
  };
}

// fake D1 covering the SQL used by enrichLinkInto
function fakeEnv(note: NoteRow) {
  const state = { note: { ...note } };
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("SELECT * FROM notes WHERE id")) return { ...state.note };
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            if (sql.includes("meta = ?")) {
              // meta is the first bind before updated_at (bindings mirror the sets order)
              state.note.meta = binds[binds.length - 2] as string;
            }
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "" } as unknown as Env, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enrichLinkInto fallback", () => {
  it("records fetch_failed + hostname when the site returns 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 }))
    );
    const { env, state } = fakeEnv(noteRow({ url: "https://www.ruanyifeng.com/blog/x.html" }));
    await enrichLinkInto(env, "n1");
    const meta = JSON.parse(state.note.meta!) as Record<string, unknown>;
    expect(meta.link_status).toBe("fetch_failed");
    expect(meta.link_site).toBe("www.ruanyifeng.com");
    expect(meta.link_fetched_at).toBeTruthy();
  });

  it("records fetch_failed + hostname when the fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timeout", "TimeoutError");
      })
    );
    const { env, state } = fakeEnv(noteRow({ url: "https://mp.weixin.qq.com/s/abc" }));
    await enrichLinkInto(env, "n1");
    const meta = JSON.parse(state.note.meta!) as Record<string, unknown>;
    expect(meta.link_status).toBe("fetch_failed");
    expect(meta.link_site).toBe("mp.weixin.qq.com");
  });

  it("records no_content when the page has no extractable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><head><title>页面</title></head><body></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
      )
    );
    const { env, state } = fakeEnv(noteRow({ url: "https://sspai.com/post/1" }));
    await enrichLinkInto(env, "n1");
    const meta = JSON.parse(state.note.meta!) as Record<string, unknown>;
    expect(meta.link_status).toBe("no_content");
    expect(meta.link_site).toBe("sspai.com");
  });
});

describe("blocked interstitial titles", () => {
  it("drops WeChat anti-bot titles from parsed meta", () => {
    const html = "<html><head><title>环境异常</title></head><body>完成验证后即可继续访问</body></html>";
    expect(parseHtmlMeta(html).title).toBeNull();
  });

  it("recognizes common interstitial titles and keeps real ones", () => {
    expect(isBlockedTitle("环境异常")).toBe(true);
    expect(isBlockedTitle("Just a moment...")).toBe(true);
    expect(isBlockedTitle("403 Forbidden")).toBe(true);
    expect(isBlockedTitle("如何用 403 状态码做限流")).toBe(false);
    expect(isBlockedTitle("聊聊环境异常检测系统的设计")).toBe(false);
  });
});
