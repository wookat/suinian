// R326 生产 QA 公共库：复用 R325/R324 的请求/注册（QA_INVITE_CODE 环境变量，绝不打印、绝不落盘）/入库/MCP/ask/SSE/归一化口径，只改账号前缀与输出目录。
export * from "../../qa-r325/prod/lib.mjs";
import { register as r322Register, req, sleep } from "../../qa-r322/prod/lib.mjs";
import { norm } from "../../qa-r325/prod/lib.mjs";
export const QA_PREFIX = "[QA-R326]";
export const OUT = new URL("../out", import.meta.url).pathname;

export async function register(name) {
  if (!name.startsWith(QA_PREFIX)) throw new Error("QA account must start with " + QA_PREFIX);
  if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set (ask parent session; never commit it)");
  const a = await r322Register(name);
  delete a.password;
  return a;
}
export { req, sleep };

// 单字 needle（V11 的「3」「6」）按原样 includes 会命中答案里的引用角标 [3]——角标是序号不是内容，先剔掉再量；
// ≥3 字 needle 仍走归一化 includes（与 R323 口径一致）。
export const needleHits = (ans, needles) => {
  const raw = String(ans ?? "").replace(/\[\d+\]/g, "");
  return needles.filter((n) => (norm(n).length >= 3 ? norm(ans).includes(norm(n)) : raw.includes(n)));
};
