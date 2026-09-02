import type { Env } from "./types";

/**
 * R306 P0-1（audit-r305 §3）：出口维度的危险标注打点。Ask 的 guard_events
 * 只覆盖问答一条出口，周报/备份/Push/线索摘要/MCP/导出的漏标在监控上完全
 * 不可见。这里按 R302 口径（每请求每 kind 至多 +1，零值也写行）落
 * `outlet_<x>_requests` 与 `outlet_<x>_exec_marked_requests`，
 * 标注率 = exec_marked_requests / requests 可直接计算。无用户维度、无内容。
 */
export type GuardOutlet = "report" | "backup" | "export" | "push" | "thread" | "mcp" | "ask_ref";

export async function bumpGuardEvents(env: Env, rows: Array<[string, number]>): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  for (const [kind, n] of rows) {
    await env.DB.prepare(
      "INSERT INTO guard_events (day, kind, count, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(day, kind) DO UPDATE SET count = count + excluded.count, updated_at = datetime('now')"
    )
      .bind(day, kind, n)
      .run();
  }
}

export function recordOutletExecMarks(
  env: Env,
  outlet: GuardOutlet,
  markedNotes: number,
  waitUntil?: (p: Promise<unknown>) => void
): void {
  const work = bumpGuardEvents(env, [
    [`outlet_${outlet}_requests`, 1],
    [`outlet_${outlet}_exec_marked_requests`, markedNotes > 0 ? 1 : 0],
    [`outlet_${outlet}_exec_marked_notes`, markedNotes],
  ]).catch((err) => console.error(`guard_events(${outlet}) write failed`, err));
  if (waitUntil) {
    try {
      waitUntil(work);
    } catch {
      /* 单测/本地环境无 executionCtx：已 catch，不影响响应 */
    }
  }
}
