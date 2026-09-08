// R332 生产 QA 公共库：口径与 qa-r331/prod/lib.mjs 完全一致（needle / semHits / lcs8 / 占位 / 中性话术），只改账号前缀与输出目录；
// 语料仍取 qa-r331/out/{blind,oracle}.json（`npx tsx scripts/qa-r331/export-corpus.ts` 生成），R331 语料即本轮验收基准。
export * from "../../qa-r331/prod/lib.mjs";
import { register as r322Register, req } from "../../qa-r322/prod/lib.mjs";
// R334 起回归重跑时通过 QA_PREFIX 覆盖账号前缀（语料 / 口径不变）
export const QA_PREFIX = process.env.QA_PREFIX ?? "[QA-R332]";
export const OUT = new URL("../out", import.meta.url).pathname;

export async function register(name) {
  if (!name.startsWith(QA_PREFIX)) throw new Error("QA account must start with " + QA_PREFIX);
  if (!process.env.QA_INVITE_CODE) throw new Error("QA_INVITE_CODE not set (ask parent session; never commit it)");
  const a = await r322Register(name);
  delete a.password;
  return a;
}
