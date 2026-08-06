# 碎念 Suinian

**什么都能丢的 AI 收件箱**：你只管往微信里丢（想法、链接、待办、密码、文件），AI 帮你分拣、串线索、随时找到；每周告诉你"你最近在想什么"。

## 产品形态
- **入口**：微信 ClawBot 联系人（主）、Android 分享菜单/小组件、Web 速记框
- **AI 消化**：自动分拣（想法/待办/收藏/资料）、自动标签、链接抓取摘要、语音转写、图片 OCR、敏感信息加密
- **思考线索**（灵魂功能）：把分散数周的同题碎片自动串成线索，可"长"成结构化文档
- **检索**：微信里自然语言问答 + Web 端时间流/线索/标签/全文搜索
- **周报**：每周一微信推送本周思考报告
- **开源自部署 + 托管版**

## Monorepo 结构
- `backend/` — Cloudflare Workers + D1 + KV：notes API、DeepSeek 分拣管线、ClawBot/iLink 接入、周报
- `web/` — 响应式 Web 端（React + Tailwind + shadcn/ui，PWA）：时间流/线索/周报视图
- `skill/` — OpenClaw skill 打包（ClawHub 发布）
- `android/` — Kotlin + Jetpack Compose：分享接收、小组件、查看端
- `docs/` — SPEC、产品方案、竞品调研

## 文档
- [产品方案](docs/product-plan.md)
- [竞品调研](docs/research-competitors.md)
- [技术 SPEC](docs/SPEC.md)
