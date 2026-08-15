/**
 * 文档防漂移：README / docs/mcp.md 的工具清单必须与实际注册的工具集完全一致。
 * 新增/删除工具而没同步文档时，这个测试会挂掉（R135 P2-3）。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

async function registeredToolNames(): Promise<string[]> {
  const server = buildMcpServer(async () => ({ status: 404, body: {} }));
  const client = new Client({ name: "docs-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

/** 从一段文档文本里抽出所有反引号包裹的 snake_case 工具名（去重排序）。 */
function toolNamesInDoc(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) names.add(m[1]);
  return [...names].sort();
}

describe("MCP 文档工具清单与实现对齐", () => {
  it("mcp/README.md 工具集一行列全所有工具", async () => {
    const readme = readFileSync(resolve(here, "../README.md"), "utf8");
    const line = readme.split("\n").find((l) => l.includes("工具集"));
    expect(line, "README.md 应包含「工具集」清单行").toBeTruthy();
    expect(toolNamesInDoc(line!)).toEqual(await registeredToolNames());
  });

  it("docs/mcp.md 工具集表格列全所有工具", async () => {
    const doc = readFileSync(resolve(here, "../../docs/mcp.md"), "utf8");
    const section = doc.split(/^## 工具集$/m)[1]?.split(/^## /m)[0];
    expect(section, "docs/mcp.md 应包含「## 工具集」小节").toBeTruthy();
    // 只取表格每行第一列（工具名列），第二列说明里的参数名不算
    const names = new Set<string>();
    for (const line of section!.split("\n")) {
      const cell = line.match(/^\|([^|]+)\|/)?.[1];
      if (cell) for (const n of toolNamesInDoc(cell)) names.add(n);
    }
    expect([...names].sort()).toEqual(await registeredToolNames());
  });
});
