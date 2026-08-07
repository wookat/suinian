import type { Category, TriageResult } from "./types";
import { chatComplete } from "./ai";

const CATEGORIES: Category[] = ["idea", "todo", "collect", "data"];

export const FALLBACK_TRIAGE: TriageResult = {
  category: "idea",
  tags: [],
  title: "",
  is_sensitive: false,
  todo_due: null,
};

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** Date in Asia/Shanghai (offset by `offsetDays`) as { iso: "YYYY-MM-DD", weekday: "周X" }. */
export function shanghaiDate(now: Date = new Date(), offsetDays = 0): { iso: string; weekday: string } {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000 + offsetDays * 86400_000);
  return { iso: sh.toISOString().slice(0, 10), weekday: WEEKDAYS_ZH[sh.getUTCDay()] };
}

/** Current date in Asia/Shanghai as { iso: "YYYY-MM-DD", weekday: "周X" }. */
export function todayInShanghai(now: Date = new Date()): { iso: string; weekday: string } {
  return shanghaiDate(now, 0);
}

/** Date of 下周一 (next week's Monday) in Asia/Shanghai. */
export function nextMondayInShanghai(now: Date = new Date()): { iso: string; weekday: string } {
  const dow = new Date(now.getTime() + 8 * 3600 * 1000).getUTCDay();
  const days = (8 - dow) % 7 || 7;
  return shanghaiDate(now, days);
}

/** Build the triage system prompt. Exported for testing. */
export function buildTriagePrompt(now: Date = new Date(), existingTags: string[] = []): string {
  const { iso, weekday } = todayInShanghai(now);
  const tomorrow = shanghaiDate(now, 1);
  const nextMon = nextMondayInShanghai(now);
  const tagHint = existingTags.length
    ? `\n用户已有标签（优先复用其中的词，不要新造近义词）：${existingTags.slice(0, 50).join("、")}`
    : "";
  return `你是「碎念」笔记分拣助手。今天是 ${iso}（${weekday}），北京时间（Asia/Shanghai）。相对日期一律基于今天换算，例如：「明天」= ${tomorrow.iso}（${tomorrow.weekday}）；「下周一」= ${nextMon.iso}（下一个周一，注意不是周二）。用户会丢来一条碎片信息，你输出严格 JSON（不要 markdown 代码块），字段：
- category，四选一：
  - "idea"：自己的想法/思考/灵感/感受，既不需要去做，也不是外部资源
  - "todo"：需要用户去做的事，通常有动作（买/交/回/约/换/提醒我）；没写时间也可以是待办
  - "collect"：收藏的外部链接/文章/视频/资源，内容以 URL 或“稍后看”为主
  - "data"：需要保存备查的资料/参考信息/流程说明/密码/账号/号码，重点是“查”而不是“做”
  判例：
  - 「公司报销流程：先在 OA 提单，再贴发票给财务」→ data（流程性参考，无待办动作）
  - 「9月1号起各部门预算表改用新模板」→ data（带日期的说明仍是资料，不是待办）
  - 「9月1号起预算表改用新模板，找行政领新版」→ todo（制度/流程变更但含需要本人去做的动作，如“找…领”“去…办”，以动作为准归 todo）
  - 「回头把冰箱滤芯换了」→ todo（无时间也是待办，todo_due=null）
  - 「https://example.com/abc 一篇讲向量检索的文章」→ collect（纯链接即收藏）
  - 「明天下午3点和设计师对稿」→ todo，todo_due=${tomorrow.iso}T15:00:00+08:00
  - 「下周一晚上8点提醒我给客户回邮件」→ todo，todo_due=${nextMon.iso}T20:00:00+08:00
  - 「Wi-Fi 密码是 xxxx」→ data，且 is_sensitive=true
  - 「感觉周报功能可以做成邮件推送」→ idea
- tags: 1-3 个中文短标签数组（宁少勿多，纯词即可，不要 # 前缀）。标签必须是内容的主题词，不得照抄内容开头的括号前缀/标记/序号（如「[xxx]」「【xxx】」「1.」之类）${tagHint}
- title: 一句话短标题（<=20字），同样不要把括号前缀/序号抄进标题
- is_sensitive: 是否含敏感信息 (boolean)。只要内容中出现密码、口令、密钥、API key、token、验证码、身份证号、银行卡号、账号+密码组合等任何一项，必须为 true，宁可误判为 true
- todo_due: 若是待办且能推断截止时间，基于上面给出的今天日期与星期换算（如"周五之前"= 从今天起最近的周五）。内容中有具体时刻（如"下午三点半""晚上8点"）时输出带时刻和时区偏移的 ISO 8601 "YYYY-MM-DDTHH:mm:00+08:00"（24 小时制，Asia/Shanghai 固定 +08:00，如 "2026-08-07T15:30:00+08:00"）；只有日期没有时刻时仅输出 "YYYY-MM-DD"；无法推断则 null。绝不要输出早于今天的日期
只输出 JSON。标签禁止包含密码、密钥、卡号等敏感值本身。`;
}

