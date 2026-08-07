# 贡献指南

感谢关注碎念！欢迎 Issue 与 PR。

## 提 Issue

- Bug 用 [Bug 报告模板](https://github.com/wookat/suinian/issues/new?template=bug_report.yml)，附复现步骤与环境信息
- 功能建议用 [功能建议模板](https://github.com/wookat/suinian/issues/new?template=feature_request.yml)

## 提 PR

1. Fork 并从 `main` 切分支
2. 保持改动聚焦：一个 PR 只做一件事
3. 提交前跑通对应子项目的检查：

| 子项目 | 命令 |
|---|---|
| `backend/` | `npm test && npm run typecheck` |
| `web/` | `npm run lint && npm run build` |
| `skill/bridge/` | `npm test && npm run lint` |
| `android/` | `./gradlew assembleDebug` |

4. PR 描述里说明动机与改动点；界面改动请附截图
5. PR 会自动跑 CI（backend 测试+typecheck、web lint+build、extension/mcp typecheck+build），合并前需全绿

## 本地起服务（无 Cloudflare 资源、无 API key 也能跑）

```bash
# 后端：本地 D1 + 内置 mock AI
cd backend && npm install
cp .dev.vars.example .dev.vars   # 默认 AI_MODEL=mock
npm run dev:init                 # 本地 D1 建表
npm run dev                      # http://127.0.0.1:8787

# Web 端（另开终端）
cd web && npm install
cp .env.example .env.local       # VITE_API_BASE 指向本地后端
npm run dev                      # http://localhost:5173
```

## 目录结构

| 目录 | 内容 |
|---|---|
| `backend/` | Cloudflare Workers API（Hono + D1 + R2 + Workers AI），`src/index.ts` 为入口路由，`migrations/` 为 D1 建表脚本，`test/` 为 vitest 单测 |
| `web/` | React + Vite PWA（时间流/线索/周报），纯静态部署到 Pages |
| `extension/` | 浏览器剪藏扩展（WXT） |
| `mcp/` | 本地 stdio MCP server（远程 MCP 在 backend `/mcp`） |
| `skill/` | 微信 bot 桥（Node 常驻进程）与 OmniBox skill |
| `android/` | Android App（分享面板 + 小组件） |
| `docs/` | 自部署、MCP、导入迁移等文档 |
| `scripts/` | `setup.sh` 一键自部署等脚本 |

## 开发环境

各子项目的本地开发说明见对应目录 README：[backend](backend/README.md) · [web](web/README.md) · [skill](skill/README.md) · [android](android/README.md)。自部署全链见 [docs/self-host.md](docs/self-host.md)。

## 行为准则

友善沟通，就事论事。

## 许可

提交贡献即表示同意你的代码以 [MIT License](LICENSE) 发布。
