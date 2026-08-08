import { describe, it, expect } from "vitest";
import { redactNote, redactNotes, jsonResult, errorResult, SENSITIVE_PLACEHOLDER } from "./lib.js";

describe("redactNote", () => {
  it("redacts content, title and tags of sensitive notes", () => {
    const note = { is_sensitive: 1, content: "密码 abc123", title: "银行卡", tags: ["凭据"] };
    const out = redactNote(note);
    expect(out.content).toBe(SENSITIVE_PLACEHOLDER);
    expect(out.title).toBe(SENSITIVE_PLACEHOLDER);
    expect(out.tags).toEqual([]);
  });

  it("keeps non-sensitive notes untouched", () => {
    const note = { is_sensitive: 0, content: "买牛奶", title: "购物", tags: ["生活"] };
    expect(redactNote(note)).toEqual(note);
  });
});

describe("redactNotes", () => {
  it("handles null/undefined and mixed lists", () => {
    expect(redactNotes(null)).toEqual([]);
    expect(redactNotes(undefined)).toEqual([]);
    const out = redactNotes([
      { is_sensitive: 1, content: "secret" },
      { is_sensitive: 0, content: "plain" },
    ]);
    expect(out[0].content).toBe(SENSITIVE_PLACEHOLDER);
    expect(out[1].content).toBe("plain");
  });
});

describe("jsonResult", () => {
  it("wraps data as pretty-printed text content", () => {
    const out = jsonResult({ a: 1 });
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text)).toEqual({ a: 1 });
  });
});

describe("errorResult", () => {
  it("extracts error field from body", () => {
    const out = errorResult(401, { error: "unauthorized" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("请求失败（HTTP 401）：unauthorized");
  });

  it("falls back to raw body", () => {
    const out = errorResult(500, "boom");
    expect(out.content[0].text).toBe("请求失败（HTTP 500）：boom");
  });
});
