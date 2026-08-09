import { DEFAULT_API_BASE, DEFAULT_WEB_BASE, loadSettings, saveSettings, testConnection } from "@/utils/api";

const baseEl = document.getElementById("api-base") as HTMLInputElement;
const tokenEl = document.getElementById("api-token") as HTMLInputElement;
const webBaseEl = document.getElementById("web-base") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

function setStatus(text: string, kind: "ok" | "error") {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function init() {
  const s = await loadSettings();
  baseEl.value = s.apiBaseUrl;
  tokenEl.value = s.apiToken;
  webBaseEl.value = s.webBaseUrl;
}

function currentSettings() {
  return {
    apiBaseUrl: baseEl.value.trim() || DEFAULT_API_BASE,
    apiToken: tokenEl.value.trim(),
    webBaseUrl: webBaseEl.value.trim() || DEFAULT_WEB_BASE,
  };
}

document.getElementById("save")!.addEventListener("click", async () => {
  await saveSettings(currentSettings());
  setStatus("已保存", "ok");
});

document.getElementById("test")!.addEventListener("click", async () => {
  await saveSettings(currentSettings());
  setStatus("测试中…", "ok");
  const r = await testConnection();
  setStatus(r.message, r.ok ? "ok" : "error");
});

void init();