// ---- sensitive detection fallback (regex) ----
const SENSITIVE_KEYWORD_RE =
  /密码|口令|密钥|秘钥|私钥|passw(or)?d|passphrase|secret|api[\s_-]?key|token|access[\s_-]?key|验证码|身份证|银行卡|卡号|cvv|pin\s?码/i;
const SENSITIVE_VALUE_RE =
  /(密码|口令|passw(or)?d|pwd)[^\S\n]*[:：是为]?[^\S\n]*\S{4,}|\b\d{15,19}\b|\b[A-Za-z0-9_\-]{20,}\b|sk-[A-Za-z0-9]{10,}/i;

/** Regex fallback: does the content look like it contains a credential/secret? */
export function detectSensitive(content: string): boolean {
  if (!SENSITIVE_KEYWORD_RE.test(content)) return false;
  return SENSITIVE_VALUE_RE.test(content) || /密码|口令|密钥|秘钥|私钥|验证码|身份证|银行卡/.test(content);
}

const TAG_SECRET_RE = /^(?=.*\d)[A-Za-z0-9_\-@#$%.]{6,}$|^\d{6,}$|^sk-/i;

/** Drop tags that look like sensitive values (long alnum strings, digit runs, key prefixes). */
export function sanitizeTags(tags: string[]): string[] {
  return tags.filter((t) => !TAG_SECRET_RE.test(t.trim())).slice(0, 3);
}

const TODO_DUE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?\s*(Z|[+-]\d{2}:?\d{2})?)?/;

function normalizeOffset(raw: string | undefined): string {
  if (!raw || raw === "Z") return raw === "Z" ? "+00:00" : "+08:00";
  return raw.includes(":") ? raw : `${raw.slice(0, 3)}:${raw.slice(3)}`;
}

/**
 * Normalize a todo_due into "YYYY-MM-DD" (date-only) or offset ISO 8601
 * "YYYY-MM-DDTHH:mm:00+08:00" (timed; bare local times are Asia/Shanghai).
 */
export function normalizeTodoDue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(TODO_DUE_RE);
  if (!m) return null;
  if (!m[2]) return m[1];
  return `${m[1]}T${m[2]}:00${normalizeOffset(m[3])}`;
}

/** Parse the LLM output into a TriageResult; returns null when invalid. */
export function parseTriageJson(text: string): TriageResult | null {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const category = o.category;
  if (typeof category !== "string" || !CATEGORIES.includes(category as Category)) return null;
  const tags = Array.isArray(o.tags)
    ? sanitizeTags(o.tags.filter((t): t is string => typeof t === "string" && t.length > 0))
    : [];
  const title = typeof o.title === "string" ? o.title : "";
  const is_sensitive = o.is_sensitive === true;
  const todo_due = normalizeTodoDue(o.todo_due);
  return { category: category as Category, tags, title, is_sensitive, todo_due };
}

/** Load the user's 50 most-used tags for prompt reuse. */
export async function loadTopTags(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT tags FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 500")
    .bind(userId)
    .all<{ tags: string }>();
  const counts = new Map<string, number>();
  for (const r of results ?? []) {
    try {
      for (const t of JSON.parse(r.tags || "[]") as string[]) {
        if (typeof t === "string" && t) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    } catch {
      /* ignore bad rows */
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t]) => t);
}

export async function triageNote(
  content: string,
  env: Parameters<typeof chatComplete>[0],
  existingTags: string[] = []
): Promise<TriageResult | null> {
  const text = await chatComplete(env, {
    temperature: 0.2,
    max_tokens: 300,
    messages: [
      { role: "system", content: buildTriagePrompt(new Date(), existingTags) },
      { role: "user", content: content.slice(0, 4000) },
    ],
  });
  let result = (text && parseTriageJson(text)) || null;
  // regex fallback: never let an obvious credential slip through as non-sensitive
  if (!result?.is_sensitive && detectSensitive(content)) {
    result = result
      ? { ...result, is_sensitive: true }
      : { ...FALLBACK_TRIAGE, category: "data", is_sensitive: true };
  }
  // null = AI unavailable: leave the note unsorted so the retry sweep picks it up
  return result;
}
