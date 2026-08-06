// AES-256-GCM encryption for sensitive note content.
// Key: 32 random bytes, base64-encoded, stored as the SUINIAN_ENC_KEY worker secret.

export const ENC_PLACEHOLDER = "[加密内容]";
const ENC_PREFIX = "v1:";

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
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

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64.trim());
  if (raw.length !== 32) throw new Error("SUINIAN_ENC_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt plaintext → "v1:<b64 iv>:<b64 ciphertext>". */
export async function encryptContent(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${ENC_PREFIX}${b64encode(iv)}:${b64encode(ct)}`;
}

/** Decrypt a "v1:<b64 iv>:<b64 ciphertext>" string; returns null when malformed or key mismatch. */
export async function decryptContent(keyB64: string, enc: string): Promise<string | null> {
  try {
    if (!enc.startsWith(ENC_PREFIX)) return null;
    const [ivB64, ctB64] = enc.slice(ENC_PREFIX.length).split(":");
    if (!ivB64 || !ctB64) return null;
    const key = await importKey(keyB64);
    const iv = b64decode(ivB64);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, b64decode(ctB64).buffer as ArrayBuffer);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
