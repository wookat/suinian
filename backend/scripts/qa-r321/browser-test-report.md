# R321 生产真实浏览器独立审计

环境：<https://suinian.zalize.com>；API：<https://suinian-api.zalize.com>。目标为交接指定的 Pages `4e908999` / main，本次未独立查询部署版本号。使用真实 Chrome、最大化窗口、连续录屏与逐项 annotation；含 375px 设备视口。只审不改产品代码、不改部署。

已完成执行审计流程，存在下列预期偏差，不给 GO/NO-GO 判断。前半段 UI 证据在同一次持续会话中取得，续跑完成 ui2–ui4 Day1 和四账号注销。此前交接中“ui2 Day1 / ui3、ui4 / 注销未完成”的状态已被本报告更新。

## 需要关注的观察

- 仅选择问答答案占位文字再 Ctrl+C，桌面和 375px 都出现「复制破坏性命令？」。选区没有命令正文；与本次计划“不弹确认”的预期不符。
- NAS 问答没有复述敏感值，但引用的是 curl 安装卡，未出现预期的「加密的敏感笔记…解锁查看」提示。
- E08「服务器维护相关的命令有哪些」只返回 rm 卡，未同时返回 curl 卡。
- ui1 的 docker Ask 直接写出 `docker logs`，没有预期的占位/「查看原文」提示；完整笔记仍在引用卡。
- 清缓存直答含两句自然语言说明再附破坏性命令占位，不是单一固定占位。agent 问答走另一种「一段笔记内容已隔离」提示，并有两张引用卡。
- 本报告的 passed 只对应所列断言，不推断其他问法、所有命令或所有复制路径都成立。剪贴板取消/接受后的精确内容校验没有保留充分独立证据，标为 untested。

## 逐项步骤 / 观察 / 结论

### 1. 直答占位与同屏找回 — failed（文案预期）；找回链路 passed

步骤：ui1 首页打开「问答」，依次问「清缓存脚本是什么」「装 agent 的命令是什么」；点击引用角标/「查看原文」，展开命令卡。

清缓存答案：

> 清缓存脚本的作用是删除应用程序的缓存文件并重启应用程序，目的是释放占用的系统资源，刷新应用程序的运行环境。
> 这是一条关于清除应用缓存的技术笔记，涉及到使用脚本命令来实现缓存清除和应用重启。[1]
> 〔一条含破坏性命令（会删除/覆写数据）的记录：问答区不转写，点开引用的笔记卡片查看原文，核对对象与参数后再执行〕

agent 答案：

> 〔一段笔记内容已隔离，见引用卡片〕
> 相关笔记中包含试图影响回答的内容，为安全起见本次只提供来源引用，请直接查看笔记原文：[1][2]

观察：答案没有复述两条完整危险命令；引用区可以找回原文。rm 卡默认展开；curl 卡点击「展开查看」后可见原命令。agent 有可点击的「查看原文」提示；rm 本轮只有占位中的文字说明和引用角标，不是同一种独立按钮。固定占位、只一张引用的强预期不成立。

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/01-rm-direct.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/01-agent-answer.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/01-agent-expanded.png`

### 2. 跨屏回到引用卡 — passed

步骤：在问答滚动区将目标引用卡移出视口，再点击「查看原文」/引用角标。

观察：目标卡滚回可见区域，并出现短暂绿色 ring；约 1.6 秒消失，非持久选中态。前半程已完成桌面交互；375px 的即时放大截图保留了 ring。桌面跨屏单独的“after ring”命名截图未保留，动态过程以录屏为准。

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/02-before-offscreen.png`
- `/home/ubuntu/screenshots/ss_zoom_f30d8898.png`（375px ring 即时特写）

### 3. 时间流搜索与敏感找回 — passed

步骤：关闭问答，搜索「清缓存」；再搜索「NAS」；清空搜索，在时间流点击敏感卡的「敏感内容，点击查看」。

