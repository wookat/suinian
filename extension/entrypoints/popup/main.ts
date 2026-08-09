import { loadSettings, saveNote, pageContent, selectionContent, CATEGORY_OPTIONS, type Category } from "@/utils/api";
import type { ExtractResult } from "@/entrypoints/extract";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const titleEl = $<HTMLParagraphElement>("page-title");
const urlEl = $<HTMLParagraphElement>("page-url");
const extractStatusEl = $<HTMLParagraphElement>("extract-status");
const selectionBlock = $<HTMLElement>("selection-block");
const selectionPreview = $<HTMLQuoteElement>("selection-preview");
const useSelectionEl = $<HTMLInputElement>("use-selection");
const noteEl = $<HTMLTextAreaElement>("note");
const tagsEl = $<HTMLInputElement>("tags");
const includeExcerptEl = $<HTMLInputElement>("include-excerpt");
const categoryEl = $<HTMLSelectElement>("category");
const saveBtn = $<HTMLButtonElement>("save");
const statusEl = $<HTMLParagraphElement>("status");
const viewLinkEl = $<HTMLParagraphElement>("view-link");
const openWebEl = $<HTMLAnchorElement>("open-web");

for (const opt of CATEGORY_OPTIONS) {
  const o = document.createElement("option");
  o.value = opt.value;
  o.textContent = opt.label;
  categoryEl.appendChild(o);
}

let tab: Browser.tabs.Tab | undefined;
let extract: ExtractResult | null = null;

function setStatus(text: string, kind: "ok" | "error") {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 6);
}

let webBase = "https://suinian.zalize.com";

async function init() {
  const { apiToken, webBaseUrl } = await loadSettings();
  webBase = webBaseUrl;
  if (!apiToken) {
    titleEl.textContent = "还没配置 API";
    extractStatusEl.textContent = "点右上角「设置」填 API 地址与 Token（与 Web 端一致）";
    saveBtn.disabled = true;
    return;
  }
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    titleEl.textContent = "当前页面无法剪藏";
    extractStatusEl.textContent = "仅支持 http/https 页面";
    saveBtn.disabled = true;
    return;
  }
  titleEl.textContent = tab.title ?? tab.url;
  urlEl.textContent = tab.url;
  extractStatusEl.textContent = "正在抽取正文…";
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ["/extract.js"],
    });
    extract = (results[0]?.result as ExtractResult | undefined) ?? null;
  } catch {
    extract = null;
  }
  if (extract?.title) titleEl.textContent = extract.title;
  extractStatusEl.textContent = extract?.excerpt
    ? `已抽取正文 ${extract.excerpt.length} 字`
    : "未能抽取正文（将保存标题 + 链接）";
  if (extract?.selection?.trim()) {
    selectionBlock.hidden = false;
    selectionPreview.textContent = extract.selection.trim().slice(0, 200);
  }
}

saveBtn.addEventListener("click", async () => {
  if (!tab?.url) return;
  saveBtn.disabled = true;
  statusEl.hidden = true;
  try {
    const tags = parseTags(tagsEl.value);
    const note = noteEl.value.trim();
    const useSelection = !selectionBlock.hidden && useSelectionEl.checked && !!extract?.selection?.trim();
    const content = useSelection
      ? (note ? `${note}\n\n` : "") + selectionContent(extract!.selection, extract?.title || tab.title || undefined, tab.url)
      : pageContent({
          note,
          title: extract?.title || tab.title || tab.url,
          url: tab.url,
          excerpt: includeExcerptEl.checked ? extract?.excerpt : undefined,
        });
    const category = (categoryEl.value || undefined) as Category | undefined;
    await saveNote({ content, url: tab.url, tags, category });
    setStatus("✅ 已保存到碎念", "ok");
    viewLinkEl.hidden = false;
    openWebEl.href = `${webBase}/#/`;
    setTimeout(() => window.close(), 4000);
  } catch (e) {
    setStatus(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    saveBtn.disabled = false;
  }
});

$("open-options").addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
});

openWebEl.addEventListener("click", (e) => {
  e.preventDefault();
  void browser.tabs.create({ url: `${webBase}/#/` });
  window.close();
});

void init();
