/**
 * SW api 缓存的身份隔离（R166 P1）：已鉴权的 /api/notes|threads|reports GET
 * 响应缓存在 Cache Storage（suinian-api），Workbox 以 URL 为键——请求 URL 必须
 * 带上当前账号的指纹参数，换号后旧账号的缓存条目不可能被命中；换号/登出时再
 * 整体清掉不属于当前身份的条目，双保险。
 */

export const API_CACHE_NAME = "suinian-api"
/** Query param carrying the identity fingerprint on cacheable API GETs. */
export const IDENTITY_PARAM = "sn_uid"

/** Anonymous fingerprint (no token / hashing unavailable). */
const ANON = "anon"

let memo: { token: string; fp: string } | null = null

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Stable non-reversible fingerprint of the current api token (cache partition key). */
export async function identityFingerprint(token: string): Promise<string> {
  if (!token) return ANON
  if (memo?.token === token) return memo.fp
  let fp: string
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    fp = Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  } catch {
    // non-secure context (plain-http LAN dev): weaker but still partitions
    fp = fnv1a(token)
  }
  memo = { token, fp }
  return fp
}

/** Whether a request path belongs to the SW-cached API routes. */
export function isCacheableApiPath(path: string): boolean {
  return /^\/api\/(notes|threads|reports)/.test(path)
}

/** Append the identity fingerprint param to a cacheable API path. */
export function withIdentityParam(path: string, fp: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${IDENTITY_PARAM}=${fp}`
}

/**
 * Drop every suinian-api cache entry that does not belong to `currentFp`
 * (including legacy entries without the param). Best-effort, never throws.
 */
export async function scrubApiCache(currentFp: string): Promise<void> {
  if (typeof caches === "undefined") return
  try {
    const cache = await caches.open(API_CACHE_NAME)
    for (const req of await cache.keys()) {
      if (new URL(req.url).searchParams.get(IDENTITY_PARAM) !== currentFp) {
        await cache.delete(req)
      }
    }
  } catch {
    // cache scrub is best-effort; the per-identity URL key already prevents cross-account hits
  }
}

/** Scrub the api cache for the identity owning `token`. */
export async function scrubApiCacheForToken(token: string): Promise<void> {
  await scrubApiCache(await identityFingerprint(token))
}
