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

/** Parse <title> and meta description from an HTML string. */
export function parseHtmlMeta(html: string): { title: string | null; description: string | null } {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleM ? decodeEntities(titleM[1]).slice(0, 300) : null;
  if (isBlockedTitle(title)) title = null;
  const descM =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
  const description = descM ? decodeEntities(descM[1]).slice(0, 500) : null;
  return { title, description };
}

/** Fetch a URL and return its title/description; never throws. */
export async function fetchLinkMeta(
  url: string
): Promise<{ title: string | null; description: string | null }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; SuinianBot/1.0; +https://suinian.zalize.com)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(8000),
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("html")) return { title: null, description: null };
    const html = (await res.text()).slice(0, 200_000);
    return parseHtmlMeta(html);
  } catch {
    return { title: null, description: null };
  }
}
