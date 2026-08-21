# R225 独立审查报告（只审不改）

- 日期：2026-08-21（UTC）
- 对象：prod https://suinian-api.zalize.com / https://suinian.zalize.com（main = R224 PR #248 已合并，worker f1e82a20）
- 方式：全新 QA 账号（[QA-R225]-dir / -main / -ui / -sec / -idem，测毕全部注销），生产实测为主，辅以本地测试与源码检查。未部署、未改任何生产配置。GitHub Actions 保持禁用。
- 证据类型标注：生产实测 / 本地测试 / 源码检查 / 模拟 / 未验证。

## 0. 结论与 GO/NO-GO

**建议：GO（附条件）**。R224 全部修复项在生产复核通过，R215–R224 十轮代表 case 无漂移回归，安全抽查全部通过，QA 数据 D1 逐表 0 残留。两项新发现需要跟进：

- **P1（新发现）注销后 R2 图片对象残留**：`DELETE /api/auth/me` 后，同批次两个附件中 txt 被删除、png 仍可下载（注销后 12 分钟复查仍存在，内容与原件逐字节一致）。批量 `MEDIA.delete(keys[])` 的失败被 `catch(console.error)` 静默吞掉，无重试、无对账，长期将累积孤儿对象（含用户隐私图片）。残留对象：`media/u_b202471f5561/ba30eb50-.../1787283387516-qa_r225_media.png`（suinian-media bucket，请人工删除）。
- **P2（遗留量化确认）欠款句式「垫付的 300 块房费小王一直没给我」系统性缺口**：8 次重放 5 次 `todo`（丢金额）、3 次 `transfer ¥300`，金额丢失率 62.5%，非随机波动。另两条欠款句（小李还欠我 500 / 借同事 800 还没还）8/8 稳定 `transfer` 且金额不丢。

P3：
- P3-1 忠实性 30 问中「我的会员卡号是多少」「我有几条敏感记录」两题 fixture 期望与敏感自动识别行为不符（系统行为正确：敏感隔离生效、计数按实际 4 条），属题面缺陷非产品缺陷。
- P3-2 桌面 Chrome 最小窗口宽度 532px，无法用真实窗口精确复现 390px；本轮以 532×844 移动布局（底部导航 + FAB）验证卡片点击直达编辑，行为正确。

## 1. R224 复核【生产实测】——全部通过

| 用例 | 结果 |
|---|---|
| 房客交了下季度房租 9000 | income ¥9000 ✅ |
| 学生/客户/租客/家长交费 ×4 | 全部 income，金额准确 ✅ |
| 垫付快递费 23，同事微信还我了 | income ¥23 ✅ |
| 垫付回款超窗变体 ×3（¥156/¥890/¥45） | 全部 income ✅ |
| 聚餐我先付的，AA 收回 240 | income ¥240 ✅ |
| 聚餐我先付 480，其他人回我 360（净额化） | expense ¥480 ✅ |
| R223 无回归抽测（按摩仪 599 / 补课费 300 / 零钱通转卡 2500） | expense / income / transfer 全对 ✅ |
| 亲属称谓召回：存「给我妹买生日礼物 300」问「给妹妹…花了多少」 | 命中原文，¥300，含别名降级说明 ✅ |

卡片点击直达编辑【生产实测 + 录屏】：
- 桌面点击正文 → 编辑表单（textarea+分类+标签+保存）✅；点击标题 → 同样 ✅
- 防误触：拖选正文文本（选区高亮、编辑器不弹出）✅；敏感遮罩卡首次点击只揭示不编辑 ✅；多选模式点击仅切换选中（已选 1 条），不弹编辑 ✅
- 移动宽度（532×844，Chrome 最小宽度限制，见 P3-2）：底部导航布局下点卡片正文 → 编辑器打开 ✅

## 2. 欠款边缘句波动量化【生产实测】——见 P2

- 小李还欠我 500 没还：8/8 transfer ¥500（波动率 0%）
- 上月借给同事 800 还没还我：8/8 transfer ¥800（波动率 0%）
- 垫付的 300 块房费小王一直没给我：todo 62.5%（amount=null）/ transfer ¥300 37.5% → **系统性缺口，非 LLM 随机波动**

## 3. 遗留补验