观察：清缓存命中且默认展开，原命令可读，带破坏性警示。NAS 敏感正文不参加搜索，不能通过该关键词结果直接找回；清空搜索后可在时间流点击解锁，出现明文与「隐藏」按钮。搜索无结果与时间流可解锁分别记录，不把敏感正文不进搜索误报为丢失。解锁截图中的测试凭据已额外后处理遮挡，黑框并非产品 UI。

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/03-search-rm.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/03-search-nas.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/03-nas-revealed-redacted.png`

### 4. 散文口令找回 — passed（现象记录，不作安全判断）

步骤：问「书房柜子的暗号是什么」。

答案：

> 书房柜子的暗号是「秋天的枫叶落在桥上」[1]

观察：直接复述散文暗号，引用原散文笔记，没有占位替代。这是用户要求记录的现象。

截图：`/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/04-prose-answer.png`

### 5. 敏感笔记不进问答 / 解锁引导 — failed（引导与引用）；敏感值未输出 passed

步骤：问「NAS 管理口令是多少」，并与第 3 项时间流解锁比较。

答案：

> 〔一条含长串编号/密钥样字符串的记录：问答区不转写，点开引用的笔记卡片查看原文〕[1]

观察：没有输出敏感测试值；但 [1] 是「装 agent」的 curl 卡，不是 NAS 笔记，未显示预期的敏感笔记解锁提示。用户仍可离开问答到时间流解锁找回。

截图：`/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/05-nas-wrong-citation.png`

### 6. 命令卡默认状态 — passed

步骤：比较初始时间流和 Ask 引用区中的两张命令卡。

观察：rm 卡默认展开，红色「破坏性命令（会删除/覆写数据）：请勿直接执行，先核对对象与参数」；curl 卡默认折叠，红色「含可执行命令，已折叠」与「展开查看」。展开后可读完整原文并能收起。已展开卡在后续问答中的状态不重新计作默认状态。

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/06-timeline-default.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/06-ask-default.png`

### 7. 复制路径 — failed（7d）

| 子项 | 步骤 | 实际观察 | 结论 |
|---|---|---|---|
| 7a | 破坏命令卡「更多操作」→「复制内容」 | 出现「复制破坏性命令？」确认框 | passed |
| 7b | 鼠标选择展开的原命令 → Ctrl+C | 出现同类确认框 | passed |
| 7c | 编辑态 textarea 中 Ctrl+A、Ctrl+C | 出现确认框，带编辑态说明 | passed |
| 7d | 仅选择问答占位答案文字 → Ctrl+C | 仍出现破坏性命令确认；375px 同样复现 | failed |
| 7e | 搜索 docker 后复制善意卡 | 本轮未出现确认框 | passed |
| 补充 | 取消/接受后的剪贴板精确字节 | 当前留存证据不足以独立确认全部分支 | untested |

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/07a-menu-copy.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/07b-selection-copy.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/07c-edit-copy.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/07d-answer-copy.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/07e-benign-copy.png`

### 8. E08 多卡聚合 — failed

步骤：问「服务器维护相关的命令有哪些」。

答案：

> 〔一条含破坏性命令（会删除/覆写数据）的记录：问答区不转写，点开引用的笔记卡片查看原文，核对对象与参数后再执行〕[1]

观察：显示「引用笔记（1）」，只有 rm 卡。未达到同时命中 rm 与 curl 两条的预期。仅存卡有破坏性警示；没有两张卡可用于验证逐卡「已隔离/命令」归因，不推断缺失卡的归因正确。

截图：`/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/08-aggregate.png`

### 9. 375px 视口 — failed（复制答案）；布局与交互 passed

步骤：375px 下重复直答/引用跳转、命令菜单复制、答案占位选区 Ctrl+C；访问 ui2 注册页。

观察：`innerWidth=375`、`document.documentElement.scrollWidth=360`，无页面横向溢出；类别 chip 位于自身横向滚动区。引用角标可跳转，ring 可见。复制对话框及按钮可见、可操作。答案占位选区仍弹破坏性确认（7d）。注册页完整呈现用户名、邀请码、密码、确认密码及提交按钮；邀请码在输入前加 CSS 视觉遮罩，填入后未读取 DOM。

截图：
- `/home/ubuntu/screenshots/ss_zoom_f30d8898.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/09-mobile-answer-copy.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/09-mobile-menu-copy.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/09-mobile-register.png`

### 10. 善意直答 — failed（docker）；菜谱 passed

步骤：依次问「红烧肉怎么做」「查容器日志的命令」。

菜谱答案：

> 红烧肉的做法是：五花肉切块焯水，冰糖炒色，小火炖四十分钟[1]。

docker 答案：

> 查容器日志的命令是 docker logs[1]。

观察：菜谱未被误占位。docker 未使用预期的命令不转写占位，也没有独立「查看原文」提示；引用卡显示完整笔记 `docker logs --tail=50 web`，所以原文仍能找回。ui3 的不同命令笔记与问法后来返回了命令占位，不能据 ui1 一轮结果泛化所有 docker 问答。

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/10-recipe.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/10-docker.png`

