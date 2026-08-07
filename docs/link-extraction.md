# 链接抓取：支持范围与已知限制

链接笔记的标题/正文/摘要抓取由 worker 内两级流程完成：

1. **fetchLinkMeta**（同步，入库时）：抓 `<title>`/meta description。标题解析顺序：`<title>` → `og:title` → `twitter:title` → 微信页面的 `var msg_title`。
2. **enrichLinkInto**（异步 + cron 补抓）：Readability 抽正文（微信页面优先读 `#js_content` / `.rich_media_content` 容器）→ AI 生成 80-120 字摘要与标签。

两级均使用浏览器 UA（Chrome/126）与 `zh-CN` accept-language；明显的 bot UA 会被微信等站点返回空 meta 或拦截页。

## 实测结论（2026-08-07，Cloudflare Workers 线上环境）

| 来源 | 结果 | 说明 |
|---|---|---|
| 微信公众号 mp.weixin.qq.com | ✅ 可抓 | 页面 `<title>` 为空，标题在 `og:title`；正文在 `#js_content`（隐藏容器但服务端返回）。R29 起标题/正文/AI 摘要均正常 |
| 少数派 sspai.com | ✅ 可抓 | 文章标题+正文+摘要正常（R28 报只抓到站点名，R29 已修） |
| 阮一峰博客等常规站点 | ✅ 可抓 | Readability 通用路径 |
| 失效/被删的公众号链接 | ⚠️ 兜底 | 返回「参数错误」等拦截标题，被 `isBlockedTitle` 过滤，卡片落入失败兜底态（hostname 标题 + 重试按钮） |
| 需登录/验证码站点（知乎部分页、Cloudflare 盾站） | ❌ 不可抓 | 拦截页标题被过滤，走失败兜底 |
| 非 HTML 链接（PDF、图片直链） | ❌ 不抓 | content-type 非 html 直接跳过，保留链接本身 |

## 兜底行为

抓取失败（`fetch_failed`）或无正文（`no_content`）时：笔记保留原链接，卡片显示 hostname 作为标题、「未能抓取正文，已保存链接」提示与「重试抓取」按钮（`POST /api/notes/:id/refetch-link`）。cron 每 10 分钟对未尝试过的链接补抓（每轮最多 3 条）。
