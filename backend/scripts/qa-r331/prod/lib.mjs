// R331 生产 QA 公共库：复用 R331 链（R311→R329）的请求/注册（QA_INVITE_CODE 环境变量，绝不打印、绝不落盘）/入库/MCP/ask/SSE/归一化口径，
// 只改账号前缀与输出目录；新增 semHits（语义转写命中：`a|b|c` 任一归一化子串命中）。
export * from "../../qa-r329/prod/lib.mjs";
import { register as r322Register, req, sleep } from "../../qa-r322/prod/lib.mjs";
import { norm } from "../../qa-r325/prod/lib.mjs";
export const QA_PREFIX = "[QA-R331]";
export const OUT = new URL("../out", import.meta.url).pathname;

export async function register(name) {
  if (!name.startsWith(QA_PREFIX)) throw new Error("QA account must start with " + QA_PREFIX);
  if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set (ask parent session; never commit it)");
  const a = await r322Register(name);
  delete a.password;
  return a;
}
export { req, sleep };

/** semNeedles：每项形如 "w、5、pnq|w, 5, pnq"，任一备选归一化后为答案子串即命中（去角标）。 */
export const semHits = (ans, semNeedles = []) => {
  const a = norm(String(ans ?? "").replace(/\[\d+\]/g, ""));
  return semNeedles.filter((s) => String(s).split("|").some((alt) => norm(alt).length >= 2 && a.includes(norm(alt))));
};