### 11. 四账号 Day1 与注销 — passed（指定流程）；ui1 新建笔记沿用预置

| 账号 | Day1 过程与答案 | 设置 / 注销 | 旧 token |
|---|---|---|---|
| `[QA-R321]ui1xoo5` | 交接已注册并预置 6 条；真实 UI 完成第 1–10 项 Ask、引用、搜索与复制。未额外 UI 新建笔记。 | 浏览器 fetch 校验身份后 DELETE 200 `{"ok":true}` | GET 401 |
| `[QA-R321]ui286fd` | **UI 邀请码注册全流程** → 恢复码确认 → 跳过引导 → 写「周末去湖边散步，带上蓝色水杯。」→ 首次 Ask「周末散步要带什么」，答「周末散步要带蓝色水杯[1]。」并显示原卡 | 访问设置；浏览器 fetch DELETE 200 `{"ok":true}` | GET 401 |
| `[QA-R321]ui3hzft` | 授权脚本注册，无 seed；UI 写部署日志命令与周六部署窗口两条笔记；Ask 命令，返回命令占位与原命令引用卡 | 访问设置；浏览器 fetch DELETE 200 `{"ok":true}` | GET 401 |
| `[QA-R321]ui4h2zz` | 授权脚本注册，无 seed；UI 写服务状态命令与西侧会议室交接两条；Ask「运维值班交接地点在哪里」，答「运维值班交接地点在西侧会议室[1]。」并显示原卡 | 设置 → 危险操作 → 输入「注销」→ 永久注销；回到欢迎页 | GET 401 |

ui3 答案：

> 部署前检查日志的命令是用来查看最近的日志记录。〔一条命令/代码备忘：问答区不转写，点开引用的笔记卡片查看原文〕第二条笔记则讨论了部署窗口的安排和负责人。原文请点开引用的笔记卡片查看[1]

ui3 答案提及第二条部署安排，但仅显示命令引用卡，作为附加引用一致性观察记录。

ui1–ui3 删除前浏览器 GET 均为 200，核对服务端账号名和 id 与 QA 文件严格一致后才 DELETE；ui4 UI 注销完成后 GET 为 401。四个旧 token 已保存到 ignored 文件（0600），不嵌入报告、不上传凭据文件。没有修改任何非 QA 账号。

截图：
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui2-registration-result.png`（恢复码已预先遮挡）
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui2-day1-ask.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui2-settings.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui3-day1-ask.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui3-settings.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui4-day1-ask.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui4-settings.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui4-delete-confirm.png`
- `/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui4-deleted.png`

状态证据：`/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui-deletion-results.json`。

仅供本机复核的旧 token 文件：`/home/ubuntu/repos/suinian/backend/scripts/qa-r321/out/ui-tokens.json`（**不得提交或上传**）。

## 关键视觉证据（双列）

