// R336 修改轮 · 运行时 QA 公共库：沿用 qa-r335 的 HTTP/MCP 客户端与测量口径（secretHits / factHit / isPlaceholder 等），
// 只改默认前缀与输出目录。纪律同 R335：[QA-R336] 前缀、随机密码不落盘、邀请码仅 QA_INVITE_CODE 运行时注入、测后注销。
process.env.QA_PREFIX ??= "[QA-R336]";
process.env.QA_OUT ??= new URL(process.env.QA_API && !process.env.QA_API.includes("zalize.com") ? "../out-local" : "../out", import.meta.url).pathname;
const m = await import("../../qa-r335/prod/lib.mjs");
export const { API, UA, QA_PREFIX, OUT, sleep, J, load, req, register, postNote, getNote, setSensitive, ask, askStream, McpSession, norm, secretHits, formHits, factHit, PLACEHOLDER_RE, isPlaceholder, NEUTRAL_RE, isNeutral, NOANSWER_RE, isNoAnswer, verdictOf } = m;
/**
 * 角标重复（audit-r335 §J「[1][1]」/ R336 §6）：同一角标紧邻重复（`[2][2]` / `[2] [2]`）才算缺陷；
 * 不同句子各引一次同一条（「…储物柜 [1]。…没提到密码 [1]。」）是正常引用，qa-r335 的 dupMarks 把它也计入，
 * R336 按缺陷形态测量。references 里同一 note_id 出现两次由 fold 步的 ref_ids_unique 单独测。
 */
export const dupMarks = (s) => { const ms = [...String(s ?? "").matchAll(/\[(\d{1,2})\](?:\s*\[\1\])+/g)].map((m) => m[0]); return ms.length > 0 ? ms : null; };
/** R336 计数句（含 R334 「另有/有 N 条敏感笔记」与 R336 「其中 N 条引用为敏感/受守笔记」两式）。 */
export const FOLDED_COUNT_RE = /(另有|有|其中)\s*(\d+)\s*条(?:引用为)?[^，。；\n]{0,8}?敏感(?:\/受守)?笔记/;
export const foldedCount = (s) => { const mm = FOLDED_COUNT_RE.exec(String(s ?? "")); return mm ? Number(mm[2]) : null; };
/** 卡片是否占位（content_withheld / guarded / 敏感占位体）。 */
export const cardWithheld = (n) => !!n && (n.content_withheld === true || n.guarded === true || /\[含口令|\[敏感笔记|已折叠/.test(String(n.content ?? "")));
export async function deleteAccount(token) { return req("/api/auth/me", { method: "DELETE", token }); }
export async function health() { const r = await req("/health?probe=ai"); return r.json; }
