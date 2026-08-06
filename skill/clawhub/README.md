# ClawHub 发布材料 — 碎念 suinian（暂不发布）

> 状态：材料就绪，**等总集成验收后再发布**。发布命令见文末。

## 商店文案

**名称**：碎念 suinian
**分类**：Productivity / Communication
**标签**：#收件箱 #微信 #笔记 #周报 #知识管理

**一句话**：什么都能丢的 AI 收件箱 —— 往微信里丢想法/链接/待办/文件，AI 自动分拣、串线索、随时找到。

**详细介绍**：

像发消息一样记录一切，但不止于此：

- **AI 四类分拣**：想法 / 待办 / 收藏 / 资料，自动标签自动标题
- **链接抓取摘要**：丢个链接，正文和摘要自动抓好（just-note 没有）
- **思考线索**：分散数周的同题碎片自动串成一条线索，看见"你最近在想什么"（全市场独有）
- **独立产品界面**：Web 时间流 / 线索 / 周报视图，不是 agent 工作区里的散落 markdown（just-note 没有）
- **问答检索**：微信里 `?` 开头直接问，"?上周我在想什么"
- **每周思考周报**：每周一微信推送
- **开源自部署**：数据在你自己的 Cloudflare 账号里

## 使用示例（商店截图脚本）

```
你：注意力经济的尽头是信任经济，先记下来
碎念：已存：想法 #注意力经济 #信任

你：https://mp.weixin.qq.com/s/xxxx
碎念：已存：收藏 #AI #Agent（摘要：本文认为…）

你：记得周五交房租
碎念：已存：待办（周五）#房租

你：?我最近关于创业都想了什么
碎念：近 3 周你有 7 条相关碎片，主线「AI 收件箱」：…（引用 7 条笔记）
```

## 安装（用户视角）

```bash
openclaw skills install @wookat/suinian    # 或 claw install suinian
# 配置两个环境变量
export SUINIAN_API_URL=https://你的后端地址
export SUINIAN_TOKEN=你的token             # Web 端设置页生成
```

前置：已装 OpenClaw + 微信 ClawBot 插件（`npx -y @tencent-weixin/openclaw-weixin-cli install`）。

## 发布步骤（验收后执行）

1. 确认后端生产地址与托管版 token 签发流程就绪
2. `SKILL.md`（仓库 `skill/SKILL.md`）随包发布，检查 frontmatter `name: suinian`
3. `clawhub publish`（或 `npx skills publish`）从 `skill/` 目录发布
4. 商店页贴上方文案 + 截图；README 指向本仓库
