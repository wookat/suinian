import { describe, it, expect } from "vitest";
import { runRebuildJobSlice, JOB_MAX_AGE_MINUTES } from "../src/thread-jobs";
import type { Env } from "../src/types";

// Minimal D1 stub keyed on SQL text: enough to drive the expiry branch of
// runRebuildJobSlice without a real database.
function stubDb(job: { status: string; expired: boolean }, updates: { sql: string; binds: unknown[] }[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("created_at < datetime")) return job.expired ? { x: 1 } : null;
              if (sql.startsWith("SELECT * FROM thread_jobs"))
                return { id: "j1", user_id: "u1", kind: "rebuild", status: job.status, phase: "cluster", total: 0, processed: 0, threads: null, state: null, error: null, created_at: "", updated_at: "" };
              return null;
            },
            async run() {
              updates.push({ sql, binds });
              return { success: true };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("rebuild job max lifetime", () => {
  it("marks an over-age running job as error instead of resuming it", async () => {
    const updates: { sql: string; binds: unknown[] }[] = [];
    const env = { DB: stubDb({ status: "running", expired: true }, updates) } as Env;
    await runRebuildJobSlice(env, "j1", 1_000);
    const errUpdate = updates.find((u) => u.sql.includes("status = 'error'"));
    expect(errUpdate).toBeDefined();
    expect(String(errUpdate!.binds[0])).toContain(`${JOB_MAX_AGE_MINUTES} 分钟`);
  });

  it("leaves already-terminal jobs untouched", async () => {
    const updates: { sql: string; binds: unknown[] }[] = [];
    const env = { DB: stubDb({ status: "done", expired: true }, updates) } as Env;
    await runRebuildJobSlice(env, "j1", 1_000);
    expect(updates).toEqual([]);
  });
});
