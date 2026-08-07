import { Readability } from "@mozilla/readability";

export interface ExtractResult {
  title: string;
  url: string;
  selection: string;
  excerpt: string;
  siteName: string;
}

/**
 * Injected on demand (scripting.executeScript) to pull the page's readable
 * article text via Readability plus the current text selection.
 */
export default defineUnlistedScript((): ExtractResult => {
  const selection = window.getSelection()?.toString() ?? "";
  let excerpt = "";
  let siteName = "";
  let title = document.title;
  try {
    const clone = document.cloneNode(true) as Document;
    const article = new Readability(clone).parse();
    if (article) {
      excerpt = (article.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
      siteName = article.siteName ?? "";
      if (article.title) title = article.title;
    }
  } catch {
    /* extraction failure is non-fatal: title + URL still get saved */
  }
  return { title, url: location.href, selection, excerpt, siteName };
});
