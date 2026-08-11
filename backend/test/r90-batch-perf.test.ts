import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

function note(id: string, over: Row = {}): Row {
  return {
    id,
    user_id: "u1",
    source: "api",
    raw_type: "text",
    category: "idea",
    tags: '["旧标签"]',
    title: null,
    url: null,
    meta: null,
    is_sensitive: 0,
    content: `note ${id}`,
    content_enc: null,
    created_at: "2026-08-07 00:00:00",
    updated_at: "2026-08-07 00:00:00",
    deleted_at: null,
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake D1 where every roundtrip (first/all/run and each batch() CALL, not each
 * statement) costs `latencyMs`, mimicking prod D1 where per-roundtrip latency
 * dominates. Counts roundtrips so the tests lock in the roundtrip budget.
 */
function latencyDb(notes: Row[], latencyMs: number) {
  const stats = { roundtrips: 0, batchCalls: 0 };
  const applyRun = (sql: string, binds: unknown[]): { meta: { changes: number } } => {
    if (sql.startsWith("UPDATE users")) return { meta: { changes: 1 } };
    if (!sql.startsWith("UPDATE notes SET")) return { meta: { changes: 0 } };
    const whereIdx = sql.indexOf(" WHERE ");
    const cols = [...sql.slice(0, whereIdx).matchAll(/(\w+) = \?/g)].map((m) => m[1]);
    const wherePart = sql.slice(whereIdx);
    const whereBinds = binds.slice(cols.length);
    let targets: Row[];
    if (wherePart.includes("id IN (")) {
      const ids = whereBinds.slice(1) as string[];
      targets = notes.filter((n) => n.user_id === whereBinds[0] && ids.includes(n.id as string));
    } else {
      // UPDATE ... WHERE id = ? AND user_id = ?
      targets = notes.filter((n) => n.id === whereBinds[0] && n.user_id === whereBinds[1]);
    }
    if (wherePart.includes("deleted_at IS NULL")) targets = targets.filter((n) => !n.deleted_at);
    for (const t of targets) {
      cols.forEach((col, i) => (t[col] = binds[i]));
      if (sql.includes("deleted_at = datetime('now')")) t.deleted_at = "2026-08-07 00:00:01";
    }
    return { meta: { changes: targets.length } };
  };
  return {
    stats,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          stats.roundtrips++;
          await sleep(latencyMs);
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          return null;
        },
        async all() {
          stats.roundtrips++;
          await sleep(latencyMs);
          if (sql.includes("FROM notes") && sql.includes("id IN (")) {
            const ids = binds.slice(1) as string[];
            return {
              results: notes
                .filter((n) => n.user_id === binds[0] && !n.deleted_at && ids.includes(n.id as string))
                .map((n) => ({ ...n })),
            };
          }
          return { results: [] };
        },
        async run() {
          stats.roundtrips++;
          await sleep(latencyMs);
          return applyRun(sql, binds);
        },
        // let batch() apply this statement without paying per-statement latency
        apply() {
          return applyRun(sql, binds);
        },
      };
      return stmt;
    },
    async batch(stmts: { apply(): { meta: { changes: number } } }[]) {
      stats.roundtrips++;
      stats.batchCalls++;
      await sleep(latencyMs);
      return stmts.map((s) => s.apply());
    },
  };
}

function makeEnv(db: unknown): Env {
  return { DB: db, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" } as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(body: Record<string, unknown>) {
  return new Request("http://x/api/notes/batch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer good-token" },
    body: JSON.stringify(body),
  });
}

const LATENCY_MS = 40; // pessimistic per-roundtrip D1 latency

describe("POST /api/notes/batch roundtrip budget (R89: intermittent 40-60s)", () => {
  it("100-id add_tags finishes well under 5s with slow roundtrips", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const db = latencyDb(ids.map((id) => note(id)), LATENCY_MS);
    const started = Date.now();
    const res = await app.request(req({ action: "add_tags", ids, tags: ["新标签"] }), undefined, makeEnv(db), ctx);
    const elapsed = Date.now() - started;
    const body = (await res.json()) as { affected: number; ids: string[] };
    expect(res.status).toBe(200);
    expect(body.affected).toBe(100);
    expect(body.ids).toHaveLength(100);
    expect(elapsed).toBeLessThan(5000);
  });

  it("1000-id add_tags uses parallel selects + few batch calls (≤ 25 roundtrips)", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `n${i}`);
    const db = latencyDb(ids.map((id) => note(id)), 1);
    const res = await app.request(req({ action: "add_tags", ids, tags: ["新标签"] }), undefined, makeEnv(db), ctx);
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(1000);
    // auth first() + 13 selects (parallel) + ceil(1000/100)=10 batch calls
    expect(db.stats.roundtrips).toBeLessThanOrEqual(25);
    expect(db.stats.batchCalls).toBeLessThanOrEqual(10);
  });

  it("1000-id delete is a single batch roundtrip", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `n${i}`);
    const db = latencyDb(ids.map((id) => note(id)), 1);
    const res = await app.request(req({ action: "delete", ids }), undefined, makeEnv(db), ctx);
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(1000);
    expect(db.stats.batchCalls).toBe(1);
  });

  it("remove_tags returns the actually-changed ids for undo", async () => {
    const notes = [note("a", { tags: '["x"]' }), note("b", { tags: '["y"]' })];
    const db = latencyDb(notes, 1);
    const res = await app.request(
      req({ action: "remove_tags", ids: ["a", "b"], tags: ["x"] }),
      undefined,
      makeEnv(db),
      ctx
    );
    const body = (await res.json()) as { affected: number; ids: string[] };
    expect(body.affected).toBe(1);
    expect(body.ids).toEqual(["a"]);
  });
});
