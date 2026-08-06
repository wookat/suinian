# 碎念 Suinian — Web 端

响应式 Web 查看端（React 19 + Vite + TypeScript + Tailwind CSS v4 + shadcn/ui 风格组件，PWA）。

线上地址：https://suinian.zalize.com

## 功能

- **时间流首页**：顶部速记输入框（回车即存），笔记卡片流（分类角标 想法/待办/收藏/资料、标签、链接卡片 url_title/url_summary、来源与时间）
- **筛选**：分类 tab（全部/想法/待办/收藏/资料）+ 标签筛选 + 关键词搜索
- **问答模式**：搜索框旁「问答」开关，调 `POST /api/ask`，展示回答与引用笔记
- **待办视图**：未完成/已完成分组，勾选完成（`PATCH /api/notes/:id`）
- **设置页**：API Base URL + Token（存 localStorage），演示模式（Mock）/ 真实 API 一键切换
- **线索视图**：思考线索列表 + 线索详情（线索标题/摘要 + 归属碎片时间线）
- **周报视图**：周报列表 + Markdown 渲染详情，可手动触发生成
- **PWA**：manifest + service worker（vite-plugin-pwa `prompt` 更新模式——检测到新版本时页内提示，用户确认后刷新），可安装到手机/桌面
- **深浅色**：跟随系统 `prefers-color-scheme` 自动切换

## 数据层

`src/lib/api.ts` 按 `docs/SPEC.md` 的接口约定封装：

- `GET /api/notes?category=&tag=&q=&cursor=`
- `POST /api/notes` `{source, raw_type, content, url?}`
- `PATCH /api/notes/:id`（勾选待办等）/ `DELETE /api/notes/:id`
- `POST /api/ask` `{question}` → `{answer, references}`
- `GET /api/threads` / `GET /api/threads/:id`（线索）
- `GET /api/reports` / `GET /api/reports/:id`（周报）

后端未就绪时使用 `src/lib/mock.ts` 的本地 Mock 数据层（localStorage 持久化），
设置页可随时切换 Mock / 真实 API。字段形状与 SPEC 严格一致。

## 开发

```bash
npm install
npm run dev        # 本地开发
npm run lint       # oxlint
npm run build      # tsc -b && vite build（含 typecheck）
```

## 部署

Cloudflare Pages（构建输出 `dist/`），域名 `suinian.zalize.com`：

```bash
npm run build
npx wrangler pages deploy dist --project-name suinian
```

## 目录结构

```
src/
  lib/        types.ts（SPEC 数据模型）、api.ts（真实 API）、mock.ts、settings.ts
  components/ ui/（button/badge/input/textarea/card）、note-card、quick-input
  pages/      timeline、todos、threads、reports、settings
  App.tsx     响应式外壳：桌面侧边栏 + 移动端底部导航（hash 路由）
```
