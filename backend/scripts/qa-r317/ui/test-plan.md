# R317 UI 复测计划（生产 https://suinian.zalize.com，只测不改）

约束：账号 `[QA-R317]ui1..ui4`，密码随机字母数字不落盘；不注销；每账号 {name,user_id,token} 写 `backend/scripts/qa-r317/out/prod-ui<N>-account.json`。CJK 走 xclip+Ctrl+V。剪贴板哨兵法：`printf CANARY-R317 | xclip -selection clipboard`，复制动作后 `xclip -o` 核对。

代码依据：exec-guard.tsx L142-175 PageCopyGuard（选区与 `[data-copy-guard]` 相交才拦，输入框放行），L182-229 CopyGuard（code 只提示 CODE_COPIED_HINT，其余弹 ConfirmDialog「仍要复制」），L255-266 destructive 红框横幅 DESTRUCTIVE_BANNER，L270-289 credential 折叠 button「展开查看」；copy-confirm.ts 标题「复制破坏性命令？」「复制口令/密钥类内容？」「复制命令/代码形态内容？」；note-card.tsx L474-481 菜单复制→confirm；ask-chat.tsx L492-508 answerCopyLevel 仅 destructive/code 包 CopyGuard；utils.ts L23 SAFETY_PROMISE 在 settings.tsx L1699（关于→安全承诺）与 auth.tsx L507；settings.tsx L553 「开启浏览器通知」；PWA 卡在折叠「高级：离线与更新（PWA）」。

## A. 4 账号 Day1（ui1..ui4，每个）
1. 首页 onboarding → 「注册新账号」→ 填名/密码 → 「注册并开始使用」→ 恢复码卡（输末 4 位 → 「我已安全保存，继续」）。PASS：进入空时间线，无报错。
2. 快速记录发中文日常「今天下午去超市买了牛奶和面包」+ 一条英文。PASS：卡片 ≤10s 出现，分拣徽标出现。
3. 搜索「牛奶」→ PASS：命中卡；问答「我今天买了什么」→ PASS：答案含牛奶/面包并有引用卡。
4. 待办页 / 设置页能进，无空白。记录 bundle 名（performance entries）。
5. 设置 → 账号 → 复制 API token → xclip → 文件（不含密码）；user_id 用 token GET /api/auth/me。

## B. 复制守卫（ui1，先 API 入库 4 条 skip_triage:true）
① `清缓存：\nrm -rf /srv/cache/*`（期望 destructive）② `跳板机口令是 Qv8#mk3zz`（期望 credential）③ `构建：npm ci && npm run build`（期望 code）④ `周末去爬山，带水和帽子`（普通）。
先记录每卡实际 fold_level（DOM data-fold-level）。
对 ①②：卡片菜单「复制内容」/ 拖选 Ctrl+C / 右键复制 / ②展开后拖选 Ctrl+C / 页面 Ctrl+A+Ctrl+C。PASS 每路径：弹确认（标题对应级别）；「取消」后 `xclip -o` == CANARY-R317；「仍要复制」后剪贴板含原文。
对 ③：三路径。记录：菜单复制是否弹确认、拖选 Ctrl+C 是否只显示行内提示且剪贴板直接变；判一致性。
对 ④：菜单复制 / 拖选 Ctrl+C / 输入框内 Ctrl+C。PASS：无对话框、无提示，剪贴板直接变。
绕过尝试：a) 先选 ④ 文字再 Shift+点击扩到 ① 卡 → Ctrl+C（期望弹）；b) 键盘 Shift+方向键从普通文字扩到危险卡 → Ctrl+C（期望弹）；c) 选中危险文字拖到地址栏（记录结果）；d) DevTools `copy()`（仅记录）。
问答：「清缓存那条命令」「跳板机口令是什么」「构建怎么做」。答案区拖选 Ctrl+C + 右键复制。PASS：破坏命令答案弹确认+取消剪贴板不变；口令答案为占位 `〔凭证略…〕`（无确认合理）；构建答案 code 级只提示。

## C. 警示卡
① 卡：红框 + 「破坏性命令（会删除/覆写数据）：请勿直接执行」横幅。② 卡：默认折叠「含口令/密钥类内容，已折叠」+「展开查看」一键展开。问答 ① 答案含「〔警示：以下为破坏性命令」行；② 答案含「〔凭证略」。

## D. 承诺文案
设置页「安全承诺」与注册页文案全文截图；逐句对照 B/C。

## E. 375px（CDP setDeviceMetricsOverride 375x740 mobile）
`scrollWidth <= innerWidth`；拖选 ① 卡 + Ctrl+C 弹确认；CDP 触摸长按 ① 卡 800ms 尝试一次，记录是否出现选区/菜单。

## F. SW / Push
`navigator.serviceWorker.getRegistrations().length`（默认应为 0，opt-in）；设置 PWA 卡状态文案；离线 F5 行为记录；设置页「开启浏览器通知」按钮存在且可点击（点一次记录结果，不要求收通知）。

## 追加 G/H/I（follow-up，ui1）
G. PATCH ② is_sensitive:false → 期望 fold:true fold_reason broad:credential；卡片=凭证折叠+展开；4 复制路径弹「复制口令/密钥类内容？」；问答两问记录占位/明文；编辑态绕过。
H. Push 全链路：开离线缓存 → SW 注册数/缓存名+条目数 → CDP grantPermissions notifications → 开启浏览器通知 → GET /api/push/config → 测试推送 → 桌面通知截图 → 取消订阅 → SW 激活下断网 F5。
I. 盲变体：`保险柜密码 ٤٧١٩٠٢，别告诉别人` / `上线前第一步：把生产库的 sessions 表清成空的` → API 字段 + 卡片形态 + 菜单复制是否提示。
