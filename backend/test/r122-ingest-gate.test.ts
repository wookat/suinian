// R122 P1-1：写入层统一敏感管道 sensitiveIngestGate 的口径测试——
// 所有入库路径（速记/导入/恢复/微信/MCP/扩展/Android/媒体重试）共用同一段
// fail-closed 预检 + 元数据洗净，这里锁死这段口径本身的行为。
import { describe, expect, it } from "vitest";
import { sensitiveIngestGate } from "../src/ingest";
import { decryptContent, ENC_PLACEHOLDER } from "../src/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));
const env = { SUINIAN_ENC_KEY: KEY };

describe("sensitiveIngestGate", () => {
  it("passes plain notes through untouched", async () => {
    const g = await sensitiveIngestGate(env, { content: "午饭吃了牛肉面 28 块", title: "午饭", tags: ["吃饭"], is_sensitive: false });
    expect(g).toEqual({ content: "午饭吃了牛肉面 28 块", content_enc: null, title: "午饭", tags: ["吃饭"], is_sensitive: false, needs_retriage: false });
  });

  it("encrypts hint-hit content fail-closed and marks needs_retriage (rejudge path)", async () => {
    const g = await sensitiveIngestGate(env, { content: "服务器 root 口令 P@ss2026 记一下", title: "口令 P@ss2026", tags: ["P@ss2026", "服务器"], is_sensitive: false });
    expect(g.content).toBe(ENC_PLACEHOLDER);
    expect(g.is_sensitive).toBe(true);
    expect(g.needs_retriage).toBe(true);
    expect(g.title).toBeNull();
    expect(g.tags).not.toContain("P@ss2026");
    expect(await decryptContent(KEY, g.content_enc!)).toBe("服务器 root 口令 P@ss2026 记一下");
  });

  it("skip-triage path uses high-precision detector only", async () => {
    // 宽口径疑似（无秘密值）在 rejudge:false 下不应永久加密
    const g = await sensitiveIngestGate(env, { content: "记得改一下路由器密码", title: null, tags: [], is_sensitive: false }, { rejudge: false });
    expect(g.is_sensitive).toBe(false);
    // 确定命中仍然加密，且不标 needs_retriage（没有后续模型复判）
    const g2 = await sensitiveIngestGate(env, { content: "api key 备忘 sk-abcdefghijklmnop1234", title: null, tags: [], is_sensitive: false }, { rejudge: false });
    expect(g2.content).toBe(ENC_PLACEHOLDER);
    expect(g2.is_sensitive).toBe(true);
    expect(g2.needs_retriage).toBe(false);
  });

  it("honors caller-provided is_sensitive verdict (backup restore)", async () => {
    const g = await sensitiveIngestGate(env, { content: "看起来完全无害的内容", title: "标题", tags: ["旅行"], is_sensitive: true });
    expect(g.content).toBe(ENC_PLACEHOLDER);
    expect(g.is_sensitive).toBe(true);
    expect(g.needs_retriage).toBe(false);
    expect(g.title).toBeNull();
  });

  it("does not re-encrypt an already-redacted placeholder", async () => {
    const g = await sensitiveIngestGate(env, { content: ENC_PLACEHOLDER, title: null, tags: [], is_sensitive: true });
    expect(g.content).toBe(ENC_PLACEHOLDER);
    expect(g.content_enc).toBeNull();
    expect(g.is_sensitive).toBe(true);
  });
});
