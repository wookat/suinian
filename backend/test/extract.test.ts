import { describe, expect, it } from "vitest";
import { extractArticle, parseLinkSummaryJson } from "../src/extract";

const PARA = "这是一段用于测试正文抽取的中文段落，包含足够多的文字让 Readability 认为这是文章主体内容。";

function articleHtml(): string {
  return `<html><head><title>测试文章标题</title>
<meta property="og:site_name" content="测试站点" />
<meta name="description" content="元描述" />
</head><body><nav>导航 首页 关于</nav><article><h1>测试文章标题</h1>${`<p>${PARA}</p>`.repeat(10)}</article></body></html>`;
}

describe("extractArticle", () => {
  it("extracts title, site and excerpt from an article page", () => {
    const r = extractArticle(articleHtml(), "https://example.com/post/1");
    expect(r.title).toContain("测试文章标题");
    expect(r.site).toBe("测试站点");
    expect(r.excerpt).toBeTruthy();
    expect(r.excerpt).toContain("正文抽取");
    expect(r.excerpt!.length).toBeLessThanOrEqual(2000);
    expect(r.description).toBe("元描述");
  });

  it("falls back to hostname as site and null excerpt for thin pages", () => {
    const r = extractArticle("<html><head><title>t</title></head><body><p>短</p></body></html>", "https://foo.bar/x");
    expect(r.site).toBe("foo.bar");
    expect(r.excerpt).toBeNull();
    expect(r.title).toBe("t");
  });

  it("never throws on garbage html", () => {
    const r = extractArticle("<<<>>>not html", "not-a-url");
    expect(r.excerpt).toBeNull();
    expect(r.site).toBeNull();
  });
});

describe("parseLinkSummaryJson", () => {
  it("parses a plain JSON object", () => {
    const r = parseLinkSummaryJson('{"summary":"这篇讲了向量检索的原理与工程实践。","tags":["向量检索","RAG"]}');
    expect(r?.summary).toContain("向量检索");
    expect(r?.tags).toEqual(["向量检索", "RAG"]);
  });

  it("parses fenced JSON and caps tags at 3", () => {
    const r = parseLinkSummaryJson('```json\n{"summary":"s","tags":["a","b","c","d"]}\n```');
    expect(r?.summary).toBe("s");
    expect(r?.tags).toEqual(["a", "b", "c"]);
  });

  it("returns null on missing summary or invalid JSON", () => {
    expect(parseLinkSummaryJson('{"tags":["a"]}')).toBeNull();
    expect(parseLinkSummaryJson("not json")).toBeNull();
  });
});
