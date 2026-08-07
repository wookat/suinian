import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  validateName,
  validatePassword,
  registrationEnabled,
  checkRateLimit,
  RATE_LIMIT_MAX,
} from "../src/auth";

interface UserRow {
  id: string;
  name: string;
  api_token: string;
  password_hash: string | null;
  created_at: string;
}

/** Stateful fake D1 covering users + auth_rate_limits + note tables for cascade delete. */
function fakeDb(users: UserRow[]) {
  const rateLimits = new Map<string, { window_start: string; count: number }>();
  const deleted: string[] = [];
  const db = {
    users,
    deleted,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.startsWith("SELECT window_start, count FROM auth_rate_limits")) {
            return rateLimits.get(binds[0] as string) ?? null;
          }
          if (sql.includes("FROM users WHERE name = ?")) {
            return users.find((u) => u.name === binds[0]) ?? null;
          }
          if (sql.includes("FROM users WHERE api_token = ?")) {
            const u = users.find((u) => u.api_token === binds[0]);
            return u ? { id: u.id } : null;
          }
          if (sql.includes("FROM users WHERE id = ?")) {
            return users.find((u) => u.id === binds[0]) ?? null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO auth_rate_limits")) {
            rateLimits.set(binds[0] as string, { window_start: binds[1] as string, count: 1 });
          } else if (sql.startsWith("UPDATE auth_rate_limits")) {
            const row = rateLimits.get(binds[0] as string);
            if (row) row.count += 1;
          } else if (sql.startsWith("INSERT INTO users")) {
            users.push({
              id: binds[0] as string,
              name: binds[1] as string,
              api_token: binds[2] as string,
              password_hash: binds[3] as string | null,
              created_at: "2026-01-01 00:00:00",
            });
          } else if (sql.startsWith("UPDATE users SET api_token")) {
            const u = users.find((u) => u.id === binds[1]);
            if (u) u.api_token = binds[0] as string;
          } else if (sql.startsWith("DELETE FROM users")) {
            const i = users.findIndex((u) => u.id === binds[0]);
            if (i >= 0) users.splice(i, 1);
            deleted.push(`users:${binds[0]}`);
          } else if (sql.startsWith("DELETE FROM")) {
            deleted.push(sql.slice("DELETE FROM ".length).split(" ")[0]);
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

function makeEnv(users: UserRow[], overrides: Record<string, string> = {}) {
  const DB = fakeDb(users);
  return {
    env: { DB, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com", ...overrides },
    DB,
  };
}

function post(path: string, body: unknown, ip = "1.2.3.4", token?: string) {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("password hashing", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("dummy-test-value");
    expect(h.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("dummy-test-value", h)).toBe(true);
    expect(await verifyPassword("wrong-pass", h)).toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });

  it("generates 48-char hex tokens", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(generateToken()).not.toBe(t);
  });
});

describe("validation", () => {
  it("validates names", () => {
    expect(validateName("小明")).toBe("小明");
    expect(validateName(" alice ")).toBe("alice");
    expect(validateName("a")).toBeNull();
    expect(validateName("bad name")).toBeNull();
    expect(validateName(123)).toBeNull();
  });

  it("validates passwords", () => {
    expect(validatePassword("12345678")).toBe("12345678");
    expect(validatePassword("short")).toBeNull();
    expect(validatePassword(null)).toBeNull();
  });

  it("registrationEnabled defaults on", () => {
    expect(registrationEnabled(undefined)).toBe(true);
    expect(registrationEnabled("true")).toBe(true);
    expect(registrationEnabled("false")).toBe(false);
    expect(registrationEnabled("0")).toBe(false);
    expect(registrationEnabled("off")).toBe(false);
  });
});

