// R337 运行时 QA 公共库：沿用 qa-r335/qa-r336 的 HTTP/MCP 客户端与测量口径，只改默认前缀与输出目录。
// 纪律同前：[QA-R337] 前缀、随机密码不落盘、邀请码仅 QA_INVITE_CODE 运行时注入、测后注销。
process.env.QA_PREFIX ??= "[QA-R337]";
process.env.QA_OUT ??= new URL(process.env.QA_API && !process.env.QA_API.includes("zalize.com") ? "../out-local" : "../out", import.meta.url).pathname;
const m = await import("../../qa-r336/prod/lib.mjs");
export const { API, QA_PREFIX, OUT, sleep, J, load, req, register, postNote, getNote, setSensitive, ask, askStream, McpSession, secretHits, factHit, isPlaceholder, isNeutral, isNoAnswer, dupMarks, cardWithheld, deleteAccount, health } = m;
/**
 * 计数句只认 R336 计数句族（src/sensitive-recall FOLDED_REF_COUNT_RE 同形：「其中 N 条引用为敏感/受守笔记（」/「有 N 条敏感笔记可能相关（」）。
 * qa-r336 的宽正则会先匹到普通段的溢出提示「另有 N 条相关敏感笔记未列出」（本机 E09/mcp 复现），把合并体的计数误判为不等。
 */
export const FOLDED_COUNT_RE = /(?:其中|有)\s*(\d+)\s*条(?:引用为)?敏感(?:\/受守)?笔记(?:可能相关)?[（(]/u;
export const foldedCount = (s) => { const mm = FOLDED_COUNT_RE.exec(String(s ?? "")); return mm ? Number(mm[1]) : null; };
