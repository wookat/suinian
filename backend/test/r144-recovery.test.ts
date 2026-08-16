import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/index";
import { generateRecoveryCode, normalizeRecoveryCode, verifyPassword } from "../src/auth";
import { isWhisperHallucination } from "../src/media";

interface UserRow {
  id: string;
  name: string;
  api_token: string;
  password_hash: string | null;
  recovery_hash: string | null;
  created_at: string;
}

/** Stateful fake D1 covering users (incl. recovery_hash) + auth_rate_limits. */
function fakeDb(users: UserRow[]) {
  const rateLimits = new Map<string, { window_start: string; count: number }>();
  const tokens: { user_id: string; token_hash: string }[] = [];
  const db = {
    users,
    tokens,
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.startsWith("INSERT INTO auth_rate_limits")) {
            const key = binds[0] as string;
            const windowStart = binds[1] as string;
            const row = rateLimits.get(key);
            const count = row && row.window_start === windowStart ? row.count + 1 : 1;
            rateLimits.set(key, { window_start: windowStart, count });
            return { count };
          }
          if (sql.includes("FROM users WHERE name = ?")) {
            return users.find((u) => u.name === binds[0]) ?? null;
          }
          if (sql.includes("FROM api_tokens WHERE token_hash = ?")) {
            const t = tokens.find((t) => t.token_hash === binds[0]);
            return t ? { user_id: t.user_id } : null;
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
          if (sql.startsWith("INSERT INTO users")) {
            users.push({
              id: binds[0] as string,
              name: binds[1] as string,
              api_token: binds[2] as string,
              password_hash: binds[3] as string | null,
              recovery_hash: null,
              created_at: "2026-01-01 00:00:00",
            });
          } else if (sql.includes("INSERT") && sql.includes("INTO api_tokens")) {
            if (!tokens.some((t) => t.token_hash === binds[2])) {
              tokens.push({ user_id: binds[1] as string, token_hash: binds[2] as string });
            }
          } else if (sql.startsWith("DELETE FROM api_tokens WHERE user_id")) {
            for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].user_id === binds[0]) tokens.splice(i, 1);
          } else if (sql.startsWith("UPDATE users SET api_token")) {
            const u = users.find((u) => u.id === binds[1]);
            if (u) u.api_token = binds[0] as string;
          } else if (sql.startsWith("UPDATE users SET recovery_hash")) {
            const u = users.find((u) => u.id === binds[1]);
            if (u) u.recovery_hash = binds[0] as string;
          } else if (sql.startsWith("UPDATE users SET password_hash = ?, api_token = ?, recovery_hash")) {
            const u = users.find((u) => u.id === binds[3]);
            if (u) {
              u.password_hash = binds[0] as string;
              u.api_token = binds[1] as string;
              u.recovery_hash = binds[2] as string;
            }
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

function makeEnv(users: UserRow[]) {
  const DB = fakeDb(users);
  return { env: { DB, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" }, DB };
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

describe("recovery code helpers", () => {
  it("generates XXXX-XXXX-XXXX-XXXX without ambiguous chars", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OIL]/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it("normalizes with/without separators and case", () => {
    expect(normalizeRecoveryCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeRecoveryCode("ABCD EFGH JKMN PQRS")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeRecoveryCode("too-short")).toBeNull();
    expect(normalizeRecoveryCode(123)).toBeNull();
  });
});

describe("register + recover flow", () => {
  let users: UserRow[];
  beforeEach(() => {
    users = [];
  });

  it("register returns a one-time recovery code whose hash is stored", async () => {
    const { env } = makeEnv(users);
    const res = await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { recovery_code: string };
    expect(body.recovery_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(users[0].recovery_hash).toMatch(/^pbkdf2\$/);
    expect(await verifyPassword(normalizeRecoveryCode(body.recovery_code)!, users[0].recovery_hash!)).toBe(true);
  });

  it("recovers the account, rotates the token and consumes the code", async () => {
    const { env } = makeEnv(users);
    const reg = await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    const { recovery_code, api_token } = (await reg.json()) as { recovery_code: string; api_token: string };

    const res = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code, new_password: "newpassword456" }, "2.2.2.2"),
      undefined,
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { api_token: string; recovery_code: string };
    expect(body.api_token).not.toBe(api_token);
    expect(body.recovery_code).not.toBe(recovery_code);
    expect(await verifyPassword("newpassword456", users[0].password_hash!)).toBe(true);

    // old code is consumed: replay fails
    const replay = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code, new_password: "another7890" }, "3.3.3.3"),
      undefined,
      env
    );
    expect(replay.status).toBe(401);

    // the freshly returned code works
    const again = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code: body.recovery_code, new_password: "third90123" }, "4.4.4.4"),
      undefined,
      env
    );
    expect(again.status).toBe(200);
  });

  it("uniform 401 for wrong code / unknown user / no code set", async () => {
    const { env } = makeEnv(users);
    await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    const wrong = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code: "AAAA-AAAA-AAAA-AAAA", new_password: "newpassword456" }, "2.2.2.2"),
      undefined,
      env
    );
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("用户名或恢复码错误");
    const unknown = await app.request(
      post("/api/auth/recover", { name: "nobody", recovery_code: "AAAA-AAAA-AAAA-AAAA", new_password: "newpassword456" }, "3.3.3.3"),
      undefined,
      env
    );
    expect(unknown.status).toBe(401);
    users[0].recovery_hash = null;
    const noCode = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code: "AAAA-AAAA-AAAA-AAAA", new_password: "newpassword456" }, "4.4.4.4"),
      undefined,
      env
    );
    expect(noCode.status).toBe(401);
  });

  it("validates the new password before touching auth state", async () => {
    const { env } = makeEnv(users);
    const res = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code: "AAAA-AAAA-AAAA-AAAA", new_password: "short" }, "2.2.2.2"),
      undefined,
      env
    );
    expect(res.status).toBe(400);
  });

  // R155 D-3：账号维度阈值放宽到 ACCT_RATE_LIMIT_MAX，单 IP 仍由 IP 维度 5/分拦住
  it("rate limits distributed recovery attempts per account across IPs", async () => {
    const { env } = makeEnv(users);
    await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    for (let i = 0; i < 20; i++) {
      const res = await app.request(
        post("/api/auth/recover", { name: "alice", recovery_code: "AAAA-AAAA-AAAA-AAAA", new_password: "newpassword456" }, `9.9.9.${i}`),
        undefined,
        env
      );
      expect(res.status).toBe(401);
    }
    const res = await app.request(
      post("/api/auth/recover", { name: "alice", recovery_code: "AAAA-AAAA-AAAA-AAAA", new_password: "newpassword456" }, "9.9.9.99"),
      undefined,
      env
    );
    expect(res.status).toBe(429);
  });

  it("POST /api/auth/recovery-code regenerates and invalidates the old code", async () => {
    const { env } = makeEnv(users);
    const reg = await app.request(post("/api/auth/register", { name: "alice", password: "password123" }), undefined, env);
    const { recovery_code: oldCode, api_token: token } = (await reg.json()) as { recovery_code: string; api_token: string };
    const res = await app.request(post("/api/auth/recovery-code", {}, "1.2.3.4", token), undefined, env);
    expect(res.status).toBe(200);
    const { recovery_code: newCode } = (await res.json()) as { recovery_code: string };
    expect(newCode).not.toBe(oldCode);
    expect(await verifyPassword(normalizeRecoveryCode(newCode)!, users[0].recovery_hash!)).toBe(true);
    expect(await verifyPassword(normalizeRecoveryCode(oldCode)!, users[0].recovery_hash!)).toBe(false);
  });

  it("requires auth for recovery-code regeneration", async () => {
    const { env } = makeEnv(users);
    const res = await app.request(post("/api/auth/recovery-code", {}), undefined, env);
    expect(res.status).toBe(401);
  });
});

describe("whisper hallucination filter (R143 P2-3)", () => {
  it("drops canned closing phrases", () => {
    expect(isWhisperHallucination("Thank you.")).toBe(true);
    expect(isWhisperHallucination("Thanks for watching!")).toBe(true);
    expect(isWhisperHallucination("谢谢观看")).toBe(true);
    expect(isWhisperHallucination("谢谢大家。")).toBe(true);
  });

  it("keeps real content, including short phrases that merely start alike", () => {
    expect(isWhisperHallucination("明天下午三点开会")).toBe(false);
    expect(isWhisperHallucination("谢谢小王今天帮我搬家，记得回礼")).toBe(false);
    expect(isWhisperHallucination("Thank you note to send to the venue owner about the deposit refund")).toBe(false);
  });
});
