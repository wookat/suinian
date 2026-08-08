#!/usr/bin/env node
/**
 * 碎念 Suinian MCP server（本地 stdio 版）。
 *
 * 工具集与远程版（https://suinian-api.zalize.com/mcp）完全一致，直接调用碎念
 * REST API，鉴权用你自己的 API token（设置页可查看/复制）：
 *
 *   SUINIAN_API_TOKEN=<你的 token> [SUINIAN_API_URL=https://suinian-api.zalize.com] npx suinian-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { redactNote, redactNotes, jsonResult, errorResult, type NoteLike } from "./lib.js";

const API_URL = (process.env.SUINIAN_API_URL || "https://suinian-api.zalize.com").replace(/\/+$/, "");
const API_TOKEN = (process.env.SUINIAN_API_TOKEN || "").trim();

if (!API_TOKEN) {
  console.error("suinian-mcp: 缺少 SUINIAN_API_TOKEN 环境变量（在碎念设置页复制你的 API token）");
  process.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const server = new McpServer({ name: "suinian", version: "0.1.0" });

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
    return jsonResult({ saved: true, note: redactNote(note as NoteLike) });
  }
);

server.registerTool(
  "search_notes",
  {
    title: "搜索碎念",
    description:
      "按关键词搜索笔记，自动混合关键词匹配与语义（embedding）召回，返回匹配的笔记原文列表。想找某几条笔记原文、按标签/分类筛选时用这个；如果用户想要总结性的回答（如「我之前对 X 是怎么想的」），用 ask 工具。",
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
    const body = res.body as { notes: NoteLike[] };
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
    const body = res.body as { answer: string; references: unknown; notes: NoteLike[] };
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
    const body = res.body as { thread: unknown; notes: NoteLike[] };
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
    const body = res.body as { notes: (NoteLike & { todo_done?: unknown })[] };
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
    const body = res.body as { note: NoteLike };
    return jsonResult({ completed: true, note: redactNote(body.note) });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`suinian-mcp: connected (api: ${API_URL})`);
