/** Settings + API client shared by the popup, options page, and background. */

export interface Settings {
  apiBaseUrl: string;
  apiToken: string;
  webBaseUrl: string;
}

export const DEFAULT_API_BASE = "https://suinian-api.zalize.com";
export const DEFAULT_WEB_BASE = "https://suinian.zalize.com";

// API token 存 storage.local（R122 P2）：storage.sync 会把 token 同步到用户
// 浏览器账号云端与其它设备，扩大泄露面；凭据只留本机。旧版 sync 里的
// 设置首次读取时自动迁移到 local 并从云端清除。
const SETTING_DEFAULTS = { apiBaseUrl: DEFAULT_API_BASE, apiToken: "", webBaseUrl: DEFAULT_WEB_BASE };

async function migrateFromSync(): Promise<void> {
  try {
    const legacy = await browser.storage.sync.get(SETTING_DEFAULTS);
    if (String(legacy.apiToken || "").trim() || String(legacy.apiBaseUrl || "") !== DEFAULT_API_BASE) {
      await browser.storage.local.set(legacy);
    }
    await browser.storage.sync.remove(["apiBaseUrl", "apiToken", "webBaseUrl"]);
  } catch {
    // sync 不可用时跳过迁移，不影响 local 读写
  }
}

export async function loadSettings(): Promise<Settings> {
  let raw = await browser.storage.local.get(SETTING_DEFAULTS);
  if (!String(raw.apiToken || "").trim()) {
    await migrateFromSync();
    raw = await browser.storage.local.get(SETTING_DEFAULTS);
  }
  return {
    apiBaseUrl: String(raw.apiBaseUrl || DEFAULT_API_BASE).trim().replace(/\/$/, ""),
    apiToken: String(raw.apiToken || "").trim(),
    webBaseUrl: String(raw.webBaseUrl || DEFAULT_WEB_BASE).trim().replace(/\/$/, ""),
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({
    apiBaseUrl: s.apiBaseUrl.trim().replace(/\/$/, ""),
    apiToken: s.apiToken.trim(),
    webBaseUrl: (s.webBaseUrl || DEFAULT_WEB_BASE).trim().replace(/\/$/, ""),
  });
}

export type Category = "idea" | "todo" | "collect" | "data" | "expense" | "income" | "transfer";

export const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "资金往来" },
];

export interface SaveNotePayload {
  content: string;
  url?: string;
  tags?: string[];
  category?: Category;
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const { apiBaseUrl, apiToken } = await loadSettings();
  if (!apiToken) throw new Error("未配置 API Token：请先到扩展设置页填写");
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}`, ...init.headers },
    });
  } catch {
    throw new Error("无法连接到碎念服务器：请检查网络，或到扩展设置页确认 API 地址");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || `服务器返回错误（HTTP ${res.status}）`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
    } catch {
      /* keep raw text */
    }
    if (res.status === 401 || res.status === 403) message = "Token 无效或已过期：请到扩展设置页重新粘贴 Token（Web 端设置页可复制）";
    throw new Error(message);
  }
  return res;
}

/**
 * 同页重复剪藏检测（R164 P2）：同 URL + 内容完全一致的未删除扩展笔记视为
 * 重复（与 import_fp「内容指纹」思路一致，这里两边都有明文故直接精确比对，
 * 不必新增指纹字段）。查询失败时返回 null——去重是尽力而为，绝不阻断保存。
 */
export async function findDuplicateNote(url: string, content: string): Promise<{ id: string } | null> {
  try {
    const res = await apiFetch(
      `/api/notes?url=${encodeURIComponent(url)}&source=extension&limit=20`,
      { method: "GET" }
    );
    const data = (await res.json()) as { notes?: { id: string; content: string }[] };
    const hit = (data.notes ?? []).find((n) => n.content === content);
    return hit ? { id: hit.id } : null;
  } catch {
    return null;
  }
}

export async function saveNote(payload: SaveNotePayload): Promise<{ id: string }> {
  const res = await apiFetch("/api/notes", {
    method: "POST",
    body: JSON.stringify({
      source: "extension",
      raw_type: payload.url ? "link" : "text",
      content: payload.content,
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.tags && payload.tags.length > 0 ? { tags: payload.tags } : {}),
    }),
  });
  const data = (await res.json()) as { note?: { id: string }; id?: string };
  const id = data.note?.id ?? data.id ?? "";
  // manual category: same PATCH 路径 as MCP，设 manual_override 后 AI 不再覆盖
  if (payload.category && id) {
    await apiFetch(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ category: payload.category }),
    }).catch(() => undefined); // 保存已成功，分类补写失败不阻断
  }
  return { id };
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
