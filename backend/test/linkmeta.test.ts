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
  it("falls back to og:title when <title> is empty (WeChat mp pages)", () => {
    const html = `<head><title></title><meta property="og:title" content="公众号文章标题" />
      <meta property="og:description" content="摘要" /></head>`;
    expect(parseHtmlMeta(html)).toEqual({ title: "公众号文章标题", description: "摘要" });
  });
  it("falls back to var msg_title when no title/og:title", () => {
    const html = `<head><title></title></head><script>var msg_title = 'JS 里的标题';</script>`;
    expect(parseHtmlMeta(html).title).toBe("JS 里的标题");
  });
  it("still blocks interstitial titles coming from og:title", () => {
    const html = `<head><title></title><meta property="og:title" content="环境异常" /></head>`;
    expect(parseHtmlMeta(html).title).toBeNull();
  });
});
