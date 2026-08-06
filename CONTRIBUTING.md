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

## 开发环境

各子项目的本地开发说明见对应目录 README：[backend](backend/README.md) · [web](web/README.md) · [skill](skill/README.md) · [android](android/README.md)。自部署全链见 [docs/self-host.md](docs/self-host.md)。

## 行为准则

友善沟通，就事论事。

## 许可

提交贡献即表示同意你的代码以 [MIT License](LICENSE) 发布。
