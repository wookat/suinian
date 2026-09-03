import type { Env } from "./types";
import { noteRowBroadFoldReason, type BroadFoldReason } from "./prompt-armor";

/**
 * R306 P0-1（audit-r305 §3）：出口维度的危险标注打点。Ask 的 guard_events
 * 只覆盖问答一条出口，周报/备份/Push/线索摘要/MCP/导出的漏标在监控上完全
 * 不可见。这里按 R302 口径（每请求每 kind 至多 +1，零值也写行）落
 * `outlet_<x>_requests` 与 `outlet_<x>_exec_marked_requests`，
 * 标注率 = exec_marked_requests / requests 可直接计算。无用户维度、无内容。
 *
 * R310 P0-4（audit-r309 §14.4）：同一出口再落宽判据口径——
 *  `outlet_<x>_broad_fold_notes`   宽判据命中（含严判据）条数；
 *  `outlet_<x>_broad_only_notes`   宽命中但严未命中的差集（严判据漏判的可观测代理）；
 *  `outlet_<x>_broad_fold_requests` 本次请求存在任何宽命中（批量出口整体声明触发次数）。
 */
export type GuardOutlet = "report" | "backup" | "export" | "push" | "thread" | "mcp" | "ask" | "ask_ref" | "fragment" | "list" | "search" | "review";

export async function bumpGuardEvents(env: Pick<Env, "DB">, rows: Array<[string, number]>): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  for (const [kind, n] of rows) {
    await env.DB.prepare(
      "INSERT INTO guard_events (day, kind, count, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(day, kind) DO UPDATE SET count = count + excluded.count, updated_at = datetime('now')"
    )
      .bind(day, kind, n)
      .run();
  }
}

export interface OutletFoldCounts {
  /** 严判据（contains_executable_command / meta.exec_fragment）命中条数。 */
  strict: number;
  /** 宽判据命中条数（严判据命中必然计入）。 */
  broad: number;
}

/** 按笔记行统计一次出口的严/宽命中（宽判据以 noteRowBroadFoldReason 为准）。 */
export function countOutletFolds(
  rows: Array<{ content?: string | null; meta?: string | { exec_fragment?: boolean } | null; is_sensitive?: number | boolean | null }>
): OutletFoldCounts & { reasons: Array<BroadFoldReason | null> } {
  let strict = 0;
  let broad = 0;
  const reasons: Array<BroadFoldReason | null> = [];
  for (const r of rows) {
    if (r.is_sensitive) {
      reasons.push(null);
      continue;
    }
    const reason = noteRowBroadFoldReason(r);
    reasons.push(reason);
    if (reason !== null) broad++;
    if (reason === "strict") strict++;
  }
  return { strict, broad, reasons };
}

/** 一次出口请求的 guard_events 行（严/宽/差集），供需要 await 的调用点（cron 报告）直接 bump。 */
export function outletFoldEventRows(outlet: GuardOutlet, counts: OutletFoldCounts): Array<[string, number]> {
  const strict = Math.max(0, counts.strict);
  const broad = Math.max(strict, counts.broad);
  return [
    [`outlet_${outlet}_requests`, 1],
    [`outlet_${outlet}_exec_marked_requests`, strict > 0 ? 1 : 0],
    [`outlet_${outlet}_exec_marked_notes`, strict],
    [`outlet_${outlet}_broad_fold_requests`, broad > 0 ? 1 : 0],
    [`outlet_${outlet}_broad_fold_notes`, broad],
    [`outlet_${outlet}_broad_only_notes`, broad - strict],
  ];
}

export function recordOutletFoldMarks(
  env: Pick<Env, "DB">,
  outlet: GuardOutlet,
  counts: OutletFoldCounts,
  waitUntil?: (p: Promise<unknown>) => void
): void {
  const work = bumpGuardEvents(env, outletFoldEventRows(outlet, counts)).catch((err) =>
    console.error(`guard_events(${outlet}) write failed`, err)
  );
  if (waitUntil) {
    try {
      waitUntil(work);
    } catch {
      /* 单测/本地环境无 executionCtx：已 catch，不影响响应 */
    }
  }
}

/**
 * R312 P1：聚合层强收口打点——「AI 出口实际收了多少」。双判据都没命中的载体在折叠面不可见，
 * 但它一旦被 AI 复述就会被聚合层按公共串收掉——这里计的是真实收口片段数，不是危险判定次数。
 *  `outlet_<x>_verbatim_closed_spans`    本次出口被强收口的片段数（零值也写行）；
 *  `outlet_<x>_verbatim_closed_requests` 本次出口存在任何强收口。
 */
export function outletVerbatimClosedRows(outlet: GuardOutlet, spans: number): Array<[string, number]> {
  const n = Math.max(0, spans);
  return [
    [`outlet_${outlet}_verbatim_closed_spans`, n],
    [`outlet_${outlet}_verbatim_closed_requests`, n > 0 ? 1 : 0],
  ];
}

export function recordOutletVerbatimClosed(
  env: Pick<Env, "DB">,
  outlet: GuardOutlet,
  spans: number,
  waitUntil?: (p: Promise<unknown>) => void
): void {
  const work = bumpGuardEvents(env, outletVerbatimClosedRows(outlet, spans)).catch((err) =>
    console.error(`guard_events(${outlet}) verbatim write failed`, err)
  );
  if (waitUntil) {
    try {
      waitUntil(work);
    } catch {
      /* 单测/本地环境无 executionCtx */
    }
  }
}

/** 旧口径兼容（只知道严判据条数的调用点）：宽判据按严判据下界记。 */
export function recordOutletExecMarks(
  env: Pick<Env, "DB">,
  outlet: GuardOutlet,
  markedNotes: number,
  waitUntil?: (p: Promise<unknown>) => void
): void {
  recordOutletFoldMarks(env, outlet, { strict: markedNotes, broad: markedNotes }, waitUntil);
}
