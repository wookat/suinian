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

/** Current date in Asia/Shanghai as { iso: "YYYY-MM-DD", weekday: "周X" }. */
export function todayInShanghai(now: Date = new Date()): { iso: string; weekday: string } {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  return { iso: sh.toISOString().slice(0, 10), weekday: WEEKDAYS_ZH[sh.getUTCDay()] };
}

/** Build the triage system prompt. Exported for testing. */
export function buildTriagePrompt(now: Date = new Date(), existingTags: string[] = []): string {
  const { iso, weekday } = todayInShanghai(now);
  const tagHint = existingTags.length
    ? `\n用户已有标签（优先复用其中的词，不要新造近义词）：${existingTags.slice(0, 50).join("、")}`
    : "";
  return `你是「碎念」笔记分拣助手。今天是 ${iso}（${weekday}，Asia/Shanghai）。用户会丢来一条碎片信息，你输出严格 JSON（不要 markdown 代码块），字段：
- category: "idea"(想法/思考) | "todo"(待办任务) | "collect"(收藏的链接/文章/资源) | "data"(资料/密码/账号/号码等需要保存的数据)
- tags: 1-3 个中文短标签数组（宁少勿多，纯词即可，不要 # 前缀）${tagHint}
- title: 一句话短标题（<=20字）
- is_sensitive: 是否含敏感信息 (boolean)。只要内容中出现密码、口令、密钥、API key、token、验证码、身份证号、银行卡号、账号+密码组合等任何一项，必须为 true，宁可误判为 true
- todo_due: 若是待办且能推断截止时间，基于上面给出的今天日期换算（如"周五之前"= 从今天起最近的周五；"明天"= 今天+1 天）。内容中有具体时刻（如"下午三点半""晚上8点"）时输出带时刻的 "YYYY-MM-DDTHH:mm"（24 小时制，Asia/Shanghai，如 "2026-08-07T15:30"）；只有日期没有时刻时仅输出 "YYYY-MM-DD"；无法推断则 null。绝不要输出早于今天的日期
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

const TODO_DUE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/;

/** Normalize an LLM todo_due into "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"; null when absent/invalid. */
export function normalizeTodoDue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(TODO_DUE_RE);
  if (!m) return null;
  return m[2] ? `${m[1]}T${m[2]}` : m[1];
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
