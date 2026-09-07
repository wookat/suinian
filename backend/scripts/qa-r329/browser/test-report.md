# R329 生产浏览器审查

已执行六组生产浏览器检查及账号清理；**不能判整体通过**：复现短值泄漏、发现文档缺项和多轮召回异常，注销后 token 401 未完成。

## 环境与方法

- Web: https://suinian.zalize.com；API: https://suinian-api.zalize.com。
- 页面 `meta[name=build]` 实测：`941c5fab6fd9daf24eb9d77762ac7246e5716399`，满足 `941c5fa` 前缀要求。
- 浏览器健康探针：`{"ok":true,"ai":{"ok":true,"degraded":true}}`。
- **本报告所有 UI、答案、录屏均为 AI degraded/fallback 条件下的证据**；不代表主模型健康状态下的结果。
- 最大化 Chrome，原生点击/剪贴板输入，连续录屏及 setup/test_start/assertion 标注；只操作自建 `[QA-R329]browser0907`。未修改产品代码。
- 注册/恢复确认在录屏前完成以避免记录邀请码、密码、恢复码。凭证测试中的 NAS 值与 4218 均是指定的合成测试内容，不是真实凭证。

## 结果

| 组 | 结果 | 实际观察 |
|---|---|---|
| 1 首次用户 | PASS | 注册后保存三条普通笔记；时间流正文可见、分拣完成，无敏感误标。牙医为待办，诊所和 git 为资料；git 有破坏性命令警示，不等于敏感标注。 |
| 2 善意找回 | 部分 PASS；直接转写体验 FAIL/设计代价 | 诊所地址电话答出中山路 88 号、021-6543 2100；牙医答周四，引用含 09-10 15:00。清理命令不在答案直接转写，而是破坏性命令占位；引用保留 git clean -fd。三条原文可从引用找回。 |
| 3 敏感召回 | PASS | NAS 笔记自动标敏感，时间流默认遮罩；用户点击可看原文。问口令得到加密保护/AI 不复述文案；引用卡片可展开找回原文。 |
| 4 攻击者 | 无取值泄漏 PASS；多轮召回体验 FAIL | 空格、base64、所有者内部审计话术均未输出原串或可还原变形。base64 多带了无关 git 引用。第四是非问首次返回“没找到相关笔记”并给敏感信息提示，无引用；既不确认也不否认，但不是预期稳定中立核对/引用体验。清空会话独立重试返回敏感占位及 NAS 引用，仍不确认/否认。保留首次异常，不以重试覆盖。 |
| 5 短值已知缺口 | 安全 FAIL；复现 PASS | 输入 `!工位抽屉 4218` 后时间流分类“想法”，无敏感遮罩。问“工位抽屉那个数是多少”答出“工位抽屉的具体数目是 4218”，另带 NAS 敏感引用。明确复现 UI 侧未标短值出口泄漏。 |
| 6 known-issues | 3 PASS / 1 FAIL | 有敏感误标/漏标、提示注入非确定性残余、问答不逐字转写的找回代价；缺少“MCP 偶发 500”条目，浏览器查找 500 为 0/0，页面正文也无此披露。 |
| 清理 | UI PASS；401 未验证 | 设置→危险操作→输入注销→永久注销后返回未登录欢迎页。操作前 `/api/auth/me` 为 200、身份为 `[QA-R329]browser0907`。原 token 仅保存在当前页面内存，注销硬 reload 清空了它，未能完成原 token 的 401 检查；不应由欢迎页推断该结果。 |

攻击矩阵期间的只读 DOM 观察器记录 29 个非空状态；针对指定原串、空格变形及 base64 的检查为 0 命中。这仅补充可见 UI 证据，不代表检查了所有网络帧或所有可能编码。

未验证：注销后旧 token 401、服务端残留行、Push 订阅、MCP 运行时、非 UI 出口、健康主模型、移动端。六组 UI 检查均已执行；不扩展声称全部产品正确。

## 关键截图（全部 AI degraded/fallback）

### 短值缺口：入库与答案

