// R318 D：小范围 beta 注册策略（邀请码 + 名额）。两者都未配置时行为必须与 R317 完全一致。
import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { hashPassword, inviteCodeAccepted, inviteCodeRequired, inviteCodes, registrationQuota } from "../src/auth";

interface UserRow {
  id: string;
  name: string;
  api_token: string;
  password_hash: string | null;
  created_at: string;
}

function fakeDb(users: UserRow[], opts: { countFails?: boolean } = {}) {
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
          if (sql.startsWith("SELECT COUNT(*) AS n FROM users")) {
            if (opts.countFails) throw new Error("D1 down");
            return { n: users.length };
          }
          if (sql.includes("FROM users WHERE name = ?")) return users.find((u) => u.name === binds[0]) ?? null;
          if (sql.includes("FROM users WHERE id = ?")) return users.find((u) => u.id === binds[0]) ?? null;
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
              created_at: "2026-01-01 00:00:00",
            });
          } else if (sql.includes("INSERT") && sql.includes("INTO api_tokens")) {
            tokens.push({ user_id: binds[1] as string, token_hash: binds[2] as string });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

function env(users: UserRow[], vars: Record<string, string> = {}, opts: { countFails?: boolean } = {}) {
  return { DB: fakeDb(users, opts), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com", ...vars };
}

let ipSeq = 0;
function post(path: string, body: unknown) {
  ipSeq += 1;
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}` },
    body: JSON.stringify(body),
  });
}

const PW = "beta-test-passw0rd";

describe("R318 beta registration — helpers", () => {
  it("inviteCodes: unset/blank ⇒ none; comma list trimmed", () => {
    expect(inviteCodes(undefined)).toEqual([]);
    expect(inviteCodes("")).toEqual([]);
    expect(inviteCodes(" , ")).toEqual([]);
    expect(inviteCodes("alpha, Beta ,gamma")).toEqual(["alpha", "Beta", "gamma"]);
    expect(inviteCodeRequired(undefined)).toBe(false);
    expect(inviteCodeRequired("alpha")).toBe(true);
  });

  it("inviteCodeAccepted: no codes configured ⇒ always true; case/whitespace-insensitive match", async () => {
    expect(await inviteCodeAccepted(undefined, undefined)).toBe(true);
    expect(await inviteCodeAccepted("alpha,beta", "ALPHA ")).toBe(true);
    expect(await inviteCodeAccepted("alpha,beta", "beta")).toBe(true);
    expect(await inviteCodeAccepted("alpha,beta", "gamma")).toBe(false);
    expect(await inviteCodeAccepted("alpha", undefined)).toBe(false);
    expect(await inviteCodeAccepted("alpha", 42)).toBe(false);
    expect(await inviteCodeAccepted("alpha", "")).toBe(false);
  });

  it("registrationQuota: unset/invalid/non-positive ⇒ null", () => {
    expect(registrationQuota(undefined)).toBeNull();
    expect(registrationQuota("")).toBeNull();
    expect(registrationQuota("abc")).toBeNull();
    expect(registrationQuota("0")).toBeNull();
    expect(registrationQuota("-3")).toBeNull();
    expect(registrationQuota(" 50 ")).toBe(50);
  });
});

describe("R318 beta registration — /api/auth/register-policy", () => {
  it("default (nothing configured) ⇒ open", async () => {
    const res = await app.fetch(new Request("http://local/api/auth/register-policy"), env([]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, invite_required: false, quota_full: false });
  });

  it("invite codes configured ⇒ invite_required, never leaks codes", async () => {
    const res = await app.fetch(new Request("http://local/api/auth/register-policy"), env([], { REGISTRATION_INVITE_CODES: "s3cret-code" }));
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).toEqual({ enabled: true, invite_required: true, quota_full: false });
    expect(JSON.stringify(j)).not.toContain("s3cret");
  });

  it("quota reached ⇒ quota_full without exposing the count", async () => {
    const users: UserRow[] = [
      { id: "u_1", name: "a1", api_token: "t1", password_hash: null, created_at: "" },
      { id: "u_2", name: "a2", api_token: "t2", password_hash: null, created_at: "" },
    ];
    const res = await app.fetch(new Request("http://local/api/auth/register-policy"), env(users, { REGISTRATION_QUOTA: "2" }));
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.quota_full).toBe(true);
    expect(Object.keys(j).sort()).toEqual(["enabled", "invite_required", "quota_full"]);
  });

  it("registration disabled ⇒ enabled=false and the other gates report false", async () => {
    const res = await app.fetch(
      new Request("http://local/api/auth/register-policy"),
      env([], { REGISTRATION_ENABLED: "false", REGISTRATION_INVITE_CODES: "x", REGISTRATION_QUOTA: "1" })
    );
    expect(await res.json()).toEqual({ enabled: false, invite_required: false, quota_full: false });
  });
});

describe("R318 beta registration — /api/auth/register gates", () => {
  it("no invite/quota configured ⇒ R317 behaviour unchanged (invite_code ignored)", async () => {
    const e = env([]);
    const res = await app.fetch(post("/api/auth/register", { name: "open_user", password: PW, invite_code: "whatever" }), e);
    expect(res.status).toBe(201);
    expect(e.DB.users).toHaveLength(1);
  });

  it("invite required: missing ⇒ 403 INVITE_REQUIRED (beta wording), wrong ⇒ 403 (wrong wording), right ⇒ 201", async () => {
    const e = env([], { REGISTRATION_INVITE_CODES: "alpha-1,beta-2" });
    const r1 = await app.fetch(post("/api/auth/register", { name: "inv_a", password: PW }), e);
    expect(r1.status).toBe(403);
    const j1 = (await r1.json()) as { error: string; code: string };
    expect(j1.code).toBe("INVITE_REQUIRED");
    expect(j1.error).toContain("邀请码");
    expect(j1.error).toContain("beta");

    const r2 = await app.fetch(post("/api/auth/register", { name: "inv_a", password: PW, invite_code: "nope" }), e);
    expect(r2.status).toBe(403);
    const j2 = (await r2.json()) as { error: string; code: string };
    expect(j2.code).toBe("INVITE_REQUIRED");
    expect(j2.error).toBe("邀请码不正确");
    expect(e.DB.users).toHaveLength(0);

    const r3 = await app.fetch(post("/api/auth/register", { name: "inv_a", password: PW, invite_code: " BETA-2 " }), e);
    expect(r3.status).toBe(201);
    expect(e.DB.users).toHaveLength(1);
  });

  it("invite gate runs after name/password validation and before name-exists probing", async () => {
    const e = env([{ id: "u_x", name: "taken", api_token: "t", password_hash: await hashPassword(PW), created_at: "" }], {
      REGISTRATION_INVITE_CODES: "alpha",
    });
    // invalid password ⇒ 400 first (no invite leak either way)
    const r0 = await app.fetch(post("/api/auth/register", { name: "taken", password: "short" }), e);
    expect(r0.status).toBe(400);
    // valid shape but no invite ⇒ 403, NOT 409 (does not confirm the name exists)
    const r1 = await app.fetch(post("/api/auth/register", { name: "taken", password: PW }), e);
    expect(r1.status).toBe(403);
  });

  it("quota: full ⇒ 403 QUOTA_FULL and no insert; idempotent retry of an existing account still passes", async () => {
    const users: UserRow[] = [{ id: "u_1", name: "first", api_token: "t1", password_hash: await hashPassword(PW), created_at: "" }];
    const e = env(users, { REGISTRATION_QUOTA: "1" });
    const r1 = await app.fetch(post("/api/auth/register", { name: "second", password: PW }), e);
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { code: string }).code).toBe("QUOTA_FULL");
    expect(e.DB.users).toHaveLength(1);

    const r2 = await app.fetch(post("/api/auth/register", { name: "first", password: PW }), e);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { existing?: boolean }).existing).toBe(true);
  });

  it("quota: below limit ⇒ 201, and the next one hits the wall", async () => {
    const e = env([], { REGISTRATION_QUOTA: "2" });
    expect((await app.fetch(post("/api/auth/register", { name: "q_one", password: PW }), e)).status).toBe(201);
    expect((await app.fetch(post("/api/auth/register", { name: "q_two", password: PW }), e)).status).toBe(201);
    expect((await app.fetch(post("/api/auth/register", { name: "q_three", password: PW }), e)).status).toBe(403);
    expect(e.DB.users).toHaveLength(2);
  });

  it("quota count failure fails closed (403), never fails open", async () => {
    const e = env([], { REGISTRATION_QUOTA: "10" }, { countFails: true });
    const r = await app.fetch(post("/api/auth/register", { name: "q_fail", password: PW }), e);
    expect(r.status).toBe(403);
    expect(e.DB.users).toHaveLength(0);
  });

  it("invite + quota together: invite is checked first", async () => {
    const e = env([{ id: "u_1", name: "first", api_token: "t1", password_hash: null, created_at: "" }], {
      REGISTRATION_INVITE_CODES: "alpha",
      REGISTRATION_QUOTA: "1",
    });
    const r1 = await app.fetch(post("/api/auth/register", { name: "x_user", password: PW }), e);
    expect(((await r1.json()) as { code: string }).code).toBe("INVITE_REQUIRED");
    const r2 = await app.fetch(post("/api/auth/register", { name: "x_user", password: PW, invite_code: "alpha" }), e);
    expect(((await r2.json()) as { code: string }).code).toBe("QUOTA_FULL");
  });
});
