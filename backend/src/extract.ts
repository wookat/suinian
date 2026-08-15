import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { chatComplete } from "./ai";
import { parseHtmlMeta, isBlockedTitle, ssrfSafeFetch, FETCH_PROFILES, fallbackTitleFromUrl } from "./linkmeta";
import { sanitizeTags } from "./triage";
import { prepareTagsUpdate } from "./note-store";
import type { Env, NoteMeta, NoteRow } from "./types";

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const FETCH_TIMEOUT_MS = 10_000;
const EXCERPT_CHARS = 2000;


export interface ArticleExtract {
  title: string | null;
  site: string | null;
  excerpt: string | null;
  description: string | null;
}

/** Read a response body as text, capped at `maxBytes`; never throws. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.min(c.byteLength, buf.byteLength - off));
    buf.set(slice, off);
    off += slice.byteLength;
    if (off >= buf.byteLength) break;
  }
  return new TextDecoder("utf-8").decode(buf);
}

function normalizeText(s: string): string {
  return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Extract article content from an HTML string via Readability; never throws. */
export function extractArticle(html: string, url: string): ArticleExtract {
  const meta = parseHtmlMeta(html);
  let title = meta.title;
  let site: string | null = null;
  let excerpt: string | null = null;
  try {
    const siteM =
      html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:site_name["']/i);
    if (siteM) site = siteM[1].trim().slice(0, 100) || null;
    const { document } = parseHTML(html);
    // WeChat articles keep the body in #js_content (hidden until JS runs),
    // which Readability misjudges — read known content containers first
    for (const sel of ["#js_content", ".rich_media_content"]) {
      const el = document.querySelector(sel);
      const text = normalizeText(el?.textContent ?? "");
      if (text.length >= 200) {
        excerpt = text.slice(0, EXCERPT_CHARS);
        break;
      }
    }
    const article = new Readability(document, { charThreshold: 100 }).parse();
    if (article) {
      if (article.title && !isBlockedTitle(article.title)) title = article.title.slice(0, 300);
      if (article.siteName && !site) site = article.siteName.slice(0, 100);
      const text = normalizeText(article.textContent ?? "");
      if (!excerpt && text.length >= 80) excerpt = text.slice(0, EXCERPT_CHARS);
    }
  } catch {
    // fall through to meta-only result
  }
  if (!site) site = hostnameOf(url);
  return { title, site, excerpt, description: meta.description };
}

/**
 * Fetch a URL (2MB / 10s caps, SSRF-guarded) and extract the article,
 * retrying UA/Referer profiles for SSR anti-bot sites; never throws.
 */
export async function fetchArticle(url: string): Promise<ArticleExtract | null> {
  let best: ArticleExtract | null = null;
  for (const profile of FETCH_PROFILES) {
    try {
      const res = await ssrfSafeFetch(url, {
        headers: {
          ...profile,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res) return best; // blocked by SSRF guard: retrying won't help
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("html")) continue;
      const html = await readBodyCapped(res, MAX_HTML_BYTES);
      if (!html) continue;
      const extract = extractArticle(html, url);
      if (extract.excerpt && extract.title) return extract;
      if (!best || (extract.title && !best.title) || (extract.excerpt && !best.excerpt)) best = extract;
    } catch {
      /* try next profile */
    }
  }
  return best;
}

export interface LinkSummary {
  summary: string;
  tags: string[];
}

/** Parse the LLM link-summary output; returns null when invalid. */
export function parseLinkSummaryJson(text: string): LinkSummary | null {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary.trim().slice(0, 500) : "";
  if (!summary) return null;
  const tags = Array.isArray(o.tags)
    ? sanitizeTags(o.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()))
    : [];
  return { summary, tags };
}

/** Generate an 80-120 char Chinese summary + suggested tags for an extracted article. */
export async function summarizeArticle(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  input: { url: string; title: string | null; site: string | null; excerpt: string }
): Promise<LinkSummary | null> {
  const text = await chatComplete(env, {
    temperature: 0.3,
    max_tokens: 300,
    messages: [
      {
        role: "system",
        content:
          '你是「碎念」链接收藏摘要助手。根据网页标题与正文摘录，输出严格 JSON（不要 markdown 代码块），字段：\n- summary: 80-120 字中文摘要，概括文章讲了什么、核心观点/信息，客观陈述，不要"本文""这篇文章"开头\n- tags: 1-3 个中文短标签数组（主题词，不要 # 前缀）\n只输出 JSON。',
      },
      {
        role: "user",
        content: `标题：${input.title ?? "（无）"}\n站点：${input.site ?? "（未知）"}\nURL：${input.url}\n正文摘录：\n${input.excerpt.slice(0, EXCERPT_CHARS)}`,
      },
    ],
  });
  return text ? parseLinkSummaryJson(text) : null;
}

function mergeTags(existing: string[], suggested: string[], max = 5): string[] {
  const out = [...existing];
  for (const t of suggested) {
    if (!out.includes(t) && out.length < max) out.push(t);
  }
  return out;
}

/**
 * Full link enrichment pipeline for one note: fetch + extract the article,
 * AI-summarize it, then persist site/excerpt/summary into the note (meta JSON
 * merge) and union suggested tags into the note's tags. On fetch/extract
 * failure the note keeps its title-only state; the attempt is still recorded
 * in meta.link_fetched_at so the backfill sweep does not retry forever.
 */
export async function enrichLinkInto(env: Env, noteId: string): Promise<void> {
  const note = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(noteId).first<NoteRow>();
  if (!note?.url) return;
  // 敏感笔记不做链接富化：link_excerpt / url_summary 都是派生明文（R126 P1-1）
  if (note.is_sensitive) return;
  const extract = await fetchArticle(note.url);
  // 富化只 json_patch 自己的 link_* 派生键：整包写回会把慢网络/AI 期间的
  // 用户 meta 编辑静默回滚（与分拣写后写竞态同类）
  const meta: Partial<NoteMeta> = { link_fetched_at: new Date().toISOString() };

  if (!extract || !extract.excerpt) {
    // title-only fallback: keep the link + its domain and record a readable status;
    // when no title could be fetched at all, fall back to domain + readable path
    // so the card never shows just a bare URL
    meta.link_status = extract ? "no_content" : "fetch_failed";
    meta.link_site = extract?.site ?? hostnameOf(note.url) ?? undefined;
    const title = extract?.title ?? null;
    const fallback = note.url_title ? null : (title ?? fallbackTitleFromUrl(note.url));
    await env.DB.prepare(
      "UPDATE notes SET url_title = COALESCE(?, url_title), meta = json_patch(coalesce(meta, '{}'), ?), updated_at = datetime('now') WHERE id = ? AND is_sensitive = 0"
    )
      .bind(fallback, JSON.stringify(meta), noteId)
      .run();
    return;
  }

  meta.link_status = "ok";
  meta.link_site = extract.site ?? undefined;
  meta.link_excerpt = extract.excerpt;

  const ai = await summarizeArticle(env, {
    url: note.url,
    title: extract.title ?? note.url_title,
    site: extract.site,
    excerpt: extract.excerpt,
  });
  const summary = ai?.summary ?? extract.description ?? null;

  await env.DB.prepare(
    "UPDATE notes SET url_title = COALESCE(?, url_title), url_summary = COALESCE(?, url_summary), meta = json_patch(coalesce(meta, '{}'), ?), updated_at = datetime('now') WHERE id = ? AND is_sensitive = 0"
  )
    .bind(extract.title && !note.url_title ? extract.title : null, summary ?? null, JSON.stringify(meta), noteId)
    .run();
  if (ai && ai.tags.length > 0) {
    const existing = (() => {
      try {
        return JSON.parse(note.tags || "[]") as string[];
      } catch {
        return [];
      }
    })();
    const merged = mergeTags(existing, ai.tags);
    if (merged.length !== existing.length) {
      // tags 写入统一走持久层（敏感行严格过滤）
      await prepareTagsUpdate(env.DB, { id: note.id, user_id: note.user_id, is_sensitive: note.is_sensitive }, merged).run();
    }
  }
}

/**
 * Backfill sweep for existing link notes that were saved before article
 * extraction existed (or whose async enrichment was cancelled): picks the
 * newest link notes without a recorded fetch attempt, a few per cron run
 * so external sites are never hammered.
 */
export async function backfillLinkExtracts(env: Env, limit = 3): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM notes
     WHERE url IS NOT NULL AND deleted_at IS NULL
       AND (meta IS NULL OR meta NOT LIKE '%"link_fetched_at"%')
       AND created_at < datetime('now', '-2 minutes')
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of results ?? []) {
    await enrichLinkInto(env, row.id).catch((err) => console.error("backfill link extract failed", row.id, err));
  }
}
