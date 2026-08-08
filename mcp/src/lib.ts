export const SENSITIVE_PLACEHOLDER = "[敏感内容已脱敏]";

export type NoteLike = { is_sensitive?: unknown; content?: unknown; title?: unknown; tags?: unknown };

export function redactNote<T extends NoteLike>(note: T): T {
  if (note && note.is_sensitive)
    return { ...note, content: SENSITIVE_PLACEHOLDER, title: SENSITIVE_PLACEHOLDER, tags: [] };
  return note;
}

export function redactNotes<T extends NoteLike>(notes: T[] | undefined | null): T[] {
  return (notes ?? []).map(redactNote);
}

export function jsonResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(status: number, body: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const msg = typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : body;
  return { content: [{ type: "text", text: `请求失败（HTTP ${status}）：${String(msg)}` }], isError: true };
}
