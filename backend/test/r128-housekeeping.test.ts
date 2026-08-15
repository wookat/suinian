import { describe, it, expect } from "vitest";
import { sweepAuthRateLimits, RATE_LIMIT_RETENTION_HOURS } from "../src/auth";
import { reconcileMediaOrphans, RECONCILE_GRACE_MS } from "../src/media";
import type { Env } from "../src/types";

describe("sweepAuthRateLimits", () => {
  it("deletes rows older than the retention cutoff", async () => {
    let capturedSql = "";
    let capturedBind = "";
    const db = {
      prepare(sql: string) {
        capturedSql = sql;
        return {
          bind(cutoff: string) {
            capturedBind = cutoff;
            return { async run() { return { meta: { changes: 3 } }; } };
          },
        };
      },
    } as unknown as D1Database;
    const deleted = await sweepAuthRateLimits(db);
    expect(deleted).toBe(3);
    expect(capturedSql).toContain("DELETE FROM auth_rate_limits");
    // cutoff is minute-granularity ISO, matching checkRateLimit's window key format
    expect(capturedBind).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const expected = Date.now() - RATE_LIMIT_RETENTION_HOURS * 3600_000;
    expect(Math.abs(new Date(`${capturedBind}:00Z`).getTime() - expected)).toBeLessThan(120_000);
  });

  it("swallows D1 errors (best-effort housekeeping)", async () => {
    const db = {
      prepare() {
        return { bind() { return { async run() { throw new Error("boom"); } }; } };
      },
    } as unknown as D1Database;
    await expect(sweepAuthRateLimits(db)).resolves.toBe(0);
  });
});

interface FakeObj {
  key: string;
  uploaded: Date;
}

function fakeEnv(objects: FakeObj[], knownKeys: string[], deleted: string[]): Env {
  return {
    MEDIA: {
      async list() {
        return { objects, truncated: false };
      },
      async delete(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) deleted.push(k);
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...keys: string[]) {
            return {
              async all() {
                if (!sql.includes("FROM attachments")) return { results: [] };
                return { results: keys.filter((k) => knownKeys.includes(k)).map((k) => ({ r2_key: k })) };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

describe("reconcileMediaOrphans", () => {
  const old = new Date(Date.now() - RECONCILE_GRACE_MS - 3600_000);
  const fresh = new Date();

  it("deletes aged objects with no attachments row, keeps owned and fresh ones", async () => {
    const deleted: string[] = [];
    const env = fakeEnv(
      [
        { key: "media/u1/n1/1-a.png", uploaded: old }, // owned
        { key: "media/uGone/nGone/2-b.png", uploaded: old }, // orphan, aged
        { key: "media/u1/n2/3-c.png", uploaded: fresh }, // orphan-looking but inside grace
      ],
      ["media/u1/n1/1-a.png"],
      deleted
    );
    const n = await reconcileMediaOrphans(env);
    expect(n).toBe(1);
    expect(deleted).toEqual(["media/uGone/nGone/2-b.png"]);
  });

  it("no-ops without an R2 binding", async () => {
    await expect(reconcileMediaOrphans({} as Env)).resolves.toBe(0);
  });

  it("swallows list failures", async () => {
    const env = {
      MEDIA: { async list() { throw new Error("r2 down"); } },
      DB: {},
    } as unknown as Env;
    await expect(reconcileMediaOrphans(env)).resolves.toBe(0);
  });
});
