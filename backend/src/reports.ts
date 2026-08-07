import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";

/**
 * Week boundaries in Asia/Shanghai for "last week" relative to `now`:
 * returns { weekStart, weekEnd } as YYYY-MM-DD (Monday .. Sunday inclusive).
 */
export function lastWeekRange(now: Date = new Date()): { weekStart: string; weekEnd: string } {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  const dow = sh.getUTCDay(); // 0=Sun
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() - daysSinceMonday));
  const lastMonday = new Date(thisMonday.getTime() - 7 * 86400 * 1000);
  const lastSunday = new Date(thisMonday.getTime() - 1 * 86400 * 1000);
  return { weekStart: lastMonday.toISOString().slice(0, 10), weekEnd: lastSunday.toISOString().slice(0, 10) };
}

/** Current week (Monday..today) in Asia/Shanghai. */
export function thisWeekRange(now: Date = new Date()): { weekStart: string; weekEnd: string } {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  const daysSinceMonday = (sh.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() - daysSinceMonday));
  return { weekStart: monday.toISOString().slice(0, 10), weekEnd: sh.toISOString().slice(0, 10) };
}

const CATEGORY_LABEL: Record<string, string> = { idea: "想法", todo: "待办", collect: "收藏", data: "资料" };

/** Escape user-controlled text embedded into fallback markdown so it can never carry HTML/code into the renderer. */
export function escapeMdText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "'");
}

export function fallbackMarkdown(weekStart: string, weekEnd: string, allNotes: NoteRow[]): string {
  // sensitive notes are excluded entirely (even their titles), matching the AI digest path
  const notes = allNotes.filter((n) => !n.is_sensitive);
  const byCat = new Map<string, NoteRow[]>();
  for (const n of notes) {
    const k = n.category ?? "idea";
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(n);
  }
  let md = `# 碎念周报（${weekStart} ~ ${weekEnd}）\n\n本周共记录 ${notes.length} 条。\n`;
  for (const [cat, rows] of byCat) {
    md += `\n## ${CATEGORY_LABEL[cat] ?? cat}（${rows.length}）\n`;
    for (const n of rows) md += `- ${escapeMdText((n.title || n.content).slice(0, 60))}\n`;
  }
  return md;
}

/**
 * Generate & store the weekly report for one user. Returns the report id.
 * Regenerating for the same week replaces the previous report.
 */
export async function generateWeeklyReport(
  env: Env,
  userId: string,
  now: Date = new Date(),
  week: "last" | "this" = "last"
): Promise<{ id: string; week_start: string } | null> {
  const { weekStart, weekEnd } = week === "this" ? thisWeekRange(now) : lastWeekRange(now);
  // notes created during [weekStart, weekEnd] in Shanghai time = UTC range shifted by -8h
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ?
       AND datetime(created_at, '+8 hours') >= datetime(? || ' 00:00:00')
       AND datetime(created_at, '+8 hours') <= datetime(? || ' 23:59:59')
     ORDER BY created_at ASC LIMIT 300`
  )
    .bind(userId, weekStart, weekEnd)
    .all<NoteRow>();
  const notes = results ?? [];
  // no notes this week: don't store an empty "0 条" report
  if (notes.length === 0) return null;

  let md = fallbackMarkdown(weekStart, weekEnd, notes);
  {
    try {
      const digest = notes
        .filter((n) => !n.is_sensitive)
        .map((n, i) => `${i + 1}. [${CATEGORY_LABEL[n.category ?? "idea"]}] (${n.created_at.slice(0, 10)}) ${(n.title || n.content).slice(0, 200)}`)
        .join("\n");
      const text = (
        await chatComplete(env, {
          temperature: 0.4,
          max_tokens: 1200,
          timeout_ms: 40_000,
          messages: [
            {
              role: "system",
              content: `你是「碎念」周报助手。根据用户上周（${weekStart} ~ ${weekEnd}）记录的碎片，写一份 markdown 周报：一级标题为「碎念周报（${weekStart} ~ ${weekEnd}）」，内容包括：本周概览（数量/主题分布）、主要在想什么（归纳 2-4 个主题并展开）、待办盘点（完成/未完成）、值得回顾的收藏。语气亲切、简洁，用中文。不要编造笔记中没有的内容。`,
            },
            { role: "user", content: digest || "（本周没有记录）" },
          ],
        })
      )?.trim();
      if (text) md = text;
    } catch {
      /* fall back to the plain summary */
    }
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM weekly_reports WHERE user_id = ? AND week_start = ?"
  )
    .bind(userId, weekStart)
    .first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE weekly_reports SET content_md = ?, created_at = datetime('now') WHERE id = ?")
      .bind(md, existing.id)
      .run();
    return { id: existing.id, week_start: weekStart };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO weekly_reports (id, user_id, week_start, content_md) VALUES (?, ?, ?, ?)"
  )
    .bind(id, userId, weekStart, md)
    .run();
  return { id, week_start: weekStart };
}

/** Weekly cron: generate reports for all users. */
export async function generateAllWeeklyReports(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
  for (const u of results ?? []) {
    try {
      await generateWeeklyReport(env, u.id);
    } catch {
      /* per-user failures shouldn't stop the sweep */
    }
  }
}
