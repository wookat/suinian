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

// 附件原件的二进制加密封装（R154 P2-2）：R2 对象体 = MAGIC(4) + IV(12) + AES-GCM 密文。
// 读取侧按 magic 自动识别，明文存量对象无缝兼容。
const ATT_MAGIC = new Uint8Array([0x53, 0x4e, 0x45, 0x31]); // "SNE1"

/** Does this R2 object body carry the encrypted-attachment envelope? */
export function isEncryptedAttachment(bytes: Uint8Array): boolean {
  if (bytes.length < ATT_MAGIC.length + 12) return false;
  for (let i = 0; i < ATT_MAGIC.length; i++) if (bytes[i] !== ATT_MAGIC[i]) return false;
  return true;
}

/** Encrypt attachment bytes → MAGIC + IV + ciphertext. */
export async function encryptBytes(keyB64: string, bytes: Uint8Array): Promise<Uint8Array> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes.slice().buffer as ArrayBuffer));
  const out = new Uint8Array(ATT_MAGIC.length + iv.length + ct.length);
  out.set(ATT_MAGIC, 0);
  out.set(iv, ATT_MAGIC.length);
  out.set(ct, ATT_MAGIC.length + iv.length);
  return out;
}

/** Decrypt an encrypted-attachment envelope; returns null when not encrypted, malformed or key mismatch. */
export async function decryptBytes(keyB64: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (!isEncryptedAttachment(bytes)) return null;
    const iv = bytes.subarray(ATT_MAGIC.length, ATT_MAGIC.length + 12);
    const ct = bytes.subarray(ATT_MAGIC.length + 12);
    const key = await importKey(keyB64);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.slice().buffer as ArrayBuffer },
      key,
      ct.slice().buffer as ArrayBuffer
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/**
 * 当前指纹算法版本（meta.import_fp_v）：v1 = HMAC-SHA256(SUINIAN_ENC_KEY)，
 * 无密钥时退化 SHA-256。升级算法/换钥时递增版本号，去重时按版本分别
 * 计算候选指纹即可平滑迁移（sweepImportDedupe 已具备解密重算机制）。
 */
export const IMPORT_FP_VERSION = 1;

/**
 * 内容指纹（导入去重）：有密钥时按 HMAC-SHA256（DB 泄露不可对短内容做字典
 * 反猜），无密钥的本地/自部署环境退化为 SHA-256。输出 base64。
 */
export async function contentFingerprint(keyB64: string | undefined, content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  if (keyB64) {
    const key = await crypto.subtle.importKey(
      "raw",
      b64decode(keyB64.trim()).slice().buffer as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return b64encode(await crypto.subtle.sign("HMAC", key, data));
  }
  return b64encode(await crypto.subtle.digest("SHA-256", data));
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