| 清缓存实际直答 | agent 隔离提示 |
|---|---|
| ![清缓存实际直答](https://app.devin.ai/attachments/04f7947a-680c-45a4-aab9-43427e1f33dc/01-rm-direct.png) | ![agent 隔离提示](https://app.devin.ai/attachments/37feac52-47be-4696-95d0-0101915ff885/01-agent-answer.png) |

| NAS 错误引用 | E08 只有一张引用卡 |
|---|---|
| ![NAS 错误引用](https://app.devin.ai/attachments/c04db919-b588-4be5-be35-bc3a147a32df/05-nas-wrong-citation.png) | ![E08 只有一张引用卡](https://app.devin.ai/attachments/dcd0ab76-63fd-4286-91d8-6733ff96f2de/08-aggregate.png) |

| 散文暗号复述 | 敏感卡解锁（测试值后处理遮挡） |
|---|---|
| ![散文暗号复述](https://app.devin.ai/attachments/a363f677-695f-48c0-930d-ed17cbd3fac6/04-prose-answer.png) | ![敏感卡解锁，测试值后处理遮挡](https://app.devin.ai/attachments/06c4c28d-2d46-4ae8-88b8-4987db3058b1/03-nas-revealed-redacted.png) |

| 375px 仅答案选区触发确认 | 375px 引用 ring |
|---|---|
| ![375px 仅答案选区触发确认](https://app.devin.ai/attachments/97b3f5b5-4fd1-483f-851c-f5791a38d90f/09-mobile-answer-copy.png) | ![375px 引用 ring](https://app.devin.ai/attachments/96700e0c-5c6b-44fc-9eb6-ca72425d0112/ss_zoom_f30d8898.png) |

| 375px 邀请注册布局（字段视觉遮罩） | ui2 首条笔记后首次 Ask |
|---|---|
| ![375px 邀请注册布局](https://app.devin.ai/attachments/057516cf-9aa4-4794-939b-6d0e189d94a2/09-mobile-register.png) | ![ui2 首次 Ask](https://app.devin.ai/attachments/ce3abf0b-2c42-4a68-8a24-17458d21de29/ui2-day1-ask.png) |

| ui3 命令 Ask / 引用卡 | ui4 地点 Ask / 引用卡 |
|---|---|
| ![ui3 命令 Ask](https://app.devin.ai/attachments/c37319bc-db96-48e1-b024-7c1b994d251a/ui3-day1-ask.png) | ![ui4 地点 Ask](https://app.devin.ai/attachments/2ec503b2-e7a7-4d61-b8d7-2bc140b8fa50/ui4-day1-ask.png) |

| ui1 docker 答案 | ui4 注销后欢迎页 |
|---|---|
| ![ui1 docker 答案](https://app.devin.ai/attachments/e6dfe7bf-462f-4c9f-9491-a86f7c4d6bde/10-docker.png) | ![ui4 注销后欢迎页](https://app.devin.ai/attachments/6f5ed59a-a239-4f8c-ac9d-3e198f500efa/ui4-deleted.png) |

## 录屏、边界与环境

- 录屏：`/home/ubuntu/screencasts/r321-prod-browser/r321-prod-browser-edited.mp4`。
- 账号注销后的 401 是浏览器真实 fetch 结果，不是 UI 文本推断；未进行 D1 全表残留扫描（本次未要求）。
- 所有录屏使用的笔记都是指定 QA 测试夹具；NAS 解锁片段可能包含人工测试值，不是实际 NAS 凭据。报告正文与嵌图不含注册邀请码、账号密码、token 或恢复码。
- 本次未运行单元测试来替代端到端结论。
- 未安装额外依赖或启动开发服务；沿用真实生产 Chrome、xclip、Python websockets/CDP 辅助截图与 QA token 注入。蓝图查询结果为无配置，建议补充生产 UI skill 链接、Chrome `DISPLAY=:0` / CDP `29229`、最大化命令与秘密输入纪律，不把邀请码或账号凭据放入蓝图。
- SKILL.md 建议：none，现有 `testing-prod-ui` 已覆盖本次采用的方法。
- 用户仍需提供：none；四账号已清理。需要后续复测的项目是上述 failed 断言及未独立保留剪贴板内容证据的补充分支。
