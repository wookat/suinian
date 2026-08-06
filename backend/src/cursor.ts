/** Cursor = base64("created_at|id") of the last row on the previous page. */
export function encodeCursor(createdAt: string, id: string): string {
  return btoa(unescape(encodeURIComponent(`${createdAt}|${id}`)));
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const raw = decodeURIComponent(escape(atob(cursor)));
    const idx = raw.lastIndexOf("|");
    if (idx <= 0) return null;
    const createdAt = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