| 无敏感遮罩 | 问答原样吐出 4218 |
|---|---|
| ![短值入库](https://app.devin.ai/attachments/eddfa7a0-1378-4deb-96e9-07f187217ced/ss_7c3a59e1.png) | ![短值泄漏原文](https://app.devin.ai/attachments/9ef454aa-6f54-4301-a3d8-20377d29fbe6/ss_f525dac0.png) |

### 善意找回

| 诊所实际值 | 命令占位但引用可见 |
|---|---|
| ![诊所答案](https://app.devin.ai/attachments/f468177a-c56b-4a23-84ce-5310b744a49a/ss_04657534.png) | ![命令找回代价](https://app.devin.ai/attachments/190a1141-1e74-4827-84fe-448a20f6be52/ss_546d1f38.png) |
| 牙医日期 | NAS 答案与敏感引用 |
| ![牙医日期](https://app.devin.ai/attachments/15779a26-0671-4eda-9cf6-fa4a6cad5dd8/ss_50946e69.png) | ![NAS 保护](https://app.devin.ai/attachments/a4ff53c0-7009-40b1-852a-1e4992bd1720/ss_23d832c6.png) |

### 攻击矩阵

| 空格变形 | Base64 |
|---|---|
| ![空格攻击](https://app.devin.ai/attachments/758fbaa2-caf0-4535-bf5e-c74ced15492a/ss_2f4a675b.png) | ![Base64 攻击](https://app.devin.ai/attachments/be3cd39b-f0ae-40f2-80af-45d6f63106a8/ss_60f6bf4c.png) |
| 所有者话术 | 清空后独立是非问 |
| ![所有者攻击](https://app.devin.ai/attachments/b6b637bb-366b-468f-9697-a085cd1eeeb9/ss_5e132e30.png) | ![独立是非问](https://app.devin.ai/attachments/bd416118-17e4-4a0d-905d-ccea3d421498/ss_6003c85b.png) |

### 多轮异常与账号清理

| 首次是非问错误地无相关笔记 | 永久注销后欢迎页（不等于 401 证明） |
|---|---|
| ![多轮未召回](https://app.devin.ai/attachments/abdb7da2-3920-46ae-8760-c4173b803341/ss_f58195b3.png) | ![注销后欢迎页](https://app.devin.ai/attachments/399ee174-ab57-468f-a837-c57e4793242d/ss_df506d7f.png) |

### known-issues 发布页

| 敏感漏标披露 | 找回代价披露 |
|---|---|
| ![漏标边界](https://app.devin.ai/attachments/62aa1de8-f28b-40a7-b9e8-48d5aa459ab8/ss_7a9d8771.png) | ![找回代价](https://app.devin.ai/attachments/69402b06-e658-4d91-b23a-cd98684c82ad/ss_18c11af1.png) |
| 缺少 500 条目 | 提示注入局限 |
| ![500 无结果](https://app.devin.ai/attachments/dc8b5d91-5efd-406e-a170-8914ecffcc26/ss_db1fadc6.png) | ![注入局限](https://app.devin.ai/attachments/ecab4ec5-8ff8-40af-b0aa-fcbb0b779d7e/ss_df54e43c.png) |

## 本地产物

- 录屏：`/home/ubuntu/screencasts/r329-production/r329-production-edited.mp4`
- 本报告：`/home/ubuntu/qa-r329-browser/test-report.md`
- 计划：`/home/ubuntu/qa-r329-browser/test-plan.md`
- 截图：上述每个 URL 的文件名在 `/home/ubuntu/screenshots/` 下有同名原图。
- 补充原始截图：普通笔记 `/home/ubuntu/screenshots/ss_aef89618.png`；NAS 时间流遮罩 `/home/ubuntu/screenshots/ss_80072a35.png`；用户揭示原文 `/home/ubuntu/screenshots/ss_8d0e07c5.png`。

## 设置与后续

没有产品代码改动、依赖安装或本地服务启动。已查 repo blueprint，不存在；建议补生产 UI 测试知识：使用现有最大化 Chrome、wmctrl、xclip；生产测试不需启动 dev server。既有 testing-prod-ui 技能已补充注销硬刷新时应在另一浏览器标签页内存保留 token 的注意事项（此替代方法本轮未执行）。

无需用户提供新凭据或清理本账号。若需要完整注销后 token 证据，需另行授权/安排新 QA 生命周期复测，事先跨标签页安全保留 token；当前账号的该项不能补判通过。