describe("POST /api/auth/register", () => {
  let users: UserRow[];
  beforeEach(() => {
    users = [];
  });

  it("registers and returns a token", async () => {
    const { env } = makeEnv(users);
    const res = await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string; name: string }; api_token: string };
    expect(body.user.name).toBe("alice");
    expect(body.api_token).toMatch(/^[0-9a-f]{48}$/);
    expect(users[0].password_hash).toMatch(/^pbkdf2\$/);
  });

  it("rejects duplicate names", async () => {
    const { env } = makeEnv(users);
    await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    const res = await app.request(post("/api/auth/register", { name: "alice", password: "password456" }), undefined, env);
    expect(res.status).toBe(409);
  });

  it("rejects invalid name / password", async () => {
    const { env } = makeEnv(users);
    expect((await app.request(post("/api/auth/register", { name: "a", password: "password123" }), undefined, env)).status).toBe(400);
    expect((await app.request(post("/api/auth/register", { name: "alice", password: "short" }), undefined, env)).status).toBe(400);
  });

  it("respects REGISTRATION_ENABLED=false", async () => {
    const { env } = makeEnv(users, { REGISTRATION_ENABLED: "false" });
    const res = await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    expect(res.status).toBe(403);
  });

  it("rate limits per IP (5/min)", async () => {
    const { env } = makeEnv(users);
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await app.request(post("/api/auth/register", { name: `user${i}`, password: "password123" }), undefined, env);
      expect(res.status).toBe(201);
    }
    const res = await app.request(post("/api/auth/register", { name: "user9", password: "password123" }), undefined, env);
    expect(res.status).toBe(429);
    // a different IP still works
    const res2 = await app.request(post("/api/auth/register", { name: "user9", password: "password123" }, "9.9.9.9"), undefined, env);
    expect(res2.status).toBe(201);
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct password", async () => {
    const users: UserRow[] = [];
    const { env } = makeEnv(users);
    await app.request(post("/api/auth/register", { name: "bob", password: "password123" }), undefined, env);
    const res = await app.request(post("/api/auth/login", { name: "bob", password: "password123" }, "5.5.5.5"), undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { api_token: string };
    expect(body.api_token).toBe(users[0].api_token);
  });

  it("rejects wrong password and unknown users", async () => {
    const users: UserRow[] = [];
    const { env } = makeEnv(users);
    await app.request(post("/api/auth/register", { name: "bob", password: "password123" }), undefined, env);
    expect((await app.request(post("/api/auth/login", { name: "bob", password: "wrongwrong" }, "5.5.5.5"), undefined, env)).status).toBe(401);
    expect((await app.request(post("/api/auth/login", { name: "nobody", password: "password123" }, "5.5.5.5"), undefined, env)).status).toBe(401);
  });

  it("rejects password login for legacy token-only users", async () => {
    const users: UserRow[] = [
      { id: "u_legacy", name: "legacy", api_token: "tok", password_hash: null, created_at: "2025-01-01" },
    ];
    const { env } = makeEnv(users);
    const res = await app.request(post("/api/auth/login", { name: "legacy", password: "password123" }, "5.5.5.5"), undefined, env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("未设置密码");
  });
});

describe("token rotate + me + delete", () => {
  it("rotates the token (old token becomes invalid)", async () => {
    const users: UserRow[] = [
      { id: "u1", name: "carol", api_token: "old-token", password_hash: null, created_at: "2025-01-01" },
    ];
    const { env } = makeEnv(users);
    const res = await app.request(post("/api/auth/rotate-token", {}, "6.6.6.6", "old-token"), undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { api_token: string };
    expect(body.api_token).toMatch(/^[0-9a-f]{48}$/);
    expect(users[0].api_token).toBe(body.api_token);
    // old token now rejected
    const res2 = await app.request(post("/api/auth/rotate-token", {}, "6.6.6.6", "old-token"), undefined, env);
    expect(res2.status).toBe(401);
  });

  it("requires auth for rotate", async () => {
    const { env } = makeEnv([]);
    const res = await app.request(post("/api/auth/rotate-token", {}), undefined, env);
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/me returns profile", async () => {
    const users: UserRow[] = [
      { id: "u1", name: "carol", api_token: "tok", password_hash: "pbkdf2$1$a$b", created_at: "2025-01-01" },
    ];
    const { env } = makeEnv(users);
    const res = await app.request(
      new Request("http://local/api/auth/me", { headers: { authorization: "Bearer tok" } }),
      undefined,
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { name: string; has_password: boolean } };
    expect(body.user.name).toBe("carol");
    expect(body.user.has_password).toBe(true);
  });

  it("DELETE /api/auth/me removes user and cascades", async () => {
    const users: UserRow[] = [
      { id: "u1", name: "carol", api_token: "tok", password_hash: null, created_at: "2025-01-01" },
    ];
    const { env, DB } = makeEnv(users);
    const res = await app.request(
      new Request("http://local/api/auth/me", {
        method: "DELETE",
        headers: { authorization: "Bearer tok" },
      }),
      undefined,
      env
    );
    expect(res.status).toBe(200);
    expect(users.length).toBe(0);
    expect(DB.deleted).toContain("notes");
    expect(DB.deleted).toContain("threads");
    expect(DB.deleted).toContain("weekly_reports");
  });
});

describe("checkRateLimit", () => {
  it("fails open on DB errors", async () => {
    const broken = {
      prepare() {
        throw new Error("boom");
      },
    } as unknown as D1Database;
    expect(await checkRateLimit(broken, "login", "1.1.1.1")).toBe(true);
  });
});
