# R93 UI 实测发现清单（测试代理 · 只测不改 · 生产环境）

- 环境：https://suinian.zalize.com（API https://suinian-api.zalize.com），Chrome 桌面 + DevTools 设备模拟
- QA 账号：`[QA-R93]-ui` / 密码 `QaR93!ui2026`（已于收尾自助注销，注销后用原凭据登录被拒「用户名或密码错误」，可核对）
- 录屏：/home/ubuntu/screencasts/rec-43b8f676-7074-4aa5-8d87-92e25cc6dcd7/rec-43b8f676-7074-4aa5-8d87-92e25cc6dcd7-edited.mp4
- 截图目录：/home/ubuntu/screenshots/

## P0

### P0-1（UI 侧表现）AI 分拣全断：所有新笔记永久显示「AI 分拣中…」
- 复现：任意提交一条笔记，等待 30 分钟+，卡片仍为「AI 分拣中…」，无分类、无标签、无失败态提示。
- 根因：生产 DeepSeek key「Insufficient Balance」（lead 已一手验证，见 audit-r93.draft.md P0-1）。
- 连锁阻断（本轮全部标 failed/blocked，UI 侧无法验证）：AI 分拣类别/标签、待办自动提取（含 due 时间）、敏感内容遮罩、问答 LLM 回答（走降级文案）、线索聚类生成、周报/洞察内容生成、今日回顾。
- UI 缺陷（独立于余额问题）：「AI 分拣中…」无超时、无失败态，AI 故障对用户完全静默。
- 截图：/home/ubuntu/screenshots/ss_6a6ee09f.png（13 条笔记全部卡分拣中）

## P1

### P1-1 删除确认文案与实际行为矛盾
- 复现：时间流任一笔记卡片菜单 → 删除，原生 confirm 文案称「删除后无法恢复」；但设置页「最近删除」明确写「删除的笔记保留 30 天，期间可恢复」，实测删除后确实可在回收站恢复。
- 影响：吓退用户或造成误解，属用户可感知的文案矛盾。
- 截图：/home/ubuntu/screenshots/ss_127a2289.png

### P1-2 注销账号的原生 prompt 不利于输入法/自动化，且键入中文可能失败
- 复现：设置 → 危险操作 → 注销账号 → confirm 后弹原生 prompt 要求输入「注销」。实测通过键盘直接键入中文未被 prompt 接收，返回「输入不匹配，已取消注销」；改用 console stub window.confirm/prompt 后流程成功。
- 建议：危险操作改用应用内自绘对话框（与删除确认统一），避免原生 prompt 的输入法兼容与不可样式化问题。
- 截图：/home/ubuntu/screenshots/ss_15fad637.png（原生 prompt）、/home/ubuntu/screenshots/ss_3c56d73d.png（输入不匹配提示）

## P2 / 通过项记录

- 单条删除→回收站→恢复：通过。删除 burst-06 → 「已删除 1 条」→ 最近删除显示「剩 29 天」→ 恢复 → 回时间流。截图 ss_93fab6dd / ss_419c634f / ss_f2548010 / ss_db37d28f。
- 断网提交：通过。DevTools offline 提交显示「网络连接失败，请检查网络或 API 地址」，输入框内容保留不丢；恢复网络重发成功。截图 ss_9ade8fde / ss_859c523d。
- 深色主题走查（时间流/待办/线索/周报/洞察/设置）：通过，未见对比度/裁切/布局异常。截图 ss_75ed357a / ss_f26491dc / ss_12f8a23a / ss_fcb311b8 / ss_0dd96afd / ss_e887a948。
- 响应式：375×667 出现底部导航 + 悬浮记录按钮，无横向溢出；768×900 为侧栏桌面布局，无溢出。截图 ss_5893fac6 / ss_18d9ee3c。
- 注销账号流程：通过（需 console stub，见 P1-2）。注销后回引导欢迎页（演示数据），原凭据登录被拒。截图 ss_9afac746（confirm）/ ss_029fa126（注销后引导页）/ ss_43d64c71（登录被拒「用户名或密码错误」）。

## Lighthouse（生产首页，headless Chrome）

| 模式 | Performance | Accessibility | Best Practices | SEO |
|---|---|---|---|---|
| Desktop | 100 | 100 | 100 | 100 |
| Mobile | 95 | 100 | 100 | 100 |

原始报告：/tmp/lh-desktop.json、/tmp/lh-mobile.json。

## 设计建议

- D-UI-1 「AI 分拣中…」应有超时失败态（如「分拣失败，点此重试」），否则后端 AI 故障对用户完全不可见（本轮即实例）。
- D-UI-2 删除相关文案统一为「移入最近删除，30 天内可恢复」。
- D-UI-3 危险操作弹窗自绘化（见 P1-2）。

## 未完成 / 阻断项（DeepSeek 恢复后需补测）

AI 分拣结果与标签合理性、待办 due 解析、敏感内容遮罩（列表遮罩、搜索/ask 不露正文）、问答直答与追问、线索生成、今日回顾、周报/洞察内容。
