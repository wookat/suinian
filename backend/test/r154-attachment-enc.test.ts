// R154 P2-2：敏感附件原件 R2 静态加密（SNE1 信封）——加解密对合、存量兼容、
// fail-closed 取件、转敏感收口。
import { describe, it, expect } from "vitest";
import { encryptBytes, decryptBytes, isEncryptedAttachment } from "../src/crypto";
import { loadOriginal, syncAttachmentEncryption } from "../src/media";
import type { Env } from "../src/types";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const OTHER_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function fakeR2(store: Map<string, Uint8Array>) {
  return {
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return {
        async arrayBuffer() {
          return data.slice().buffer;
        },
      };
    },
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async head(key: string) {
      return store.has(key) ? { customMetadata: {} } : null;
    },
  } as unknown as R2Bucket;
}

function fakeDb(attachments: { r2_key: string; mime: string | null }[]) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: attachments };
            },
            async first() {
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("attachment envelope crypto", () => {
  it("encrypt → decrypt roundtrip", async () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5, 200, 255]);
    const enc = await encryptBytes(KEY, plain);
    expect(isEncryptedAttachment(enc)).toBe(true);
    expect(isEncryptedAttachment(plain)).toBe(false);
    const dec = await decryptBytes(KEY, enc);
    expect(dec).not.toBeNull();
    expect(Array.from(dec!)).toEqual(Array.from(plain));
  });

  it("wrong key fails closed (null, never garbage)", async () => {
    const enc = await encryptBytes(KEY, new Uint8Array([9, 9, 9]));
    expect(await decryptBytes(OTHER_KEY, enc)).toBeNull();
  });

  it("plaintext bytes are not mistaken for envelopes", async () => {
    expect(await decryptBytes(KEY, new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("loadOriginal", () => {
  it("returns plaintext legacy objects as-is", async () => {
    const store = new Map([["k", new Uint8Array([7, 8, 9])]]);
    const env = { MEDIA: fakeR2(store), SUINIAN_ENC_KEY: KEY } as unknown as Env;
    expect(Array.from((await loadOriginal(env, "k"))!)).toEqual([7, 8, 9]);
  });

  it("transparently decrypts envelopes", async () => {
    const enc = await encryptBytes(KEY, new Uint8Array([4, 5, 6]));
    const env = { MEDIA: fakeR2(new Map([["k", enc]])), SUINIAN_ENC_KEY: KEY } as unknown as Env;
    expect(Array.from((await loadOriginal(env, "k"))!)).toEqual([4, 5, 6]);
  });

  it("fails closed when the key is missing or wrong", async () => {
    const enc = await encryptBytes(KEY, new Uint8Array([4, 5, 6]));
    const noKey = { MEDIA: fakeR2(new Map([["k", enc]])) } as unknown as Env;
    expect(await loadOriginal(noKey, "k")).toBeNull();
    const wrongKey = { MEDIA: fakeR2(new Map([["k", enc]])), SUINIAN_ENC_KEY: OTHER_KEY } as unknown as Env;
    expect(await loadOriginal(wrongKey, "k")).toBeNull();
  });
});

describe("syncAttachmentEncryption", () => {
  it("rewrites plaintext originals as envelopes (idempotent)", async () => {
    const store = new Map([["media/u/n/1-a.png", new Uint8Array([1, 2, 3])]]);
    const env = {
      MEDIA: fakeR2(store),
      DB: fakeDb([{ r2_key: "media/u/n/1-a.png", mime: "image/png" }]),
      SUINIAN_ENC_KEY: KEY,
    };
    await syncAttachmentEncryption(env, "n");
    const stored = store.get("media/u/n/1-a.png")!;
    expect(isEncryptedAttachment(stored)).toBe(true);
    expect(Array.from((await decryptBytes(KEY, stored))!)).toEqual([1, 2, 3]);
    // second run leaves the envelope untouched
    await syncAttachmentEncryption(env, "n");
    expect(Array.from(store.get("media/u/n/1-a.png")!)).toEqual(Array.from(stored));
  });

  it("no-ops without a key", async () => {
    const store = new Map([["k", new Uint8Array([1])]]);
    await syncAttachmentEncryption({ MEDIA: fakeR2(store), DB: fakeDb([{ r2_key: "k", mime: null }]) }, "n");
    expect(isEncryptedAttachment(store.get("k")!)).toBe(false);
  });
});
