import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, type ApiCall } from "./server.js";
import { SENSITIVE_PLACEHOLDER } from "./lib.js";

type Call = { path: string; init?: RequestInit };

function fakeApi(routes: Record<string, { status: number; body: unknown }>, calls: Call[]): ApiCall {
  return async (path, init) => {
    calls.push({ path, init });
    const method = init?.method ?? "GET";
    const hit = routes[`${method} ${path.split("?")[0]}`] ?? routes[`${method} *`];
    if (!hit) return { status: 404, body: { error: "not found" } };
    return hit;
  };
}

async function connect(api: ApiCall) {
  const server = buildMcpServer(api);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("stdio MCP server tools", () => {
  it("registers the full tool set (parity with the remote server)", async () => {
    const client = await connect(fakeApi({}, []));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask",
      "complete_todo",
      "delete_note",
      "get_thread",
      "get_weekly_report",
      "list_threads",
      "list_todos",
      "restore_notes",
      "save_note",
      "search_notes",
      "set_todo_due",
    ]);
  });

  it("search_notes forwards category/tag/source/from/to filters", async () => {
    const calls: Call[] = [];
    const client = await connect(fakeApi({ "GET /api/notes": { status: 200, body: { notes: [] } } }, calls));
    await client.callTool({
      name: "search_notes",
      arguments: { query: "x", category: "todo", tag: "工作", source: "extension", from: "2026-08-01", to: "2026-08-09" },
    });
    const params = new URLSearchParams(calls[0].path.split("?")[1]);
    expect(params.get("category")).toBe("todo");
    expect(params.get("tag")).toBe("工作");
    expect(params.get("source")).toBe("extension");
    expect(params.get("from")).toBe("2026-08-01");
    expect(params.get("to")).toBe("2026-08-09");
  });

  it("search_notes redacts sensitive notes", async () => {
    const client = await connect(
      fakeApi(
        {
          "GET /api/notes": {
            status: 200,
            body: {
              notes: [
                { id: "a", content: "普通", category: "idea", is_sensitive: false },
                { id: "b", content: "机密", title: "银行卡密码", tags: ["密码"], category: "data", is_sensitive: true },
              ],
            },
          },
        },
        []
      )
    );
    const res = await client.callTool({ name: "search_notes", arguments: { query: "x" } });
    const notes = JSON.parse((res.content as { text: string }[])[0].text).notes;
    expect(notes[0].content).toBe("普通");
    expect(notes[1].content).toBe(SENSITIVE_PLACEHOLDER);
  });

  it("delete_note soft-deletes and hints at restore_notes", async () => {
    const calls: Call[] = [];
    const client = await connect(fakeApi({ "DELETE /api/notes/n1": { status: 200, body: { ok: true } } }, calls));
    const res = await client.callTool({ name: "delete_note", arguments: { note_id: "n1" } });
    expect(calls[0].init?.method).toBe("DELETE");
    const out = JSON.parse((res.content as { text: string }[])[0].text);
    expect(out.deleted).toBe(true);
    expect(out.hint).toContain("restore_notes");
  });

  it("restore_notes posts ids to /api/notes/restore", async () => {
    const calls: Call[] = [];
    const client = await connect(
      fakeApi({ "POST /api/notes/restore": { status: 200, body: { ok: true, restored: 2 } } }, calls)
    );
    const res = await client.callTool({ name: "restore_notes", arguments: { note_ids: ["a", "b"] } });
    expect(JSON.parse(String(calls[0].init?.body)).ids).toEqual(["a", "b"]);
    expect(JSON.parse((res.content as { text: string }[])[0].text).restored).toBe(2);
  });

  it("set_todo_due patches todo_due and can clear it with null", async () => {
    const calls: Call[] = [];
    const client = await connect(
      fakeApi(
        { "PATCH /api/notes/n1": { status: 200, body: { note: { id: "n1", todo_due: "2026-08-12", is_sensitive: false } } } },
        calls
      )
    );
    await client.callTool({ name: "set_todo_due", arguments: { note_id: "n1", due: "2026-08-12" } });
    expect(JSON.parse(String(calls[0].init?.body)).todo_due).toBe("2026-08-12");
    await client.callTool({ name: "set_todo_due", arguments: { note_id: "n1", due: null } });
    expect(JSON.parse(String(calls[1].init?.body)).todo_due).toBeNull();
  });

  it("list_todos filters out done todos by default", async () => {
    const client = await connect(
      fakeApi(
        {
          "GET /api/notes": {
            status: 200,
            body: {
              notes: [
                { id: "a", content: "未完成", category: "todo", todo_done: false },
                { id: "b", content: "已完成", category: "todo", todo_done: true },
              ],
            },
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
