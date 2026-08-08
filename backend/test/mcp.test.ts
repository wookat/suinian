import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, redactNote, MCP_SENSITIVE_PLACEHOLDER } from "../src/mcp";

describe("redactNote", () => {
  it("replaces content, title and tags of sensitive notes", () => {
    const n = redactNote({ is_sensitive: true, content: "wifi 密码 hunter2", title: "家里 wifi 密码", tags: ["密码"] });
    expect(n.content).toBe(MCP_SENSITIVE_PLACEHOLDER);
    expect(n.title).toBe(MCP_SENSITIVE_PLACEHOLDER);
    expect(n.tags).toEqual([]);
  });

  it("leaves normal notes untouched", () => {
    const n = redactNote({ is_sensitive: false, content: "今天想到一个点子", title: "点子", tags: ["想法"] });
    expect(n.content).toBe("今天想到一个点子");
    expect(n.title).toBe("点子");
    expect(n.tags).toEqual(["想法"]);
  });
});

type Call = { path: string; init?: RequestInit };

function fakeApi(routes: Record<string, { status: number; body: unknown }>, calls: Call[]) {
  return async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const method = init?.method ?? "GET";
    const key = `${method} ${path.split("?")[0]}`;
    const hit = routes[key] ?? routes[`${method} *`];
    if (!hit) return { status: 404, body: { error: "not found" } };
    return hit;
  };
}

async function connect(api: Parameters<typeof buildMcpServer>[0]) {
  const server = buildMcpServer(api);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("MCP server tools", () => {
  it("registers the full tool set", async () => {
    const client = await connect(fakeApi({}, []));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask",
      "complete_todo",
      "get_thread",
      "get_weekly_report",
      "list_threads",
      "list_todos",
      "save_note",
      "search_notes",
    ]);
  });

  it("save_note posts to /api/notes with source=mcp and patches manual category", async () => {
    const calls: Call[] = [];
    const client = await connect(
      fakeApi(
        {
          "POST /api/notes": { status: 201, body: { note: { id: "n1", content: "买牛奶", is_sensitive: false } } },
          "PATCH /api/notes/n1": { status: 200, body: { note: { id: "n1", content: "买牛奶", category: "todo", is_sensitive: false } } },
        },
        calls
      )
    );
    const res = await client.callTool({ name: "save_note", arguments: { content: "买牛奶", category: "todo" } });
    expect(res.isError).toBeFalsy();
    expect(calls[0].path).toBe("/api/notes");
    expect(JSON.parse(String(calls[0].init?.body)).source).toBe("mcp");
    expect(calls[1].path).toBe("/api/notes/n1");
    const text = (res.content as { text: string }[])[0].text;
    expect(JSON.parse(text).note.category).toBe("todo");
  });

  it("search_notes redacts sensitive notes", async () => {
    const client = await connect(
      fakeApi(
        {
          "GET /api/notes": {
            status: 200,
            body: {
              notes: [
                { id: "a", content: "普通", is_sensitive: false },
                { id: "b", content: "机密", title: "银行卡密码", tags: ["密码"], is_sensitive: true },
              ],
            },
          },
        },
        []
      )
    );
    const res = await client.callTool({ name: "search_notes", arguments: { query: "x" } });
    const text = (res.content as { text: string }[])[0].text;
    const notes = JSON.parse(text).notes;
    expect(notes[0].content).toBe("普通");
    expect(notes[1].content).toBe(MCP_SENSITIVE_PLACEHOLDER);
    expect(notes[1].title).toBe(MCP_SENSITIVE_PLACEHOLDER);
    expect(notes[1].tags).toEqual([]);
    expect(text).not.toContain("银行卡密码");
  });

  it("list_todos filters out done todos by default", async () => {
    const client = await connect(
      fakeApi(
        {
          "GET /api/notes": {
            status: 200,
            body: { notes: [{ id: "a", content: "未完成", todo_done: false }, { id: "b", content: "已完成", todo_done: true }] },
          },
        },
        []
      )
    );
    const res = await client.callTool({ name: "list_todos", arguments: {} });
    const todos = JSON.parse((res.content as { text: string }[])[0].text).todos;
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe("a");
  });

  it("surfaces API errors as isError results", async () => {
    const client = await connect(fakeApi({ "POST /api/ask": { status: 400, body: { error: "question required" } } }, []));
    const res = await client.callTool({ name: "ask", arguments: { question: "q" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("question required");
  });
});
