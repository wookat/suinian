// Password hashing + auth helpers for self-serve registration (R13).
//
// Scheme: PBKDF2-HMAC-SHA256 via WebCrypto, 100,000 iterations, 16-byte random
// salt, 32-byte derived key. Stored as "pbkdf2$<iterations>$<salt b64>$<hash b64>".
// Rationale: Cloudflare Workers has no native argon2/bcrypt and caps WebCrypto
// PBKDF2 at 100,000 iterations; PBKDF2-SHA256@100k is the standard mature choice
// in this runtime (OWASP-listed) without pulling in WASM dependencies.

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, iterations },
    keyMaterial,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const expected = b64decode(hashB64);
    const actual = await derive(password, b64decode(saltB64), iterations);
    if (actual.length !== expected.length) return false;
    // constant-time compare
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// Recovery code: 16 chars from a 31-char alphabet (no 0/O/1/I/L ambiguity)
// ≈ 79 bits of entropy, displayed as XXXX-XXXX-XXXX-XXXX. Stored hashed with
// the same PBKDF2 scheme as passwords; consumed (cleared) on successful use.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_LEN = 16;

export function generateRecoveryCode(): string {
  // rejection sampling: only accept bytes below the largest multiple of the
  // alphabet size, so every character is uniformly distributed (no modulo bias)
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  const chars: string[] = [];
  while (chars.length < RECOVERY_CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_LEN))) {
      if (b < limit && chars.length < RECOVERY_CODE_LEN) chars.push(RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
    }
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;
}

/** Canonical form for hashing/verifying: uppercase, separators stripped. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.toUpperCase().replace(/[^A-Z2-9]/g, "");
  return s.length === RECOVERY_CODE_LEN ? s : null;
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- API token storage (R152 P1-1) ----
// Tokens are 24 random bytes (~192 bits of entropy), so a single unsalted
// SHA-256 is the right hash: brute-forcing the preimage space is infeasible,
// and a slow KDF (PBKDF2/argon2) would only add per-request latency on the
// hottest path (every authenticated call) without a security gain.

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Written into users.api_token once its plaintext token moves to api_tokens:
 * unique per user (column is NOT NULL UNIQUE) and can never equal a real
 * token (tokens are pure hex, ":" never appears). */
export function migratedTokenSentinel(userId: string): string {
  return `hashed:${userId}`;
}

/** Legacy plaintext token still sitting in users.api_token (pre-R152 row). */
export function isLegacyPlaintextToken(stored: string): boolean {
  return !stored.startsWith("hashed:");
}

function tokenRowId(): string {
  return `tk_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Statement inserting the hash of a raw token for a user (composable into batches). */
export async function insertTokenStmt(db: D1Database, userId: string, rawToken: string): Promise<D1PreparedStatement> {
  return db
    .prepare("INSERT INTO api_tokens (id, user_id, token_hash) VALUES (?, ?, ?)")
    .bind(tokenRowId(), userId, await sha256Hex(rawToken));
}

/** Mint a token for the user, storing only its hash. Returns the raw token (shown to the client once). */
export async function issueToken(db: D1Database, userId: string): Promise<string> {
  const token = generateToken();
  await (await insertTokenStmt(db, userId, token)).run();
  return token;
}

export type TokenAuth = { userId: string };

/**
 * Resolve a bearer token to its user via hash lookup. Legacy plaintext rows
 * in users.api_token (pre-R152) still authenticate and are transparently
 * migrated: the hash row is inserted and the plaintext replaced with the
 * sentinel, so no existing token ever breaks. Migration failure is
 * non-fatal (auth already succeeded; the next request retries it).
 */
export async function authenticateToken(db: D1Database, token: string): Promise<TokenAuth | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare("SELECT user_id FROM api_tokens WHERE token_hash = ?").bind(tokenHash).first<{ user_id: string }>();
  if (row) return { userId: row.user_id };
  const legacy = await db.prepare("SELECT id FROM users WHERE api_token = ?").bind(token).first<{ id: string }>();
  if (!legacy) return null;
  try {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO api_tokens (id, user_id, token_hash) VALUES (?, ?, ?)").bind(tokenRowId(), legacy.id, tokenHash),
      db.prepare("UPDATE users SET api_token = ? WHERE id = ?").bind(migratedTokenSentinel(legacy.id), legacy.id),
    ]);
  } catch (e) {
    console.error("token hash migration failed", e);
  }
  return { userId: legacy.id };
}

export function validateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (n.length < 2 || n.length > 32) return null;
  if (!/^[\w\u4e00-\u9fff.\-\[\]]+$/.test(n)) return null;
  return n;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return null;
  if (password.length < 8 || password.length > 128) return null;
  return password;
}

export function registrationEnabled(v: string | undefined): boolean {
  if (v === undefined) return true;
  return !["false", "0", "off", "no"].includes(v.trim().toLowerCase());
}

export const RATE_LIMIT_MAX = 5;

/**
 * Fixed-window rate limit backed by D1 (`max`/min per action+dimension), checked
 * across every given dimension (e.g. IP and account) — all must be under the
 * limit. Trade-off: a D1 table is the simplest durable option on Workers
 * (in-memory state is per-isolate and evicted freely); a fixed minute window
 * can allow up to 2x burst across a boundary, acceptable for auth abuse
 * throttling. Fails closed on D1 errors: if the limiter store is down we
 * conservatively reject instead of letting unlimited attempts through.
 */
export async function checkRateLimit(db: D1Database, action: string, dims: string[], max = RATE_LIMIT_MAX): Promise<boolean> {
  const windowStart = new Date().toISOString().slice(0, 16); // minute granularity
  try {
    let allowed = true;
    for (const dim of dims) {
      const key = `${action}:${dim}`;
      // single atomic UPSERT: window rollover + increment + read back in one
      // statement, so concurrent requests can never over-admit via a stale
      // SELECT snapshot (R107 P2-1)
      const row = await db
        .prepare(
          `INSERT INTO auth_rate_limits (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE WHEN auth_rate_limits.window_start = excluded.window_start THEN auth_rate_limits.count + 1 ELSE 1 END,
             window_start = excluded.window_start
           RETURNING count`
        )
        .bind(key, windowStart)
        .first<{ count: number }>();
      if ((row?.count ?? max + 1) > max) allowed = false;
    }
    return allowed;
  } catch (e) {
    console.error("rate limit check failed", e);
    return false;
  }
}

/** Retain expired limiter rows briefly for postmortems, then sweep. */
export const RATE_LIMIT_RETENTION_HOURS = 24;

/**
 * Delete rate-limit rows whose fixed window closed more than a day ago.
 * The window key is minute-granularity ISO ("YYYY-MM-DDTHH:MM"), so a plain
 * string comparison against the cutoff is correct. Errors are swallowed —
 * the sweep is best-effort housekeeping, never on a request path.
 */
export async function sweepAuthRateLimits(db: D1Database): Promise<number> {
  const cutoff = new Date(Date.now() - RATE_LIMIT_RETENTION_HOURS * 3600_000).toISOString().slice(0, 16);
  try {
    const res = await db.prepare("DELETE FROM auth_rate_limits WHERE window_start < ?").bind(cutoff).run();
    return res.meta.changes ?? 0;
  } catch (e) {
    console.error("rate limit sweep failed", e);
    return 0;
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
