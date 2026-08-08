import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";
import { parseImportZip, parseFrontmatter, unzipEntries } from "../src/import-zip";
import { normalizeImportDate } from "../src/import";

/** Zip a fixture directory the way the official tools do (paths relative to the dir). */
const FIXTURES_DIR = new URL("./fixtures", import.meta.url).pathname;

function zipFixture(name: string): Uint8Array {
  const root = join(FIXTURES_DIR, name);
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(root, full).split("\\").join("/")] = readFileSync(full);
    }
  };
  walk(root);
  return zipSync(files);
}

describe("normalizeImportDate (Notion English dates)", () => {
  it("parses 'June 1, 2023 8:30 AM' as Asia/Shanghai", () => {
    expect(normalizeImportDate("June 1, 2023 8:30 AM")).toBe("2023-06-01 00:30:00");
    expect(normalizeImportDate("June 3, 2023 9:00 PM")).toBe("2023-06-03 13:00:00");
    expect(normalizeImportDate("December 25, 2022")).toBe("2022-12-24 16:00:00");
  });
});

describe("parseImportZip: notion", () => {
  const result = parseImportZip("notion", zipFixture("notion"));

  it("imports every md page (top-level, nested, database rows)", () => {
    const contents = result.items.map((i) => i.content);
    expect(contents.some((c) => c.startsWith("碎念测试主页"))).toBe(true);
    expect(contents.some((c) => c.startsWith("子页面"))).toBe(true);
    expect(contents.some((c) => c.startsWith("深度工作"))).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("parses database-row property block: created time / tags / url", () => {
    const row = result.items.find((i) => i.content.startsWith("深度工作"))!;
    expect(row.created_at).toBe("2023-06-01 00:30:00");
    expect(row.tags).toEqual(["读书", "效率"]);
    expect(row.url).toBe("https://example.com/deep-work");
    expect(row.content).not.toContain("Created time:");
    expect(row.content).toContain("这本书讲专注力管理");
  });

  it("collects image assets and replaces refs with markers", () => {
    const home = result.items.find((i) => i.content.startsWith("碎念测试主页"))!;
    expect(home.content).toContain("【图片：cover.png】");
    expect(home.assets).toHaveLength(1);
    expect(home.assets![0].mime).toBe("image/png");
    expect(home.assets![0].bytes.length).toBeGreaterThan(0);
  });

  it("turns internal page links into plain text, keeps external links", () => {
    const home = result.items.find((i) => i.content.startsWith("碎念测试主页"))!;
    expect(home.content).toContain("参考子页面：子页面");
    expect(home.content).toContain("https://www.notion.com/help/export-your-content");
    expect(home.content).not.toContain("%20");
  });

  it("imports CSV-only rows once, skipping rows that exist as md pages", () => {
    const csvOnly = result.items.filter((i) => i.content.startsWith("只在 CSV 里的一行"));
    expect(csvOnly).toHaveLength(1);
    expect(csvOnly[0].created_at).toBe("2023-06-03 13:00:00");
    expect(csvOnly[0].tags).toEqual(["速记"]);
    // "深度工作" appears once (md page), not duplicated from the CSV
    expect(result.items.filter((i) => i.content.startsWith("深度工作"))).toHaveLength(1);
  });
});

describe("parseImportZip: obsidian", () => {
  const result = parseImportZip("obsidian", zipFixture("obsidian"));

  it("imports all vault md files, skipping .obsidian", () => {
    expect(result.items).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });

  it("parses frontmatter tags (inline list) and created", () => {
    const diary = result.items.find((i) => i.content.includes("今天把"))!;
    expect(diary.tags).toEqual(["日记", "复盘"]);
    expect(diary.created_at).toBe("2023-06-01 00:30:00");
  });

  it("parses block-list tags and timezone-aware created", () => {
    const book = result.items.find((i) => i.content.includes("《深度工作》核心观点"))!;
    expect(book.tags).toEqual(["读书", "效率"]);
    expect(book.created_at).toBe("2023-05-20 02:00:00");
    expect(book.url).toBe("https://example.com/deep-work");
  });

  it("keeps wikilinks as plain text and stores image embeds", () => {
    const diary = result.items.find((i) => i.content.includes("今天把"))!;
    expect(diary.content).toContain("读书笔记");
    expect(diary.content).toContain("深度工作");
    expect(diary.content).not.toContain("[[");
    const book = result.items.find((i) => i.content.includes("《深度工作》核心观点"))!;
    expect(book.content).toContain("【图片：示意图.png】");
    expect(book.assets).toHaveLength(1);
  });

  it("falls back to inline #tags and filename title", () => {
    const idea = result.items.find((i) => i.content.includes("随手记一条灵感"))!;
    expect(idea.tags).toEqual(["灵感", "产品"]);
    expect(idea.content.startsWith("灵感速记")).toBe(true);
  });
});

describe("parseImportZip: apple-notes", () => {
  const result = parseImportZip("apple-notes", zipFixture("apple-notes"));

  it("imports md and txt notes", () => {
    expect(result.items).toHaveLength(3);
    expect(result.failures).toEqual([]);
  });

  it("uses frontmatter created/title and notebook folder as tag", () => {
    const meeting = result.items.find((i) => i.content.includes("Q3 排期"))!;
    expect(meeting.created_at).toBe("2023-06-01 06:00:00");
    expect(meeting.tags).toContain("工作");
    expect(meeting.content).toContain("【图片：whiteboard.png】");
    expect(meeting.assets).toHaveLength(1);
  });

  it("reads filename-appended dates (Exporter convention)", () => {
    const list = result.items.find((i) => i.content.includes("咖啡豆"))!;
    expect(list.created_at).toBe("2023-06-01 16:00:00");
    expect(list.tags).toContain("个人");
    expect(list.content.startsWith("# 购物清单") || list.content.startsWith("购物清单")).toBe(true);
  });

  it("imports plain txt notes", () => {
    const excerpt = result.items.find((i) => i.content.includes("专注是这个时代"))!;
    expect(excerpt.created_at).toBeNull();
    expect(excerpt.tags).toContain("个人");
  });
});

describe("zip robustness", () => {
  it("reports invalid zips as a failure, not a crash", () => {
    const result = parseImportZip("notion", new Uint8Array([1, 2, 3, 4]));
    expect(result.items).toEqual([]);
    expect(result.failures[0].reason).toContain("zip");
  });

  it("skips __MACOSX and dotfile cruft", () => {
    const files: Record<string, Uint8Array> = {
      "__MACOSX/x.md": new TextEncoder().encode("junk"),
      "._hidden.md": new TextEncoder().encode("junk"),
      "real.md": new TextEncoder().encode("真实笔记"),
    };
    const entries = unzipEntries(zipSync(files));
    expect(Object.keys(entries)).toEqual(["real.md"]);
  });

  it("handles a large vault (500 notes) without blowing up", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 500; i++) {
      files[`notes/note-${i}.md`] = new TextEncoder().encode(`---\ncreated: 2023-01-01 10:00\n---\n\n第 ${i} 条笔记内容 #批量`);
    }
    const result = parseImportZip("obsidian", zipSync(files));
    expect(result.items).toHaveLength(500);
    expect(result.items[0].created_at).toBe("2023-01-01 02:00:00");
  });
});

describe("parseFrontmatter", () => {
  it("returns body unchanged without frontmatter", () => {
    const fm = parseFrontmatter("no frontmatter here");
    expect(fm.body).toBe("no frontmatter here");
    expect(fm.created).toBeNull();
    expect(fm.tags).toEqual([]);
  });

  it("parses quoted title and comma tags", () => {
    const fm = parseFrontmatter('---\ntitle: "Hello"\ntags: a, b\ncreated: 2023-06-01\n---\nbody');
    expect(fm.title).toBe("Hello");
    expect(fm.tags).toEqual(["a", "b"]);
    expect(fm.created).toBe("2023-05-31 16:00:00");
    expect(fm.body).toBe("body");
  });
});
