const URL_RE = /https?:\/\/[^\s<>"'）)\]】，,；;]+/;

/** Extract the first URL found in text, or null. */
export function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

/** Extract up to `max` distinct URLs from text, in order of appearance. */
export function extractUrls(text: string, max = 3): string[] {
  const re = new RegExp(URL_RE.source, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while (out.length < max && (m = re.exec(text)) !== null) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Titles of anti-bot / error interstitials that must never be saved as a page title. */
const BLOCKED_TITLE_RE =
  /^(环境异常|参数错误|验证|安全验证|访问异常|请在微信客户端打开链接)$|Just a moment|Access Denied|Attention Required|403 Forbidden|404 Not Found/i;

/** True when a fetched page title is an anti-bot/error interstitial, not real content. */
export function isBlockedTitle(title: string | null): boolean {
  return !!title && BLOCKED_TITLE_RE.test(title.trim());
}

/**
 * Parse title and meta description from an HTML string. Title resolution
 * order: <title> → og:title → twitter:title → `var msg_title = "…"` (WeChat
 * mp pages ship an empty <title> and keep the real one in og:title / JS vars).
 */
export function parseHtmlMeta(html: string): { title: string | null; description: string | null } {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title: string | null = titleM ? decodeEntities(titleM[1]).slice(0, 300) : null;
  if (!title) {
    const m =
      html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/var\s+msg_title\s*=\s*['"]([^'"]+)['"]/);
    if (m) title = decodeEntities(m[1]).slice(0, 300) || null;
  }
  if (isBlockedTitle(title)) title = null;
  const descM =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  const description = descM ? decodeEntities(descM[1]).slice(0, 500) : null;
  return { title, description };
}

// ---- SSRF guard: only public http(s) targets, re-checked on every redirect hop ----

const FORBIDDEN_HOST_RE = /^(localhost|.+\.localhost|.+\.local|.+\.internal|metadata\.google\.internal)$/i;

function parseIpv4(host: string): number[] | null {
  // pure-integer hosts (http://2130706433) resolve as IPv4 too
  if (/^\d+$/.test(host) && host.length > 3) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-net / private / loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** True when a URL must not be fetched server-side: non-http(s) scheme, or a private/reserved/link-local/internal host. */
export function isForbiddenUrl(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (FORBIDDEN_HOST_RE.test(host)) return true;
  if (host.includes(":")) {
    // IPv6 literal
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host)) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    if (host.startsWith("::ffff:")) {
      const v4 = parseIpv4(host.slice(7));
      return !v4 || isPrivateIpv4(v4);
    }
    return false;
  }
  const v4 = parseIpv4(host);
  return v4 ? isPrivateIpv4(v4) : false;
}

const MAX_REDIRECTS = 3;

/**
 * fetch with the SSRF guard applied to the initial URL and every redirect hop
 * (redirects followed manually, capped at 3). Returns null when blocked.
 */
export async function ssrfSafeFetch(rawUrl: string, init: RequestInit): Promise<Response | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isForbiddenUrl(url)) return null;
    const res = await fetch(url.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REDIRECTS) return null;
      try {
        url = new URL(loc, url);
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null;
}

// browser-like UA: many sites (WeChat mp, big media) serve interstitials
// or empty meta to obvious bot UAs
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** UA/Referer combos tried in order: SSR anti-bot sites (36kr 等) often reject one profile but accept another. */
export const FETCH_PROFILES: Record<string, string>[] = [
  { "user-agent": DESKTOP_UA },
  { "user-agent": MOBILE_UA, referer: "https://www.google.com/" },
];

const COMMON_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/** Readable fallback title for a link that could not be fetched: domain + decoded path tail. */
export function fallbackTitleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep raw path */
    }
    const tail = path.split("/").filter(Boolean).slice(-2).join("/");
    return tail ? `${u.hostname}/${tail}`.slice(0, 300) : u.hostname;
  } catch {
    return null;
  }
}

/** Fetch a URL and return its title/description, retrying UA/Referer profiles; never throws. */
export async function fetchLinkMeta(
  url: string
): Promise<{ title: string | null; description: string | null }> {
  let best: { title: string | null; description: string | null } = { title: null, description: null };
  for (const profile of FETCH_PROFILES) {
    try {
      const res = await ssrfSafeFetch(url, {
        headers: { ...COMMON_HEADERS, ...profile },
        signal: AbortSignal.timeout(8000),
      });
      if (!res) return best; // blocked by SSRF guard: retrying won't help
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("html")) continue;
      const html = (await res.text()).slice(0, 200_000);
      const meta = parseHtmlMeta(html);
      if (meta.title) return meta;
      if (!best.description && meta.description) best = meta;
    } catch {
      /* try next profile */
    }
  }
  return best;
}
