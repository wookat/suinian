// R325 生产 QA 公共库：复用 R324/R323 的请求/注册（QA_INVITE_CODE 环境变量，绝不打印、绝不落盘）/入库/MCP/ask/SSE/归一化口径，只改账号前缀与输出目录。
export * from "../../qa-r324/prod/lib.mjs";
import { register as r322Register, req, sleep } from "../../qa-r322/prod/lib.mjs";
export const QA_PREFIX = "[QA-R325]";
export const OUT = new URL("../out", import.meta.url).pathname;

export async function register(name) {
  if (!name.startsWith(QA_PREFIX)) throw new Error("QA account must start with " + QA_PREFIX);
  if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set (ask parent session; never commit it)");
  const a = await r322Register(name);
  delete a.password;
  return a;
}
export { req, sleep };
