import { describe, it, expect } from "vitest";
import { parseMediaRequest, buildMediaReply, mediaTooLargeMessage, MAX_MEDIA_BYTES } from "../src/media";

function jsonRequest(body: unknown): Request {
  return new Request("http://local/api/ingest/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseMediaRequest", () => {
  it("parses JSON base64 payload", async () => {
    const data = btoa("hello audio");
    const r = await parseMediaRequest(
      jsonRequest({ type: "audio", data_base64: data, mime: "audio/wav", file_name: "a.wav", source: "wechat" })
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.type).toBe("audio");
    expect(r.mime).toBe("audio/wav");
    expect(r.fileName).toBe("a.wav");
    expect(r.source).toBe("wechat");
    expect(new TextDecoder().decode(r.bytes)).toBe("hello audio");
  });

  it("parses multipart form payload", async () => {
    const form = new FormData();
    form.set("type", "image");
    form.set("source", "web");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" }));
    const r = await parseMediaRequest(new Request("http://local/api/ingest/media", { method: "POST", body: form }));
    if ("error" in r) throw new Error(r.error);
    expect(r.type).toBe("image");
    expect(r.mime).toBe("image/png");
    expect(r.fileName).toBe("pic.png");
    expect(r.bytes.length).toBe(3);
  });

  it("rejects missing data and bad type", async () => {
    const noData = await parseMediaRequest(jsonRequest({ type: "audio" }));
    expect("error" in noData && noData.status).toBe(400);
    const badType = await parseMediaRequest(jsonRequest({ type: "video", data_base64: "aGk=" }));
    expect("error" in badType && badType.status).toBe(400);
    const badB64 = await parseMediaRequest(jsonRequest({ type: "audio", data_base64: "!!!" }));
    expect("error" in badB64 && badB64.status).toBe(400);
  });

  it("rejects oversized base64 payloads before decoding", async () => {
    const huge = "A".repeat(Math.ceil((MAX_MEDIA_BYTES + 1024) / 0.75));
    const r = await parseMediaRequest(jsonRequest({ type: "audio", data_base64: huge }));
    expect("error" in r && r.status).toBe(413);
  });
});

describe("buildMediaReply", () => {
  it("includes label and first 30 chars", () => {
    expect(buildMediaReply("audio", "今天想到一个点子", true)).toBe("已记录（语音转写）：今天想到一个点子");
    expect(buildMediaReply("image", "会议纪要", true)).toBe("已记录（图片识别）：会议纪要");
  });

  it("truncates long text with ellipsis", () => {
    const long = "字".repeat(50);
    const reply = buildMediaReply("audio", long, true);
    expect(reply).toBe(`已记录（语音转写）：${"字".repeat(30)}…`);
  });

  it("collapses whitespace in the preview", () => {
    expect(buildMediaReply("image", "第一行\n第二行", true)).toBe("已记录（图片识别）：第一行 第二行");
  });

  it("failure reply mentions placeholder", () => {
    expect(buildMediaReply("audio", "whatever", false)).toContain("语音转写失败");
    expect(buildMediaReply("image", "whatever", false)).toContain("图片识别失败");
  });
});

describe("mediaTooLargeMessage", () => {
  it("mentions the 10MB limit", () => {
    expect(mediaTooLargeMessage(12 * 1024 * 1024)).toContain("10MB");
  });
});
