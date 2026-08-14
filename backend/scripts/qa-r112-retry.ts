/**
 * R112 P2-3 QA：转写重试「成功路径」验证。
 *
 * 注册 [QA-R112] 账号 → 上传真实语音（espeak 合成中文）→ 等转写成功 →
 * 把内容改回失败占位符（模拟一次瞬时转写失败，状态与真实失败完全一致：
 * 占位内容 + R2 已存档原件）→ POST /:id/retry-media → 断言 200 且拿到
 * 真实转写文本 → 注销账号。
 *
 * Usage: npx tsx scripts/qa-r112-retry.ts /path/to/audio.mp3
 */
import { readFileSync } from "node:fs";

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const AUDIO_FAILED_PLACEHOLDER = "【语音】转写失败，稍后可重发";
let token = "";

async function api<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (!init?.raw) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const audioPath = process.argv[2];
  if (!audioPath) throw new Error("usage: qa-r112-retry.ts <audio file>");
  const bytes = readFileSync(audioPath);

  const name = `qa-r112-retry-${Math.random().toString(36).slice(2, 8)}`;
  const reg = await api<{ api_token: string; user: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password: `Qa!${crypto.randomUUID()}` }),
  });
  token = reg.api_token;
  console.log(`registered ${name} (${reg.user.id})`);

  try {
    // 1. upload real speech audio
    const form = new FormData();
    form.set("type", "audio");
    form.set("file", new File([bytes], "qa-r112.mp3", { type: "audio/mpeg" }));
    const up = await api<{ note: { id: string; content: string } }>("/api/ingest/media", {
      method: "POST",
      body: form,
      raw: true,
    });
    const noteId = up.note.id;
    console.log(`uploaded voice note ${noteId}: "${up.note.content.slice(0, 60)}"`);
    if (up.note.content.startsWith(AUDIO_FAILED_PLACEHOLDER)) {
      throw new Error("initial transcription failed — cannot verify success path with this audio");
    }
    const firstTranscript = up.note.content;

    // 2. simulate a transient first-attempt failure: placeholder content +
    //    archived original in R2 == exact state of a real transcription failure
    await api(`/api/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: `${AUDIO_FAILED_PLACEHOLDER} [QA-R112]` }),
    });
    console.log("note reset to failed-placeholder state");
    await sleep(2000);

    // 3. retry — the success path under test
    const retried = await api<{ note: { id: string; content: string } }>(`/api/notes/${noteId}/retry-media`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    console.log(`retry-media -> "${retried.note.content.slice(0, 80)}"`);
    const ok =
      !retried.note.content.startsWith(AUDIO_FAILED_PLACEHOLDER) && retried.note.content.trim().length > 0;
    console.log(`first transcript : ${firstTranscript}`);
    console.log(`retry transcript : ${retried.note.content}`);
    console.log(ok ? "\nRETRY SUCCESS PATH: PASS" : "\nRETRY SUCCESS PATH: FAIL");
    if (!ok) process.exitCode = 1;
  } finally {
    await api("/api/auth/me", { method: "DELETE" });
    console.log("deleted QA account (cascade removed all data)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
