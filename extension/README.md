# 碎念剪藏 · 浏览器扩展（Chrome / Edge，Manifest V3）

把网页「顺手丢进」碎念的桌面侧入口：一键保存当前页、划词保存、加备注和标签后再存。基于 [WXT](https://wxt.dev/) + [@mozilla/readability](https://github.com/mozilla/readability)。

## 功能

- **一键保存当前页**：工具栏弹窗（或快捷键 `Alt+Shift+S`）保存「标题 + URL + Readability 正文抽取」，正文最多 3000 字，抽取失败时退化为标题 + 链接。
- **划词保存**：选中文字后「右键 → 保存划词到碎念」或快捷键 `Alt+Shift+X`，保存选中内容并附来源标题与链接。
- **弹窗备注/标签**：保存前可以填备注、加标签（逗号分隔，作为手动标签，AI 不会覆盖）；保存成功有明确提示（弹窗内 ✅ / 系统通知）。
- **设置页**：填 API Base URL 与 Token（与 Web 端一致，Web 端设置页可复制 Token），支持「测试连接」。

保存的笔记 `source=extension`，走碎念既有的 AI 分拣 / 链接抓取 / 线索聚类管线。

## 本地加载（开发者模式，暂不上架商店）

```bash
cd extension
npm install
npm run build          # 产物在 .output/chrome-mv3/
```

**Chrome**：打开 `chrome://extensions` → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/.output/chrome-mv3` 目录。

**Edge**：打开 `edge://extensions` → 左侧开启「开发人员模式」→「加载解压缩的扩展」→ 同样选择 `extension/.output/chrome-mv3`（Chromium 内核通用；也可 `npm run build:edge` 用 `.output/edge-mv3`）。

首次使用：点扩展图标 → 右上角「设置」→ 填 API 地址（默认 `https://suinian-api.zalize.com`）与你的 API Token → 测试连接。

## 打包（分发 zip）

```bash
npm run zip            # Chrome：.output/suinian-extension-<version>-chrome.zip
npm run zip:edge       # Edge
```

## 开发

```bash
npm run dev            # 热重载开发（自动拉起 Chrome）
npm run typecheck      # wxt prepare + tsc --noEmit
```

## 目录结构

```
entrypoints/
  background.ts        # 右键菜单 / 快捷键 / 系统通知
  extract.ts           # 按需注入的正文抽取脚本（Readability + 划词）
  popup/               # 工具栏弹窗（备注 / 标签 / 保存）
  options/             # 设置页（API 地址 + Token）
utils/api.ts           # 设置存储 + /api/notes 客户端
```
