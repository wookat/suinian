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

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
