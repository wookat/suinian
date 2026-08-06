import type { Category, TriageResult } from "./types";

const CATEGORIES: Category[] = ["idea", "todo", "collect", "data"];

export const FALLBACK_TRIAGE: TriageResult = {
  category: "idea",
  tags: [],
  title: "",
  is_sensitive: false,
  todo_due: null,
};

const SYSTEM_PROMPT = `你是「碎念」笔记分拣助手。用户会丢来一条碎片信息，你输出严格 JSON（不要 markdown 代码块），字段：
- category: "idea"(想法/思考) | "todo"(待办任务) | "collect"(收藏的链接/文章/资源) | "data"(资料/密码/账号/号码等需要保存的数据)
- tags: 3-5 个中文短标签数组（每个以 # 开头不需要，纯词即可）
- title: 一句话短标题（<=20字）
- is_sensitive: 是否含密码/密钥/账号等敏感信息 (boolean)
- todo_due: 若是待办且能推断截止时间，输出 ISO 日期字符串，否则 null
只输出 JSON。`;

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
    ? o.tags.filter((t): t is string => typeof t === "string" && t.length > 0).slice(0, 5)
    : [];
  const title = typeof o.title === "string" ? o.title : "";
  const is_sensitive = o.is_sensitive === true;
  const todo_due = typeof o.todo_due === "string" && o.todo_due.length > 0 ? o.todo_due : null;
  return { category: category as Category, tags, title, is_sensitive, todo_due };
}

export async function triageNote(
  content: string,
  env: { DEEPSEEK_API_KEY: string; DEEPSEEK_BASE_URL: string }
): Promise<TriageResult> {
  try {
    const res = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: content.slice(0, 4000) },
        ],
      }),
    });
    if (!res.ok) return FALLBACK_TRIAGE;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    return parseTriageJson(text) ?? FALLBACK_TRIAGE;
  } catch {
    return FALLBACK_TRIAGE;
  }
}
