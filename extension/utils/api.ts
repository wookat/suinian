/** Settings + API client shared by the popup, options page, and background. */

export interface Settings {
  apiBaseUrl: string;
  apiToken: string;
}

export const DEFAULT_API_BASE = "https://suinian-api.zalize.com";

export async function loadSettings(): Promise<Settings> {
  const raw = await browser.storage.sync.get({ apiBaseUrl: DEFAULT_API_BASE, apiToken: "" });
  return {
    apiBaseUrl: String(raw.apiBaseUrl || DEFAULT_API_BASE).trim().replace(/\/$/, ""),
    apiToken: String(raw.apiToken || "").trim(),
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.sync.set({
    apiBaseUrl: s.apiBaseUrl.trim().replace(/\/$/, ""),
    apiToken: s.apiToken.trim(),
  });
}

export interface SaveNotePayload {
  content: string;
  url?: string;
  tags?: string[];
}

export async function saveNote(payload: SaveNotePayload): Promise<{ id: string }> {
  const { apiBaseUrl, apiToken } = await loadSettings();
  if (!apiToken) throw new Error("未配置 API Token：请先到扩展设置页填写");
  const res = await fetch(`${apiBaseUrl}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      source: "extension",
      raw_type: payload.url ? "link" : "text",
      content: payload.content,
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.tags && payload.tags.length > 0 ? { tags: payload.tags } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
    } catch {
      /* keep raw text */
    }
    if (res.status === 401 || res.status === 403) message = "Token 无效或已过期，请到扩展设置页检查";
    throw new Error(message);
  }
  const data = (await res.json()) as { note?: { id: string }; id?: string };
  return { id: data.note?.id ?? data.id ?? "" };
}

export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  const { apiBaseUrl, apiToken } = await loadSettings();
  if (!apiToken) return { ok: false, message: "请先填写 API Token" };
  try {
    const res = await fetch(`${apiBaseUrl}/api/notes?limit=1`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    if (res.ok) return { ok: true, message: "连接成功，Token 有效" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Token 无效或已过期" };
    return { ok: false, message: `服务器返回错误（${res.status}）` };
  } catch {
    return { ok: false, message: "无法连接到服务器，请检查 API 地址" };
  }
}

/** Compose the note content for a selection clip, with the source appended. */
export function selectionContent(selection: string, title: string | undefined, url: string): string {
  const src = title ? `${title}\n${url}` : url;
  return `${selection.trim()}\n\n—— 摘自 ${src}`;
}

export const MAX_EXCERPT_CHARS = 3000;

/** Compose the note content for a full-page clip. */
export function pageContent(opts: {
  note?: string;
  title: string;
  url: string;
  excerpt?: string;
}): string {
  const parts: string[] = [];
  if (opts.note?.trim()) parts.push(opts.note.trim());
  parts.push(`${opts.title}\n${opts.url}`);
  if (opts.excerpt?.trim()) parts.push(opts.excerpt.trim().slice(0, MAX_EXCERPT_CHARS));
  return parts.join("\n\n");
}
