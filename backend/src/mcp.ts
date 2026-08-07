import type { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";

type Vars = { userId: string };
type App = Hono<{ Bindings: Env; Variables: Vars }>;

export const MCP_SENSITIVE_PLACEHOLDER = "[敏感内容已脱敏]";

/** Strip decrypted sensitive content from any note-shaped object (defense in depth:
 * MCP responses flow into third-party AI clients, so sensitive notes stay redacted). */
export function redactNote<T extends { is_sensitive?: unknown; content?: unknown }>(note: T): T {
  if (note && note.is_sensitive) return { ...note, content: MCP_SENSITIVE_PLACEHOLDER };
  return note;
}

function redactNotes<T extends { is_sensitive?: unknown; content?: unknown }>(notes: T[] | undefined | null): T[] {
  return (notes ?? []).map(redactNote);
}

type ApiCall = (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;

function jsonResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(status: number, body: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const msg = typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : body;
  return { content: [{ type: "text", text: `请求失败（HTTP ${status}）：${String(msg)}` }], isError: true };
}

/** Build a per-request MCP server whose tools call the existing REST API with the
 * caller's own bearer token — user isolation and validation are inherited from the API. */
export function buildMcpServer(api: ApiCall): McpServer {
  const server = new McpServer({ name: "suinian", version: "1.0.0" });

  server.registerTool(
    "save_note",
    {
      title: "记一条碎念",
      description:
        "往碎念收件箱丢一条笔记（想法/待办/收藏/资料/账目都行）。AI 会自动分拣分类、打标签、串线索；也可以手动指定标签或分类。",
      inputSchema: {
        content: z.string().min(1).max(20000).describe("笔记内容，纯文本，可含链接"),
        tags: z.array(z.string()).max(6).optional().describe("手动标签（可选，最多 6 个；不传则由 AI 自动打标签）"),
        category: z
          .enum(["idea", "todo", "collect", "data", "expense", "income"])
          .optional()
          .describe("手动分类（可选：idea 想法 / todo 待办 / collect 收藏 / data 资料 / expense 支出 / income 收入；不传则由 AI 自动分拣）"),
      },
    },
    async ({ content, tags, category }) => {
      const created = await api("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, tags, source: "mcp" }),
      });
      if (created.status !== 201) return errorResult(created.status, created.body);
      let note = (created.body as { note: { id: string } }).note;
      if (category) {
        const patched = await api(`/api/notes/${note.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category }),
        });
        if (patched.status === 200) note = (patched.body as { note: typeof note }).note;
      }
      return jsonResult({ saved: true, note: redactNote(note as { is_sensitive?: unknown; content?: unknown }) });
    }
  );

  server.registerTool(
    "search_notes",
    {
      title: "搜索碎念",
      description: "按关键词搜索笔记，自动混合关键词匹配与语义（embedding）召回。返回匹配的笔记列表。",
      inputSchema: {
        query: z.string().min(1).describe("搜索关键词或一句自然语言"),
        category: z
          .enum(["idea", "todo", "collect", "data", "expense", "income"])
          .optional()
          .describe("限定分类（可选；指定后只做关键词匹配）"),
        tag: z.string().optional().describe("限定标签（可选；指定后只做关键词匹配）"),
        limit: z.number().int().min(1).max(50).optional().describe("最多返回条数，默认 20"),
      },
    },
    async ({ query, category, tag, limit }) => {
      const params = new URLSearchParams({ q: query, limit: String(limit ?? 20) });
      if (category) params.set("category", category);
      if (tag) params.set("tag", tag);
      const res = await api(`/api/notes?${params}`);
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as { notes: { is_sensitive?: unknown; content?: unknown }[] };
      return jsonResult({ notes: redactNotes(body.notes) });
    }
  );

  server.registerTool(
    "ask",
    {
      title: "问碎念",
      description:
        "用自然语言向自己的笔记提问（AI 问答），回答带 [序号] 引用，references 列出引用到的笔记。适合「我上个月关于 X 想过什么」这类问题。",
      inputSchema: {
        question: z.string().min(1).describe("要问的问题，自然语言"),
      },
    },
    async ({ question }) => {
      const res = await api("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as {
        answer: string;
        references: unknown;
        notes: { is_sensitive?: unknown; content?: unknown }[];
      };
      return jsonResult({ answer: body.answer, references: body.references, notes: redactNotes(body.notes) });
    }
  );

  server.registerTool(
    "list_threads",
    {
      title: "列出思考线索",
      description: "列出 AI 自动聚成的思考线索（同一主题的碎片串成一条线索），按更新时间倒序。",
      inputSchema: {},
    },
    async () => {
      const res = await api("/api/threads");
      if (res.status !== 200) return errorResult(res.status, res.body);
      return jsonResult(res.body);
    }
  );

  server.registerTool(
    "get_thread",
    {
      title: "查看一条思考线索",
      description: "按 id 查看一条思考线索的摘要与其中全部笔记（时间正序）。",
      inputSchema: {
        thread_id: z.string().min(1).describe("线索 id（来自 list_threads）"),
      },
    },
    async ({ thread_id }) => {
      const res = await api(`/api/threads/${encodeURIComponent(thread_id)}`);
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as { thread: unknown; notes: { is_sensitive?: unknown; content?: unknown }[] };
      return jsonResult({ thread: body.thread, notes: redactNotes(body.notes) });
    }
  );

  server.registerTool(
    "get_weekly_report",
    {
      title: "读周报",
      description: "读取最近一份周报（每周一自动生成的「本周你在想什么」总结），或按 report_id 读指定一份。",
      inputSchema: {
        report_id: z.string().optional().describe("周报 id（可选；不传则返回最新一份）"),
      },
    },
    async ({ report_id }) => {
      let id = report_id;
      if (!id) {
        const list = await api("/api/reports");
        if (list.status !== 200) return errorResult(list.status, list.body);
        const reports = (list.body as { reports: { id: string }[] }).reports;
        if (!reports || reports.length === 0) return jsonResult({ report: null, message: "还没有周报（每周一自动生成）" });
        id = reports[0].id;
      }
      const res = await api(`/api/reports/${encodeURIComponent(id)}`);
      if (res.status !== 200) return errorResult(res.status, res.body);
      return jsonResult(res.body);
    }
  );

  server.registerTool(
    "list_todos",
    {
      title: "列出待办",
      description: "列出从碎念里自动识别出的待办事项，默认只看未完成的。",
      inputSchema: {
        include_done: z.boolean().optional().describe("是否包含已完成的待办，默认 false"),
        limit: z.number().int().min(1).max(100).optional().describe("最多返回条数，默认 50"),
      },
    },
    async ({ include_done, limit }) => {
      const params = new URLSearchParams({ category: "todo", limit: String(limit ?? 50) });
      const res = await api(`/api/notes?${params}`);
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as { notes: { todo_done?: unknown; is_sensitive?: unknown; content?: unknown }[] };
      const todos = redactNotes(body.notes).filter((n) => include_done || !n.todo_done);
      return jsonResult({ todos });
    }
  );

  server.registerTool(
    "complete_todo",
    {
      title: "完成待办",
      description: "把一条待办标记为已完成。",
      inputSchema: {
        note_id: z.string().min(1).describe("待办笔记的 id（来自 list_todos / search_notes）"),
      },
    },
    async ({ note_id }) => {
      const res = await api(`/api/notes/${encodeURIComponent(note_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ todo_done: true }),
      });
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as { note: { is_sensitive?: unknown; content?: unknown } };
      return jsonResult({ completed: true, note: redactNote(body.note) });
    }
  );

  return server;
}

/** Mount the Streamable HTTP MCP endpoint at /mcp on the existing Hono app.
 * Auth: same per-user bearer tokens as the REST API; each request builds a
 * stateless server whose tools call the REST routes with the caller's token,
 * so user isolation, validation, and rate limits are all inherited. */
export function registerMcpRoute(app: App): void {
  app.all("/mcp", async (c) => {
    const auth = c.req.header("authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: pass your Suinian API token as `Authorization: Bearer <token>`" }, id: null },
        401
      );
    }
    const token = m[1];
    const user = await c.env.DB.prepare("SELECT id FROM users WHERE api_token = ?")
      .bind(token)
      .first<{ id: string }>();
    if (!user) {
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: invalid token" }, id: null }, 401);
    }

    const api: ApiCall = async (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      const res = await app.request(path, { ...init, headers }, c.env, c.executionCtx);
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    };

    const server = buildMcpServer(api);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
}
