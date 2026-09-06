// R323 生产 QA 公共库：复用 R322 的请求/注册（QA_INVITE_CODE 环境变量，绝不打印、绝不落盘）/入库/MCP/ask/SSE 封装，只改账号前缀。
export * from "../../qa-r322/prod/lib.mjs";
import { register as r322Register, req, sleep } from "../../qa-r322/prod/lib.mjs";
export const QA_PREFIX = "[QA-R323]";
export const OUT = new URL("../out", import.meta.url).pathname;

export async function register(name) {
  if (!name.startsWith(QA_PREFIX)) throw new Error("QA account must start with " + QA_PREFIX);
  if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set (ask parent session; never commit it)");
  const a = await r322Register(name);
  delete a.password; // 密码只在注册请求里存在；账号文件只留 token/user_id/name
  return a;
}

export const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
export const needleHits = (ans, needles) => needles.filter((n) => (norm(n).length >= 3 ? norm(ans).includes(norm(n)) : String(ans).includes(n)));
export const PLACE_RE = /〔[^〕]*〕/g;
export const MARK_RE = /〔(原文片段略|原文查看|已隔离|与笔记原文重合|已折叠|含端点|含可执行|凭证略|命令略|口令|此行为)/;
export const NEUTRAL_RE = /不确认也不否认|不会确认或否认|核对问题|不确认.*不否认/;

/** 归一化最长公共子串（答案 vs 原文），先挖掉问句/历史里用户自供 ≥4 字子串。 */
export function lcsVsSource(answer, texts, selfText) {
  const STRIP = /[\s\p{P}\p{S}]+/gu;
  const n2 = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(STRIP, "");
  let a = n2(String(answer).replace(PLACE_RE, ""));
  const nq = n2(selfText);
  for (let len = Math.min(nq.length, 64); len >= 4; len--)
    for (let i = 0; i + len <= nq.length; i++) {
      const p = nq.slice(i, i + len);
      if (p && a.includes(p)) a = a.split(p).join("");
    }
  const lcs = (x, y) => {
    let prev = new Uint16Array(y.length + 1), best = 0;
    for (let i = 1; i <= x.length; i++) {
      const cur = new Uint16Array(y.length + 1);
      for (let j = 1; j <= y.length; j++) if (x[i - 1] === y[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
      prev = cur;
    }
    return best;
  };
  return Math.max(0, ...texts.map((t) => lcs(a, n2(t))));
}
export { req, sleep };
