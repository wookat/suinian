import { describe, it, expect } from "vitest";
import {
  parseMediaRequest,
  buildMediaReply,
  mediaTooLargeMessage,
  MAX_MEDIA_BYTES,
  correctTranscript,
  stripMarkdown,
  parseImageExtraction,
  imageNoteFields,
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

  // R418：以下夹具均为 2026-09-10 本机 wrangler dev 经真实 Workers AI
  // llama-3.2-11b-vision 对空白 / 全黑 / 纯色图片的原样输出（temperature 0.1，两次一致）
  it("R418 空白图整段输出被代码围栏包住的「[无]」不是正文", () => {
    const r = parseImageExtraction("```\n[无]\n```");
    expect(r.degenerate).toBeUndefined();
    expect(r.content).toBe("（图片，未识别出文字内容）");
    expect(r.description).toBe("");
  });

  it("R418 同词循环「1.  1.  1. …」判退化，不入正文", () => {
    const r = parseImageExtraction("文字：\n```\n" + "1.  ".repeat(130));
    expect(r.degenerate).toBe(true);
    expect(r.content).toBe("");
    expect(r.sensitive).toBe(false);
  });

  it("R418 逐行递增编号「1. 1 / 2. 2 / …」（无一行含字）判退化", () => {
    const body = Array.from({ length: 48 }, (_, i) => `${i + 1}. ${i + 1}`).join("\n");
    const r = parseImageExtraction("文字：\n```\n" + body + "\n4");
    expect(r.degenerate).toBe(true);
  });

  it("R418 同一时间戳整行重复到截断判退化", () => {
    const r = parseImageExtraction("文字：\n```\n" + "[2022-12-31 10:00:00] 2022年12月31日 10:00:00\n".repeat(17) + "[2022-12-31 10:00:00] ");
    expect(r.degenerate).toBe(true);
  });

  it("R418 无「文字：」标签的整段循环同样判退化", () => {
    const r = parseImageExtraction("```\n" + "好的 ".repeat(40));
    expect(r.degenerate).toBe(true);
  });

  it("R418 代码围栏行被剥掉，围栏内的真实文字照常入正文", () => {
    const r = parseImageExtraction("文字：\n```\n星巴克 中关村店\n合计 50.00\n```\n描述：收据。\n敏感：否\n清晰：是");
    expect(r.degenerate).toBeUndefined();
    expect(r.content).toBe("星巴克 中关村店\n合计 50.00");
    expect(r.suspect).toBe(false);
  });

  it("R418 文字段之后三段全缺（max_tokens 截断）的长文字按存疑标记但仍入库", () => {
    const long = Array.from({ length: 12 }, (_, i) => `第${i + 1}条 交付节奏与并行项目数量需要在下季度前收敛`).join("\n");
    const r = parseImageExtraction("文字：\n" + long);
    expect(r.degenerate).toBeUndefined();
    expect(r.content).toBe(long);
    expect(r.suspect).toBe(true);
  });

  it("R418 只输出文字段的短文字不算截断、不标存疑", () => {
    const r = parseImageExtraction("文字：会议室 302");
    expect(r.content).toBe("会议室 302");
    expect(r.suspect).toBe(false);
  });

  it("R418 真实收据 / 白板 / 纯数字合计行不误判", () => {
    const receipt = parseImageExtraction("文字：\n星巴克 中关村店\n美式咖啡 大杯 32.00\n可饮 18.00\n合计 50.00\n2026-09-08 14:32\n\n描述：\n收据。\n\n敏感：\n否\n\n清晰：\n是");
    expect(receipt.degenerate).toBeUndefined();
    expect(receipt.content).toContain("合计 50.00");
    const board = parseImageExtraction("文字：会议记录 9/8\n1. Q3 复盘下周三前发出\n2. 新区产业园进址：先看交通\n3. 下季度减少开行项目\n\n描述：会议记录。\n\n敏感：否\n\n清晰：是");
    expect(board.degenerate).toBeUndefined();
    expect(board.suspect).toBe(false);
    const digits = parseImageExtraction("文字：\n32.00\n18.00\n50.00\n12.00\n8.50\n9.50\n120.00\n\n描述：手写金额列。\n敏感：否\n清晰：是");
    expect(digits.degenerate).toBeUndefined();
    expect(digits.content).toBe("32.00\n18.00\n50.00\n12.00\n8.50\n9.50\n120.00");
    const list = parseImageExtraction("文字：\n1. 买菜\n2. 交房租\n3. 打电话\n4. 复盘\n5. 备份\n6. 体检\n\n描述：待办清单。\n敏感：否\n清晰：是");
    expect(list.degenerate).toBeUndefined();
  });

  // R419：以下夹具为 2026-09-10 本机经真实 Workers AI 对「图中文字含以敏 / 描 / 清开头的行」
  // 的原样输出（每图 5 次一致）：模型把该行认成自己的段标签提前跳段，后面的文字丢失
  it("R419 段标签在却什么都没抄出来：不拿段标签当正文、不当「无文字」，按抽取失败", () => {
    // 图：「敏感信息处理规范（草案）/ 什么算敏感信息 / 谁负责审批」，修前正文落「敏感：否」
    for (const raw of ["文字：\n敏感：否\n清晰：是", "文字：\n敏感：\n清晰：是", "文字：\n敏感：是\n清晰：是"]) {
      const r = parseImageExtraction(raw);
      expect(r.malformed).toBe(true);
      expect(r.content).toBe("");
      expect(r.sensitive).toBe(false);
    }
  });

  it("R419 文字段以「xx：」收尾、敏感段空值：抄出的部分仍入库但标存疑", () => {
    // 图：「翻译练习 / 原文：The quick brown fox / 译文：敏捷的棕色狐狸 / 文字风格：口语」
    const r = parseImageExtraction("文字：\nThe quick brown fox\n译文：\n敏感：\n清晰：是");
    expect(r.malformed).toBeUndefined();
    expect(r.content).toBe("The quick brown fox\n译文：");
    expect(r.suspect).toBe(true);
    expect(r.sensitive).toBe(false);
  });

  it("R419 描述段缺失时描述留空，不把带段标签的整段输出当描述", () => {
    // 图：报修单，模型跳过描述段（图中有「问题描述：」行）
    const raw = "文字：\nNo.20260909\n问题描述：厨房水管漏水\n联系人：壹女士\n预约时间：9月10日上午\n\n敏感：否\n\n清晰：是";
    const r = parseImageExtraction(raw);
    expect(r.content).toBe("No.20260909\n问题描述：厨房水管漏水\n联系人：壹女士\n预约时间：9月10日上午");
    expect(r.description).toBe("");
    expect(r.suspect).toBe(false);
    expect(imageNoteFields(r).meta?.image_description).toBeUndefined();
  });

  it("R419 正常四段输出不误标存疑；「文字：无」无描述也不算脱轨", () => {
    const ok = parseImageExtraction("文字：\n今天要做\n1. 去银行办储蓄卡\n\n描述：\n清单。\n\n敏感：\n否\n\n清晰：\n是");
    expect(ok.suspect).toBe(false);
    expect(ok.content).toBe("今天要做\n1. 去银行办储蓄卡");
    const none = parseImageExtraction("文字：无\n敏感：否\n清晰：是");
    expect(none.malformed).toBeUndefined();
    expect(none.content).toBe("（图片，未识别出文字内容）");
    expect(none.suspect).toBe(false);
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

  it("R418 退化循环输出按抽取失败返回 null（调用方落失败占位 + 原地重试）", async () => {
    const env = aiEnv("文字：\n```\n" + "1.  ".repeat(130));
    expect(await describeImage(env, new Uint8Array([1]))).toBeNull();
  });

  it("R419 只有段标签没有内容的输出按抽取失败返回 null", async () => {
    const env = aiEnv("文字：\n敏感：否\n清晰：是");
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
