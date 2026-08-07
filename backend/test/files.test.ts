import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  detectFileKind,
  extractDocxText,
  extractFileText,
  buildFileNote,
  buildFileReply,
  FILE_DIRECT_CHARS,
  FILE_FAILED_PLACEHOLDER,
} from "../src/files";
import { parseMediaRequest } from "../src/media";

describe("detectFileKind", () => {
  it("detects by extension first", () => {
    expect(detectFileKind("报告.pdf", "application/octet-stream")).toBe("pdf");
    expect(detectFileKind("notes.TXT", "application/octet-stream")).toBe("txt");
    expect(detectFileKind("readme.md", "")).toBe("md");
    expect(detectFileKind("doc.docx", "")).toBe("docx");
  });
  it("falls back to mime", () => {
    expect(detectFileKind(undefined, "application/pdf")).toBe("pdf");
    expect(detectFileKind("noext", "text/plain; charset=utf-8")).toBe("txt");
    expect(
      detectFileKind(undefined, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    ).toBe("docx");
  });
  it("returns null for unsupported types", () => {
    expect(detectFileKind("a.exe", "application/octet-stream")).toBeNull();
    expect(detectFileKind("a.doc", "application/msword")).toBeNull();
    expect(detectFileKind(undefined, "video/mp4")).toBeNull();
  });
});

function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

describe("extractDocxText", () => {
  it("extracts paragraphs joined by newlines", () => {
    const bytes = makeDocx(["第一段：碎念文件入库", "Second paragraph"]);
    expect(extractDocxText(bytes)).toBe("第一段：碎念文件入库\nSecond paragraph");
  });
  it("decodes xml entities", () => {
    const bytes = makeDocx(["A &amp; B &lt;C&gt;"]);
    expect(extractDocxText(bytes)).toBe("A & B <C>");
  });
  it("returns null for non-zip bytes", () => {
    expect(extractDocxText(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it("returns null when document.xml is missing", () => {
    const bytes = zipSync({ "other.txt": strToU8("hi") });
    expect(extractDocxText(bytes)).toBeNull();
  });
});

describe("extractFileText", () => {
  it("reads txt/md directly as utf-8", async () => {
    const bytes = new TextEncoder().encode("你好，碎念\nline2");
    expect(await extractFileText("txt", bytes)).toBe("你好，碎念\nline2");
    expect(await extractFileText("md", bytes)).toBe("你好，碎念\nline2");
  });
  it("returns null for empty text", async () => {
    expect(await extractFileText("txt", new TextEncoder().encode("   \n "))).toBeNull();
  });
});

const noAiEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "" };

describe("buildFileNote", () => {
  it("stores short text directly as content", async () => {
    const bytes = new TextEncoder().encode("短文本内容");
    const res = await buildFileNote(noAiEnv, "txt", "a.txt", bytes);
    expect(res).toEqual({ content: "短文本内容", excerpt: null, summarized: false, extracted: true });
  });
  it("keeps an excerpt and truncated content for long text when AI is unavailable", async () => {
    const long = "长".repeat(FILE_DIRECT_CHARS + 500);
    const res = await buildFileNote(noAiEnv, "txt", "long.txt", new TextEncoder().encode(long));
    expect(res.extracted).toBe(true);
    expect(res.summarized).toBe(false);
    expect(res.excerpt).toBe(long.slice(0, 6000));
    expect(res.content.length).toBeLessThanOrEqual(FILE_DIRECT_CHARS * 2);
  });
  it("falls back to a placeholder when extraction fails", async () => {
    const res = await buildFileNote(noAiEnv, "docx", "bad.docx", new Uint8Array([9, 9]));
    expect(res.extracted).toBe(false);
    expect(res.content).toBe(`${FILE_FAILED_PLACEHOLDER}：bad.docx`);
  });
});

describe("buildFileReply", () => {
  it("includes file name and a one-line summary head", () => {
    const reply = buildFileReply("报告.pdf", "【报告.pdf】这份报告讨论了季度营收与增长策略。", true);
    expect(reply.startsWith("已存档：报告.pdf · 这份报告")).toBe(true);
  });
  it("reports archive-only when extraction failed", () => {
    expect(buildFileReply("x.pdf", "whatever", false)).toContain("文本提取失败");
  });
  it("truncates long summaries", () => {
    const reply = buildFileReply("a.txt", "字".repeat(100), true);
    expect(reply.endsWith("…")).toBe(true);
  });
});

describe("parseMediaRequest type=file", () => {
  it("accepts type=file via JSON base64", async () => {
    const data = btoa("hello");
    const req = new Request("http://x/api/ingest/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "file", data_base64: data, mime: "text/plain", file_name: "a.txt" }),
    });
    const parsed = await parseMediaRequest(req);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.type).toBe("file");
      expect(parsed.fileName).toBe("a.txt");
      expect(new TextDecoder().decode(parsed.bytes)).toBe("hello");
    }
  });
  it("rejects unknown types", async () => {
    const req = new Request("http://x/api/ingest/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "video", data_base64: btoa("x") }),
    });
    const parsed = await parseMediaRequest(req);
    expect(parsed).toMatchObject({ status: 400 });
  });
});
