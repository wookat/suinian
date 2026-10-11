import { describe, it, expect } from "vitest";
import {
  parseMediaRequest,
  buildMediaReply,
  mediaTooLargeMessage,
  MAX_MEDIA_BYTES,
  correctTranscript,
  stripMarkdown,
  parseImageExtraction,
  describeImage,
  withTimeout,
  resolveAttachmentMime,
  attachmentDisplayName,
} from "../src/media";

/** Minimal Workers-AI-style env whose chat model returns `response`. */
function aiEnv(response: string | (() => Promise<{ response?: string }>)) {
  const run = typeof response === "function" ? response : async () => ({ response });
  return {
    AI: { run } as unknown as Ai,
    AI_MODEL: "workers-ai:test-model",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
  };
}

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

describe("resolveAttachmentMime", () => {
  it("keeps an explicit non-generic mime", () => {
    expect(resolveAttachmentMime("audio/mp4", "a.mp3", "audio")).toBe("audio/mp4");
    expect(resolveAttachmentMime("image/png", undefined, "image")).toBe("image/png");
  });

  it("infers from extension when mime is missing or octet-stream", () => {
    expect(resolveAttachmentMime("", "rec.m4a", "audio")).toBe("audio/mp4");
    expect(resolveAttachmentMime("application/octet-stream", "voice.AMR", "audio")).toBe("audio/amr");
    expect(resolveAttachmentMime(undefined, "pic.JPG", "image")).toBe("image/jpeg");
    expect(resolveAttachmentMime(null, "doc.pdf", "file")).toBe("application/pdf");
  });

  it("resolves ambiguous webm by media type", () => {
    expect(resolveAttachmentMime("", "rec.webm", "audio")).toBe("audio/webm");
    expect(resolveAttachmentMime("", "clip.webm", "file")).toBe("video/webm");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(resolveAttachmentMime("", "data.xyz", "file")).toBe("application/octet-stream");
    expect(resolveAttachmentMime("application/octet-stream", undefined, "audio")).toBe("application/octet-stream");
  });
});

