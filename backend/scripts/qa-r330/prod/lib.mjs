// R330 生产 QA 公共库：复用 R326/R325 的请求/注册（QA_INVITE_CODE 环境变量，绝不打印、绝不落盘）/入库/MCP/ask/SSE/归一化口径，
// 只改账号前缀与输出目录。
export * from "../../qa-r326/prod/lib.mjs";
import { register as r322Register, req, sleep } from "../../qa-r322/prod/lib.mjs";
export const QA_PREFIX = "[QA-R330]";
export const OUT = new URL("../out", import.meta.url).pathname;
export const CARD_PH = "敏感笔记：正文已加密保护";

export async function register(name) {
  if (!name.startsWith(QA_PREFIX)) throw new Error("QA account must start with " + QA_PREFIX);
  if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set (ask parent session; never commit it)");
  const a = await r322Register(name);
  delete a.password;
  return a;
}
export { req, sleep };

/** MCP tools/call 返回体（JSON 或 SSE data: 行）→ 解析成工具 JSON。 */
export function parseMcp(text) {
  try {
    const dataLine = String(text).split(/\r?\n/).find((l) => l.startsWith("data:"));
    const rpc = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    const t = rpc.result?.content?.find((c) => c.type === "text")?.text;
    return t ? JSON.parse(t) : rpc;
  } catch {
    return null;
  }
}
