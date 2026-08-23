import DOMPurify from "dompurify"

// R266 P0 外链零输出（docs/decision-r266.md）：模型生成的 markdown（周/月报叙述）
// 渲染成 HTML 时，除自有域名外的一切链接降级为纯文本、图片一律不渲染——笔记内容
// 派生的第三方 URL 既不可点击也不会被自动加载（零点击回传通道）。服务端已在生成
// 侧收口，这里是渲染侧的第二道同口径护栏（CSP 是第三道）。
export const HTML_LINK_ALLOWED_HOSTS = ["suinian.zalize.com", "suinian-api.zalize.com", "zalize.com"]

export const LINK_REMOVED_MARK = "〔已移除外部链接〕"

function hostAllowed(href: string): boolean {
  try {
    const u = new URL(href, location.origin)
    if (u.origin === location.origin) return true
    if (u.protocol !== "https:" && u.protocol !== "http:") return false
    const host = u.hostname.toLowerCase()
    return HTML_LINK_ALLOWED_HOSTS.some((a) => host === a || host.endsWith(`.${a}`))
  } catch {
    return false
  }
}

let hookInstalled = false

function installHook() {
  if (hookInstalled) return
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return
    if (node.tagName === "A") {
      const href = node.getAttribute("href")
      if (href && !hostAllowed(href)) {
        node.removeAttribute("href")
        node.setAttribute("data-link-removed", "true")
        node.textContent = `${node.textContent ?? ""}（${LINK_REMOVED_MARK}）`.trim()
      } else if (href) {
        node.setAttribute("rel", "noreferrer noopener")
        node.setAttribute("target", "_blank")
      }
    }
  })
  hookInstalled = true
}

/** 白名单化的 markdown → HTML 净化：脚本/事件属性由 DOMPurify 移除，图片标签整体
 * 禁止（避免零点击加载），外链锚点降级为纯文本。 */
export function sanitizeGeneratedHtml(html: string): string {
  installHook()
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "picture", "source", "svg", "iframe", "object", "embed", "video", "audio", "form", "input"],
    FORBID_ATTR: ["srcset", "background", "formaction", "poster"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  })
}