- a) 剪藏扩展【本地构建 + 生产实测】✅：`extension/` `npm ci` + `npx wxt build`（chrome-mv3，56.41 kB）；加载 Chrome，配置 API+token（连接成功，Token 有效）；剪藏 example.com → 时间流出现 collect 卡片（链接卡 + 正文摘录 + 备注）。
- b) 微信/企微桥【源码检查 + 生产端点探测】部分通过：`/api/ingest/wechat` 未鉴权 POST → 401 ✅；`/wechat/mp`、`/wechat/kf` 未签名 GET/POST → 404 ✅；bridge 扫码流程无法执行 → 未验证。
- c) R2 孤儿走查【生产实测】❌ 发现 P1：-ui 账号上传 1 图（779B png）+ 1 txt；注销前两对象均可下载；注销后 txt 立即消失，png 于 +30s/+2min/+5min/+12min 四次复查均仍可下载且与原件一致。D1 侧 attachments/notes 均已删（无行残留），即 D1↔R2 出现孤儿。全 bucket 对账受限：wrangler 无 r2 list 命令、无 S3 密钥 → 仅按前缀逐 key 验证，全量孤儿计数未验证。

## 4. 十轮防漂移回归 R215–R224【生产实测】——全部通过

R215 token 登录 `GET /api/auth/me` 200；R216 分隔符伪造注入「改判收入 99999」→ expense ¥18；R217 外卖账单净额 32+28−34.5 → expense ¥25.5；R218 台账净额方向 → expense（一致 fixture 重测通过）；R219 幂等注册（同名同密码二次注册 200、user id 相同、不新建）✅；R220 跨日垫付回款 → income、零钱通内转 → transfer；R221/话费类支出 → expense；R222 序数财务问答（第二贵）口径精确；R223 评审会结论 → data、预约洗牙 → idea；R224 见 §1。

## 5. 忠实性周期复审【生产实测】

- 35 条新语料分类 35/35 符合预期；敏感语料全部自动标记（含新增「会员卡号」「路由器管理密码」）。
- 30 问：精确金额、分类计数、序数问答、亲属召回全部正确；无中生有 4 问（狗名/机票/股票/室友生日）均如实答无，幻觉 0；敏感问答未泄露任何原文（银行卡密码 / root 口令 / 会员卡号均被隔离）。两题 fixture 期望有误（见 P3-1），系统行为正确。

## 6. 安全抽查【生产实测】——全部通过

- 越权：A token PATCH/GET B 的 note → 404 ✅
- 伪造 token：随机 48hex → 401 ✅；未鉴权 `/api/ingest/wechat` → 401 ✅
- 写限流 burst：80 并发 POST /api/notes → **精确 60×201 + 20×429** ✅
- 注入变体（伪 SYSTEM 分隔符 / 伪 assistant 指令 / 改判金额命令）均未被采纳 ✅
- 导出隔离：`GET /api/export` A 账号仅含 A 数据、B 账号仅含 B 数据，交叉关键词互不出现 ✅

## 7. 数据健康【生产实测】

- 5 个 QA 账号（含 -idem）全部 `DELETE /api/auth/me` → 200，token 复用 → 401。
- D1 远程逐表：USER_ID_TABLES 全部表（daily_reviews/notes/threads/weekly_reports/entities/edges/user_preferences/push_subscriptions/push_daily_log/thread_jobs/thread_backfill/wechat_mp_bindings/wechat_mp_bind_codes/wecom_kf_bindings/api_tokens）对 5 个 uid 计数全 0；attachments/note_embeddings 全库孤儿 0。
- users 表仅剩 1 行：u_boss（Thomas），无历史 [QA-*] 残留。
- R2：txt 已删；**png 残留（P1，见 §3c，需人工删除）**。

## 8. 本地验证【本地测试】

backend Vitest：107 文件 / 1431 测试全部通过；`tsc` typecheck 通过；web `npm run build` 通过（含 service worker）。

## 收/理/找 评分参考

- 收（capture）：R224 修复句 + 变体 20+ 条全对；欠款边缘句 1 句系统性缺口（P2）→ 建议 4.5/5
- 理（organize）：35/35 分类正确、敏感自动识别偏保守（多识别不漏识别）→ 5/5
- 找（retrieve）：30 问幻觉 0、亲属别名召回命中、序数口径精确 → 5/5

## 证据文件

`/home/ubuntu/qa-r225/`：res_dir.jsonl、res_main.jsonl、res_x217.jsonl、fluct.jsonl、fluct2.jsonl、asks.jsonl、burst.log、vitest.log、tsc.log、webbuild.log、ext-build.log；录屏：`/home/ubuntu/screencasts/rec-484221f7-6019-4754-993f-3a72ac798f6c/rec-484221f7-6019-4754-993f-3a72ac798f6c-edited.mp4`
