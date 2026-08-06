import { describe, it, expect } from "vitest";
import { extractUrl, parseHtmlMeta } from "../src/linkmeta";

describe("extractUrl", () => {
  it("extracts url from mixed text", () => {
    expect(extractUrl("看看这个 https://example.com/a?b=1 不错")).toBe("https://example.com/a?b=1");
  });
  it("returns null when none", () => {
    expect(extractUrl("没有链接")).toBeNull();
  });
});

describe("parseHtmlMeta", () => {
  it("parses title and description", () => {
    const html = `<html><head><title>Hello &amp; World</title>
      <meta name="description" content="A test page"></head><body></body></html>`;
    expect(parseHtmlMeta(html)).toEqual({ title: "Hello & World", description: "A test page" });
  });
  it("falls back to og:description", () => {
    const html = `<head><title>T</title><meta property="og:description" content="og desc"></head>`;
    expect(parseHtmlMeta(html).description).toBe("og desc");
  });
  it("returns nulls when absent", () => {
    expect(parseHtmlMeta("<p>x</p>")).toEqual({ title: null, description: null });
  });
});
