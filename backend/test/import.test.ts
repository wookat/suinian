import { describe, it, expect } from "vitest";
import {
  normalizeImportDate,
  extractHashTags,
  htmlToText,
  parseCsv,
  parseCuboxCsv,
  parseBookmarkHtml,
  parseCubox,
  parseFlomo,
  parseMarkdown,
  parsePlainText,
  parseImportFile,
} from "../src/import";

describe("normalizeImportDate", () => {
  it("treats bare local datetimes as Asia/Shanghai (+08)", () => {
    expect(normalizeImportDate("2023-06-01 08:30:00")).toBe("2023-06-01 00:30:00");
    expect(normalizeImportDate("2023/6/1 8:30")).toBe("2023-06-01 00:30:00");
  });
  it("keeps explicit zone info", () => {
    expect(normalizeImportDate("2023-06-01T08:30:00Z")).toBe("2023-06-01 08:30:00");
    expect(normalizeImportDate("2023-06-01T08:30:00+08:00")).toBe("2023-06-01 00:30:00");
  });
  it("parses unix epochs in seconds and milliseconds", () => {
    expect(normalizeImportDate(1685579400)).toBe("2023-06-01 00:30:00");
    expect(normalizeImportDate("1685579400")).toBe("2023-06-01 00:30:00");
    expect(normalizeImportDate(1685579400000)).toBe("2023-06-01 00:30:00");
  });
  it("date-only strings become midnight Shanghai", () => {
    expect(normalizeImportDate("2023-06-01")).toBe("2023-05-31 16:00:00");
  });
  it("returns null for garbage", () => {
    expect(normalizeImportDate("")).toBeNull();
    expect(normalizeImportDate("not a date")).toBeNull();
    expect(normalizeImportDate(null)).toBeNull();
  });
});