describe("attachmentDisplayName", () => {
  const key = (safeName: string) => `media/u_1/n_1/1757000000000-${safeName}`;

  it("strips the storeOriginal timestamp and keeps a named file as is", () => {
    expect(attachmentDisplayName(key("voice-20260908-1000.m4a"), "audio/mp4")).toBe("voice-20260908-1000.m4a");
    expect(attachmentDisplayName(key("白板 会议纪要.png"), "image/png")).toBe("白板 会议纪要.png");
    expect(attachmentDisplayName(key("rec.webm"), "audio/webm")).toBe("rec.webm");
  });

  it("appends an extension from the mime when the stored name has none (WeChat / JSON ingest)", () => {
    expect(attachmentDisplayName(key("audio"), "audio/amr")).toBe("audio.amr");
    expect(attachmentDisplayName(key("audio"), "audio/mp4")).toBe("audio.m4a");
    expect(attachmentDisplayName(key("audio"), "audio/ogg; codecs=opus")).toBe("audio.ogg");
    expect(attachmentDisplayName(key("audio"), "audio/webm")).toBe("audio.webm");
    expect(attachmentDisplayName(key("image"), "image/jpeg")).toBe("image.jpg");
    expect(attachmentDisplayName(key("image"), "IMAGE/PNG")).toBe("image.png");
  });

  it("leaves the bare name when the mime is unknown or missing", () => {
    expect(attachmentDisplayName(key("audio"), null)).toBe("audio");
    expect(attachmentDisplayName(key("file"), "application/octet-stream")).toBe("file");
    expect(attachmentDisplayName(key("blob"), "application/x-unknown")).toBe("blob");
  });

  it("only strips a Date.now()-sized prefix, not a leading number that is part of the name", () => {
    expect(attachmentDisplayName(key("2024-report.pdf"), "application/pdf")).toBe("2024-report.pdf");
    expect(attachmentDisplayName("media/u_1/n_1/", "audio/amr")).toBe("file.amr");
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

describe("correctTranscript", () => {
  it("returns the corrected text from the LLM", async () => {
    const env = aiEnv("可信\n明天去牙医那里复诊");
    expect(await correctTranscript(env, "明天去牙医那里复枕")).toEqual({ text: "明天去牙医那里复诊", suspect: false });
  });

  it("parses the 存疑 self-assessment flag (R212 P2-1)", async () => {
    const env = aiEnv("存疑\n提醒我带伞，天气预报说有大雨");
    expect(await correctTranscript(env, "提醒我们天气预报说有五十点的降雨量被李总打电话")).toEqual({
      text: "提醒我带伞，天气预报说有大雨",
      suspect: true,
    });
  });

  it("fail-open：模型不按两行格式输出时按可信处理", async () => {
    const env = aiEnv("明天去牙医那里复诊");
    expect(await correctTranscript(env, "明天去牙医那里复枕")).toEqual({ text: "明天去牙医那里复诊", suspect: false });
  });

  it("falls back to the raw transcript when the LLM fails", async () => {
    const env = aiEnv(async () => {
      throw new Error("provider down");
    });
    expect(await correctTranscript(env, "原始转写")).toEqual({ text: "原始转写", suspect: false });
  });

  it("falls back to the raw transcript when the LLM returns empty", async () => {
    expect(await correctTranscript(aiEnv(""), "原始转写")).toEqual({ text: "原始转写", suspect: false });
  });
});

describe("stripMarkdown", () => {
  it("removes asterisks and heading markers", () => {
    expect(stripMarkdown("**加粗** 和 *斜体*\n## 标题")).toBe("加粗 和 斜体\n标题");
  });
});

describe("parseImageExtraction", () => {
  it("uses extracted text as content and keeps the description", () => {
    const r = parseImageExtraction("文字：会议纪要 8月7日\n描述：一张白板照片，上面写着会议纪要。");
    expect(r.content).toBe("会议纪要 8月7日");
    expect(r.description).toBe("一张白板照片，上面写着会议纪要。");
  });

  it("falls back to a one-sentence description when the image has no text", () => {
    const r = parseImageExtraction("文字：无\n描述：一只橘猫趴在沙发上晒太阳。旁边有一个抱枕。");
    expect(r.content).toBe("一只橘猫趴在沙发上晒太阳。");
    expect(r.description).toBe("一只橘猫趴在沙发上晒太阳。旁边有一个抱枕。");
  });

  it("strips markdown stars from the output", () => {
    const r = parseImageExtraction("文字：**重要通知**\n描述：*一张公告截图*");
    expect(r.content).toBe("重要通知");
    expect(r.description).toBe("一张公告截图");
  });

  it("handles unstructured output by treating it all as description", () => {
    const r = parseImageExtraction("一张风景照，远处有山。");
    expect(r.content).toBe("一张风景照，远处有山。");
    expect(r.description).toBe("一张风景照，远处有山。");
  });
});

describe("describeImage", () => {
  it("returns parsed extraction from the vision model", async () => {
    const env = aiEnv("文字：Wi-Fi: guest2024\n描述：前台密码提示牌。");
    const r = await describeImage(env, new Uint8Array([1]));
    expect(r?.content).toBe("Wi-Fi: guest2024");
    expect(r?.description).toBe("前台密码提示牌。");
  });

  it("returns null when the model fails", async () => {
    const env = aiEnv(async () => {
      throw new Error("vision down");
    });
    expect(await describeImage(env, new Uint8Array([1]))).toBeNull();
  });
});

describe("withTimeout", () => {
  it("rejects when the promise outlives the timeout", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "test")).rejects.toThrow("timed out");
  });

  it("resolves normally when fast enough", async () => {
    await expect(withTimeout(Promise.resolve(42), 100, "test")).resolves.toBe(42);
  });
});
