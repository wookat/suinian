# R107 独立审查 — UI/入口侧测试计划（只测不改）

账号：[QA-R107]-main（/home/ubuntu/qa-r107-creds.json，token 已验证可用）。生产 https://suinian.zalize.com / https://suinian-api.zalize.com。录屏覆盖所有浏览器/GUI 步骤；MCP/构建类 shell 步骤不录。

## 1. 三入口回归

### 1a. 剪藏扩展（已 build：extension/.output/chrome-mv3）
- 加载已解压扩展 → options 页填 API 地址 + token → 「测试连接」成功（显示已连接/用户名）。
- 打开一个真实网页（如 https://example.com 或 MDN 文章页），点扩展弹窗 → 保存当前页。
  - PASS：弹窗显示 ✅ + 「在碎念中查看 →」。
- 到 Web 时间流 F5：该笔记出现，source=extension（卡片可见来源/内容含标题+URL），几十秒内 AI 分拣出分类角标+标签。
  - FAIL：笔记未入库 / 无分拣。

### 1b. MCP（本地 stdio dist/index.js，等价远程 /mcp）
shell 冒烟（记录 JSON 输出为证据）：
- list tools：应含 save_note/search_notes/ask/list_threads/get_thread/get_weekly_report/list_todos/complete_todo/delete_note/restore_notes 等。
- save_note 新建一条 → 返回 saved:true；Web 时间流可见。
- search_notes 搜「密码」→ 敏感笔记 content/title/tags 均为 `[敏感内容已脱敏]`，不泄露明文。
- delete_note 删除刚建笔记 → deleted:true + 软删提示；Web 回收站（设置页/回收站入口）可见该笔记，时间流不显示。

### 1d. 一致性专项（409 + 各入口遮罩/软删一致）
- Web 时间流打开某笔记编辑（不保存），MCP（或 curl PATCH）改同一条 → Web 点保存。
  - PASS：出现 409 冲突 UI：编辑框保留我的输入 + amber「最新版本」面板 + 「放弃我的输入，改用最新版本」按钮。
  - FAIL：输入丢失或直接覆盖。
- 敏感遮罩一致性：扩展无读取界面（仅写入，跳过）；MCP 已验（1b）；Android 见 1c；Web 端敏感卡片默认遮罩、点击才显。
- 软删一致性：1b 删除的笔记在 Web 时间流/搜索不出现；MCP search 也搜不到。

### 1c. Android（降级预案：>40min 无进展则 build 冒烟/报告说明）
- 安装 cmdline-tools + platform-tools + system-image，`./gradlew assembleDebug`。
- 若模拟器可行：装 APK → 设置填 API+token → 登录/加载时间流；速记一条 → Web 可见；敏感笔记列表中遮罩；409 回归（Web 先改，Android 编辑保存 → 不丢输入）。
- 若不可行：报告注明 build 是否通过 + 未测原因。

## 2. 视觉走查（Web，devtools device toolbar 768 / 1024 / 1920×1080）
每档依次截图：时间流、线索页(#/threads)、周报页(#/reports 或导航「周报」)、设置页、问答（时间流 ?问题 或问答区）。
- PASS：无横向溢出、无元素重叠/断裂、留白正常；1920 档右栏(记录统计/标签云 xl:)出现。
- 问答：提交一个问题（「?我最近关于咖啡记了什么」）→ 回答含 [n] 角标；点击 [n] 跳转/高亮对应引用笔记。
- 打印样式：时间流与周报页 Ctrl+P 预览截图 → 内容可读、无导航遮挡/空白页。

## 3. 洞察 UI
- 周报页：4 份周报/月报列表可见；打开一份 → markdown 渲染（标题/列表非原始 # 符号）。
- 今日回顾入口：时间流/导航上的今日回顾入口可点开并渲染。

## 产出
audit 截图 /home/ubuntu/screenshots/r107-*.png；录屏；报告按 P0/P1/P2 分级。
