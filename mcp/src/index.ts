#!/usr/bin/env node
/**
 * 碎念 Suinian MCP server（本地 stdio 版）。
 *
 * 工具集与远程版（https://suinian-api.zalize.com/mcp）完全一致，直接调用碎念
 * REST API，鉴权用你自己的 API token（设置页可查看/复制）：
 *
 *   SUINIAN_API_TOKEN=<你的 token> [SUINIAN_API_URL=https://suinian-api.zalize.com] npx suinian-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, type ApiCall } from "./server.js";

const API_URL = (process.env.SUINIAN_API_URL || "https://suinian-api.zalize.com").replace(/\/+$/, "");
const API_TOKEN = (process.env.SUINIAN_API_TOKEN || "").trim();

if (!API_TOKEN) {
  console.error("suinian-mcp: 缺少 SUINIAN_API_TOKEN 环境变量（在碎念设置页复制你的 API token）");
  process.exit(1);
}

const api: ApiCall = async (path, init) => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const server = buildMcpServer(api);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`suinian-mcp: connected (api: ${API_URL})`);
