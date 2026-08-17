import { saveNote, findDuplicateNote, selectionContent, pageContent, loadSettings } from "@/utils/api";
import type { ExtractResult } from "@/entrypoints/extract";

const MENU_SAVE_SELECTION = "suinian-save-selection";
const MENU_SAVE_PAGE = "suinian-save-page";

const SAVED_NOTIFICATION_PREFIX = "suinian-saved-";

function notify(title: string, message: string, opts?: { openWebOnClick?: boolean }) {
  const options = {
    type: "basic" as const,
    iconUrl: browser.runtime.getURL("/icon/128.png"),
    title,
    message: opts?.openWebOnClick ? `${message}\n点击打开碎念查看` : message,
  };
  if (opts?.openWebOnClick) void browser.notifications.create(`${SAVED_NOTIFICATION_PREFIX}${Date.now()}`, options);
  else void browser.notifications.create(options);
}

async function runExtract(tabId: number): Promise<ExtractResult | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      files: ["/extract.js"],
    });
    return (results[0]?.result as ExtractResult | undefined) ?? null;
  } catch {
    // pages we can't inject into (chrome://, web store, PDFs)
    return null;
  }
}

async function saveSelection(tab: { id?: number; url?: string; title?: string }, fallbackText?: string) {
  try {
    let selection = fallbackText ?? "";
    if (!selection && tab.id != null) {
      const r = await runExtract(tab.id);
      selection = r?.selection ?? "";
    }
    if (!selection.trim()) {
      notify("碎念剪藏", "没有选中的文字：请先在页面上选中一段文字再保存");
      return;
    }
    if (!tab.url) {
      notify("碎念剪藏", "无法获取页面地址");
      return;
    }
    const content = selectionContent(selection, tab.title, tab.url);
    if (await findDuplicateNote(tab.url, content)) {
      notify("碎念剪藏", `这段内容已剪藏过，本次未重复保存`, { openWebOnClick: true });
      return;
    }
    await saveNote({ content, url: tab.url });
    notify("已保存到碎念", `划词内容已保存：${selection.trim().slice(0, 50)}`, { openWebOnClick: true });
  } catch (e) {
    notify("保存失败", e instanceof Error ? e.message : String(e));
  }
}

async function savePage(tab: { id?: number; url?: string; title?: string }) {
  try {
    if (!tab.url || !/^https?:/.test(tab.url)) {
      notify("碎念剪藏", "当前页面无法剪藏（仅支持 http/https 页面）");
      return;
    }
    const r = tab.id != null ? await runExtract(tab.id) : null;
    const content = pageContent({ title: r?.title || tab.title || tab.url, url: tab.url, excerpt: r?.excerpt });
    if (await findDuplicateNote(tab.url, content)) {
      notify("碎念剪藏", `该页面已剪藏过：${r?.title || tab.title || tab.url}`, { openWebOnClick: true });
      return;
    }
    await saveNote({ content, url: tab.url });
    notify("已保存到碎念", `已剪藏：${r?.title || tab.title || tab.url}`, { openWebOnClick: true });
  } catch (e) {
    notify("保存失败", e instanceof Error ? e.message : String(e));
  }
}

export default defineBackground(() => {
  browser.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith(SAVED_NOTIFICATION_PREFIX)) return;
    const { webBaseUrl } = await loadSettings();
    void browser.tabs.create({ url: `${webBaseUrl}/#/` });
    void browser.notifications.clear(id);
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_SAVE_SELECTION,
      title: "保存划词到碎念",
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: "保存当前页到碎念",
      contexts: ["page"],
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab) return;
    if (info.menuItemId === MENU_SAVE_SELECTION) void saveSelection(tab, info.selectionText);
    else if (info.menuItemId === MENU_SAVE_PAGE) void savePage(tab);
  });

  browser.commands.onCommand.addListener(async (command) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (command === "save-selection") void saveSelection(tab);
    else if (command === "save-page") void savePage(tab);
  });
});
