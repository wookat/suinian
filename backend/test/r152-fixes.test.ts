import { describe, it, expect } from "vitest";
import { sha256Hex, migratedTokenSentinel, isLegacyPlaintextToken, generateToken, authenticateToken, issueToken } from "../src/auth";
import { financeClarifyTerms, financeTopicTerms, buildFinanceAggAnswer } from "../src/ask";
import { semanticMinScoreFor, SEMANTIC_MIN_SCORE, SEMANTIC_SMALL_CORPUS_MAX, SEMANTIC_SMALL_CORPUS_MIN_SCORE } from "../src/semantic";
import { financeStats } from "../src/reports";
import type { NoteRow } from "../src/types";

// ---- P1-1: hashed API token storage ----

interface UserRow {
  id: string;
  api_token: string;
}

/** Minimal fake D1 covering users + api_tokens for authenticateToken. */
function fakeDb(users: UserRow[]) {
  const tokens: { user_id: string; token_hash: string }[] = [];
  const db = {
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
          if (sql.includes("FROM api_tokens WHERE token_hash = ?")) {
            const t = tokens.find((t) => t.token_hash === binds[0]);
            return t ? { user_id: t.user_id } : null;
          }
          if (sql.includes("FROM users WHERE api_token = ?")) {
            const u = users.find((u) => u.api_token === binds[0]);
            return u ? { id: u.id } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes("INTO api_tokens")) {
            if (!tokens.some((t) => t.token_hash === binds[2])) {
              tokens.push({ user_id: binds[1] as string, token_hash: binds[2] as string });
            }
          } else if (sql.startsWith("UPDATE users SET api_token")) {
            const u = users.find((u) => u.id === binds[1]);
            if (u) u.api_token = binds[0] as string;
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

describe("R152 P1-1 hashed token storage", () => {
  it("issueToken stores only the SHA-256 hash and returns the raw token", async () => {
    const db = fakeDb([]);
    const raw = await issueToken(db, "u1");
    expect(raw).toMatch(/^[0-9a-f]{48}$/);
    expect(db.tokens).toEqual([{ user_id: "u1", token_hash: await sha256Hex(raw) }]);
    expect(db.tokens[0].token_hash).not.toBe(raw);
  });

  it("authenticates a hashed token", async () => {
    const db = fakeDb([]);
    const raw = await issueToken(db, "u1");
    expect(await authenticateToken(db, raw)).toEqual({ userId: "u1" });
  });

  it("rejects unknown tokens", async () => {
    const db = fakeDb([{ id: "u1", api_token: migratedTokenSentinel("u1") }]);
    expect(await authenticateToken(db, generateToken())).toBeNull();
  });

  it("transparently migrates a legacy plaintext token without invalidating it", async () => {
    const legacyToken = generateToken();
    const users = [{ id: "u_legacy", api_token: legacyToken }];
    const db = fakeDb(users);
    // first use: legacy lookup succeeds and the row migrates
    expect(await authenticateToken(db, legacyToken)).toEqual({ userId: "u_legacy" });
    expect(users[0].api_token).toBe("hashed:u_legacy");
    expect(db.tokens).toEqual([{ user_id: "u_legacy", token_hash: await sha256Hex(legacyToken) }]);
    // second use: same raw token still authenticates via the hash
    expect(await authenticateToken(db, legacyToken)).toEqual({ userId: "u_legacy" });
  });

  it("the sentinel can never collide with a real token", () => {
    expect(isLegacyPlaintextToken(generateToken())).toBe(true);
    expect(isLegacyPlaintextToken(migratedTokenSentinel("u1"))).toBe(false);
    // tokens are pure lowercase hex; the sentinel contains ":"
    expect(migratedTokenSentinel("u1")).not.toMatch(/^[0-9a-f]{48}$/);
  });
});

// ---- P2-2: finance clarify keyword extraction ----

const FN = (over: Partial<NoteRow>): NoteRow =>
  ({
    id: "n1",
    user_id: "u1",
    content: "花了 100 元",
    title: null,
    category: "expense",
    tags: null,
    source: "api",
    created_at: "2026-08-01 00:00:00",
    updated_at: "2026-08-01 00:00:00",
    deleted_at: null,
    is_sensitive: 0,
    amount: 100,
    currency: "CNY",
    ...over,
  }) as NoteRow;

describe("R152 P2-2 clarify extraction", () => {
  const agg = buildFinanceAggAnswer(financeStats([FN({})]), "这个月");

  it("extracts the clean term from 包括打车费吗 variants", () => {
    expect(financeClarifyTerms("包括打车费吗", agg)).toEqual(["打车费"]);
    expect(financeClarifyTerms("包括打车费在内吗", agg)).toEqual(["打车费"]);
    expect(financeClarifyTerms("你算上打车费了吗", agg)).toEqual(["打车费"]);
    expect(financeClarifyTerms("算进去打车费了没", agg)).toEqual(["打车费"]);
  });

  it("clarify-style questions never fall through to subset-topic extraction", () => {
    expect(financeTopicTerms("包括打车费吗")).toBeNull();
    expect(financeTopicTerms("这个数算上打车费在内一共多少钱")).toBeNull();
  });
});

// ---- P2-3: small-corpus semantic threshold ----

describe("R152 P2-3 corpus-aware semantic threshold", () => {
  it("raises the floor for tiny corpora and keeps it for larger ones", () => {
    expect(semanticMinScoreFor(3)).toBe(SEMANTIC_SMALL_CORPUS_MIN_SCORE);
    expect(semanticMinScoreFor(SEMANTIC_SMALL_CORPUS_MAX - 1)).toBe(SEMANTIC_SMALL_CORPUS_MIN_SCORE);
    expect(semanticMinScoreFor(SEMANTIC_SMALL_CORPUS_MAX)).toBe(SEMANTIC_MIN_SCORE);
    expect(semanticMinScoreFor(1000)).toBe(SEMANTIC_MIN_SCORE);
  });

  it("never lowers an explicitly stricter minScore", () => {
    expect(semanticMinScoreFor(3, 0.8)).toBe(0.8);
    expect(semanticMinScoreFor(1000, 0.8)).toBe(0.8);
  });
});
