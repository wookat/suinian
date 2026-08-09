/** 碎念 stdio MCP server 的工具集，与远程版（backend/src/mcp.ts）保持一致。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactNote, redactNotes, jsonResult, errorResult } from "./lib.js";

export type ApiCall = (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;

/** Build a per-request MCP server whose tools call the existing REST API with the
 * caller's own bearer token — user isolation and validation are inherited from the API. */
export function buildMcpServer(api: ApiCall): McpServer {
  const server = new McpServer({ name: "suinian", version: "1.0.0" });

  server.registerTool(
    "save_note",
    {
      title: "记一条碎念",
      description:
        "往碎念收件箱丢一条笔记（想法/待办/收藏/资料/账目都行）。用户说「帮我记一下…」「记个待办…」「存一下这个链接」「记账：午饭 30 元」时用这个工具。AI 会自动分拣分类、打标签、串线索；也可以手动指定标签或分类。示例：save_note(content=\"周末去看《沙丘 3》\")。",
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
      description:
        "按关键词搜索笔记，自动混合关键词匹配与语义（embedding）召回，返回匹配的笔记原文列表。支持按分类/标签/来源/创建时间范围组合筛选。想找某几条笔记原文、按条件筛选时用这个；如果用户想要总结性的回答（如「我之前对 X 是怎么想的」），用 ask 工具。",
      inputSchema: {
        query: z.string().min(1).describe("搜索关键词或一句自然语言"),
        category: z
          .enum(["idea", "todo", "collect", "data", "expense", "income"])
          .optional()
          .describe("限定分类（可选）"),
        tag: z.string().optional().describe("限定标签（可选）"),
        source: z.string().optional().describe('限定来源（可选：如 "web" / "api" / "mcp" / "extension" / "wechat"）'),
        from: z.string().optional().describe('创建时间下限（可选，"YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"，含当天/当刻）'),
        to: z.string().optional().describe('创建时间上限（可选，同 from 格式，含当天/当刻）'),
        limit: z.number().int().min(1).max(50).optional().describe("最多返回条数，默认 20"),
      },
    },
    async ({ query, category, tag, source, from, to, limit }) => {
      const params = new URLSearchParams({ q: query, limit: String(limit ?? 20) });
      if (category) params.set("category", category);
      if (tag) params.set("tag", tag);
      if (source) params.set("source", source);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
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
        "用自然语言向自己的全部笔记提问，AI 检索相关笔记并给出总结性回答（带 [序号] 引用，references 列出引用到的笔记）。用户问「我之前/上个月想过什么」「我对 X 的看法是什么」「关于 Y 我记过哪些要点」时用这个工具，不要用 search_notes。得到有价值的结论后，可用 save_note 工具把结论存回碎念（写回闭环）。",
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
      return jsonResult({
        answer: body.answer,
        references: body.references,
        notes: redactNotes(body.notes),
        hint: "如需保存这次问答的结论，可调用 save_note 工具存为一条碎念。",
      });
    }
  );

  server.registerTool(
    "list_threads",
    {
      title: "列出思考线索",
      description:
        "列出 AI 自动聚成的思考线索（同一主题的碎片串成一条线索），按更新时间倒序。用户问「我最近在持续想什么」「有哪些思考线索」时用这个工具；看单条线索详情用 get_thread。",
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
      description:
        "读取最近一份周报（每周一自动生成的「本周你在想什么」总结），或按 report_id 读指定一份。用户问「看下我的周报」「上周总结」时用这个工具。",
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
      description:
        "列出从碎念里自动识别出的待办事项，默认只看未完成的。用户问「我还有什么没做完」「待办清单」时用这个工具。",
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
      description: "把一条待办标记为已完成。用户说「XX 做完了 / 勾掉 XX」时，先用 list_todos 或 search_notes 找到对应笔记 id，再调用本工具。",
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

  server.registerTool(
    "set_todo_due",
    {
      title: "设置待办到期时间",
      description:
        "给一条待办设置（或清除）到期时间。用户说「XX 改到周五 / 给 XX 加个提醒时间 / 取消 XX 的截止」时，先用 list_todos / search_notes 找到笔记 id，再调用本工具。手动设置后该字段受保护，AI 分拣不会再覆盖它。",
      inputSchema: {
        note_id: z.string().min(1).describe("待办笔记的 id（来自 list_todos / search_notes）"),
        due: z
          .string()
          .nullable()
          .describe('到期时间："YYYY-MM-DD" 或带时刻的 ISO 8601（如 "2026-08-12T15:00:00+08:00"）；传 null 清除到期时间'),
      },
    },
    async ({ note_id, due }) => {
      const res = await api(`/api/notes/${encodeURIComponent(note_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ todo_due: due }),
      });
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as { note: { is_sensitive?: unknown; content?: unknown } };
      return jsonResult({ updated: true, note: redactNote(body.note) });
    }
  );

  server.registerTool(
    "delete_note",
    {
      title: "删除笔记",
      description:
        "删除一条笔记（软删除）：笔记先进入可恢复状态，约 30 分钟内可用 restore_notes 撤销，之后才会被彻底清理。用户说「把 XX 删了 / 删掉那条」时，先用 search_notes 找到笔记 id 再调用本工具。",
      inputSchema: {
        note_id: z.string().min(1).describe("要删除的笔记 id"),
      },
    },
    async ({ note_id }) => {
      const res = await api(`/api/notes/${encodeURIComponent(note_id)}`, { method: "DELETE" });
      if (res.status !== 200) return errorResult(res.status, res.body);
      return jsonResult({ deleted: true, note_id, hint: "软删除：约 30 分钟内可用 restore_notes 恢复" });
    }
  );

  server.registerTool(
    "restore_notes",
    {
      title: "恢复删除的笔记",
      description:
        "恢复刚删除（软删除）的笔记，支持批量。只对删除后约 30 分钟内、尚未被清理的笔记有效。用户说「刚才删错了，恢复一下」时用这个工具。",
      inputSchema: {
        note_ids: z.array(z.string().min(1)).min(1).max(100).describe("要恢复的笔记 id 列表"),
      },
    },
    async ({ note_ids }) => {
      const res = await api("/api/notes/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: note_ids }),
      });
      if (res.status !== 200) return errorResult(res.status, res.body);
      const body = res.body as { restored?: number };
      return jsonResult({ restored: body.restored ?? 0 });
    }
  );

  return server;
}