describe("extractHashTags", () => {
  it("extracts CJK and latin tags", () => {
    expect(extractHashTags("今天读书 #读书 #life/工作 很有收获")).toEqual(["读书", "life/工作"]);
  });
  it("dedupes and caps at 5", () => {
    expect(extractHashTags("#a #a #b #c #d #e #f")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("htmlToText", () => {
  it("converts blocks and entities", () => {
    expect(htmlToText("<p>hello &amp; world</p><p>line2<br>line3</p>")).toBe("hello & world\nline2\nline3");
  });
  it("renders list items", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });
});

describe("parseCsv", () => {
  it("handles quoted fields with commas and newlines", () => {
    const rows = parseCsv('a,"b,1","c\nd"\ne,f,"g""h"');
    expect(rows).toEqual([
      ["a", "b,1", "c\nd"],
      ["e", "f", 'g"h'],
    ]);
  });
  it("strips BOM", () => {
    expect(parseCsv("\uFEFFx,y")).toEqual([["x", "y"]]);
  });
});

describe("parseCuboxCsv", () => {
  const csv = [
    "标题,描述,链接,标签,文件夹,创建时间",
    '"AI 周报","一周 AI 新闻","https://example.com/ai","AI,资讯","收集箱","2023-06-01 08:30:00"',
    '"随手记","","","","收集箱","2023-06-02 10:00:00"',
  ].join("\n");
  it("maps Chinese headers and preserves time/tags/url", () => {
    const items = parseCuboxCsv(csv);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe("https://example.com/ai");
    expect(items[0].tags).toEqual(["AI", "资讯"]);
    expect(items[0].created_at).toBe("2023-06-01 00:30:00");
    expect(items[0].content).toContain("AI 周报");
    expect(items[0].content).toContain("https://example.com/ai");
    expect(items[1].url).toBeNull();
  });
  it("maps English headers too", () => {
    const items = parseCuboxCsv('title,url,tags,created\n"Hi","https://x.com","t1","2023-01-01 00:00:00"');
    expect(items[0].url).toBe("https://x.com");
    expect(items[0].tags).toEqual(["t1"]);
  });
  it("returns [] when no recognizable columns", () => {
    expect(parseCuboxCsv("foo,bar\n1,2")).toEqual([]);
  });
});

describe("parseBookmarkHtml", () => {
  it("parses Netscape bookmark exports (ADD_DATE seconds, TAGS)", () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
<DT><A HREF="https://example.com/a" ADD_DATE="1685579400" TAGS="读书,AI">文章 A</A>
<DT><A HREF="https://example.com/b" ADD_DATE="1685579500">文章 B</A>
</DL>`;
    const items = parseBookmarkHtml(html);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe("https://example.com/a");
    expect(items[0].tags).toEqual(["读书", "AI"]);
    expect(items[0].created_at).toBe("2023-06-01 00:30:00");
    expect(items[1].tags).toEqual([]);
  });
});

describe("parseCubox", () => {
  it("auto-detects bookmark html", () => {
    const items = parseCubox('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://x.com" ADD_DATE="1685579400">X</A></DL>');
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://x.com");
  });
  it("auto-detects csv", () => {
    const items = parseCubox('标题,链接,创建时间\n"A","https://a.com","2023-06-01 08:30:00"');
    expect(items).toHaveLength(1);
  });
  it("falls back to plain text blocks", () => {
    const items = parseCubox("笔记一\n\n笔记二 https://b.com");
    expect(items).toHaveLength(2);
    expect(items[1].url).toBe("https://b.com");
  });
});

describe("parseFlomo", () => {
  const html = `<html><body>
<div class="memo">
  <div class="time">2023-06-01 08:30:00</div>
  <div class="content"><p>今天的想法 #灵感</p></div>
</div>
<div class="memo">
  <div class="time">2023-06-02 09:00:00</div>
  <div class="content"><p>读了一篇文章 https://example.com/read</p></div>
</div>
</body></html>`;
  it("parses memo blocks with time / tags / url", () => {
    const items = parseFlomo(html);
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe("今天的想法 #灵感");
    expect(items[0].created_at).toBe("2023-06-01 00:30:00");
    expect(items[0].tags).toEqual(["灵感"]);
    expect(items[1].url).toBe("https://example.com/read");
  });
});

describe("parseMarkdown / parsePlainText", () => {
  it("splits by --- rules and picks up leading dates", () => {
    const md = "2023-06-01 08:30\n第一条 #tag1\n---\n第二条";
    const items = parseMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0].created_at).toBe("2023-06-01 00:30:00");
    expect(items[0].tags).toEqual(["tag1"]);
    expect(items[1].created_at).toBeNull();
  });
  it("splits by headings when no rules", () => {
    const md = "## 标题一\n内容一\n\n## 标题二\n内容二";
    const items = parseMarkdown(md);
    expect(items).toHaveLength(2);
    expect(items[0].content).toContain("内容一");
  });
  it("plain text splits by blank lines", () => {
    const items = parsePlainText("一\n\n二\n\n三");
    expect(items.map((i) => i.content)).toEqual(["一", "二", "三"]);
  });
  it("separator-only blocks are never imported as notes (R77 P2-3)", () => {
    // plain-text fallback: `---` lines between blank lines became fake notes
    const txt = "第一条\n\n---\n\n第二条\n\n***\n\n———";
    expect(parsePlainText(txt).map((i) => i.content)).toEqual(["第一条", "第二条"]);
    // markdown --- path with a rule-only section between two rules
    const md = "第一条\n---\n***\n---\n第二条";
    expect(parseMarkdown(md).map((i) => i.content)).toEqual(["第一条", "第二条"]);
  });
  it("empty input yields no items", () => {
    expect(parsePlainText("  \n ")).toEqual([]);
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseImportFile", () => {
  it("routes by source", () => {
    expect(parseImportFile("text", "a\n\nb")).toHaveLength(2);
    expect(parseImportFile("markdown", "x")).toHaveLength(1);
  });
});
