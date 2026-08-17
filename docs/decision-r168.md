# R168 修改轮决策记录（落实 audit-r167）

基线：main @ R167 审查报告 #189 合并后。审改分离的"改"方，逐项系统性权衡后统一实施；原则：高内聚低耦合、如无必要勿增实体。

## 1. P1-1 财务比较类问答漏项算错：并入既有确定性聚合路由（✅ 已修）

R167 生产复现：「这个月我是赚得多还是花得多」未被 `financeAggIntent` 识别，落到 LLM 对截断召回
自由算术，总支出漏项（答 8119.5，实际 10618.5）。

方案权衡：比较 = 同一 `financeStats` 口径下两个数（收入 vs 支出，或本期 vs 上期）的确定性对比，
不需要任何新实体。与 R110/R148 同一架构，在 `/api/ask` 的财务精确路由链上新增两个规则意图，
均在普通召回之前短路：

1. **同期收支比较** `financeCompareIntent`（`backend/src/ask.ts`）：识别「赚得多还是花得多 /
   收入和支出差多少 / 入不敷出 / 是赚是亏 / 哪个多」等措辞家族；时间窗复用 `parseTimeRange`，
   SQL 圈定财务笔记后 `financeStats` 精确聚合，`buildFinanceCompareAnswer` 按币种分别给
   收入/支出/差值与结论（不同币种绝不直接相加比较），未识别金额如实披露，尾注与周报/月报同口径。
2. **环比/跨期比较** `financeMomIntent`：识别「环比 / 比上个月多还是少 / 这周比上周」等明确
   跨期措辞（从严：「上个月结余多少」这类单期合计绝不落入），本期与上期两窗各自精确聚合后
   `buildFinanceMomAnswer` 确定性对比。
3. 护栏与既有路由一致：`FACT_QUERY_RE` 闸门（摘除「哪个多/谁多」比较措辞后判定）保证
   「买机械键盘花了多少钱」「买跑鞋花得比机械键盘多吗」等单项/单笔问题不被劫持；改写问题
   仅在原句无财务词时才参与意图判定（与 `financeAggIntent` 的 R114 教训同口径）。

eval 新增 q92–q97（比较/差值/入不敷出/环比措辞变体 + 单笔反例护栏）；单测覆盖意图识别、
多币种分列、未知金额披露、空记录不编数。

## 2. P2-1 GBK CSV 乱码：解码失败启发式回退（✅ 已修）

`extractFileText` 原来无条件 `TextDecoder("utf-8")`（替换模式），GBK 内容变 mojibake。
新增 `decodeTextBytes`（`backend/src/files.ts`）：UTF-16 BOM → 严格 UTF-8（`fatal:true`，
带 BOM 剥离）→ 失败则 GBK（Workers 运行时 TextDecoder 支持 gbk 标签）→ 再失败回替换模式
UTF-8。txt/md/csv 三个文本路径统一走该函数。原始上传文件本就原样存 R2，解码只影响提取文本，
失败面不变。不引入编码探测库——BOM + 严格解码失败回退已覆盖「中文 Excel 导出 GBK CSV」
这一高频场景，如无必要勿增实体。

## 3. P2-2 伪装扩展名误解析：内容嗅探优先（✅ 已修）

`detectFileKind` 原来扩展名命中即返回。新增 `sniffFileKind`：`%PDF-` → pdf；ZIP magic
`PK\x03\x04` → 查内部路径 `xl/workbook.xml`（xlsx）/`word/document.xml`（docx）。
判定顺序改为 内容嗅探 → 扩展名 → MIME，三个调用点（ingest/refetch/retry）均传入字节。
只做高置信度正向嗅探，嗅不出仍回落扩展名——不误伤纯文本类（csv/txt/md 无可靠 magic）。

## 4. P2-3 大文件摘要行数失实：解析器确定性统计（✅ 已修）

原来让 LLM 对截断 excerpt 自数行数（6000 行 CSV 答 231 行）。改为解析器统计行数注入
摘要 prompt（「结构统计（解析器精确统计，行数/条数以此为准）」+ 禁止模型自数），并对
csv/xlsx 在存储摘要后追加确定性尾注「（全文共 N 行）」——即使模型不听话，存量数字也正确。
不新增元数据实体/列，结构数字随摘要文本存储，与现状一致。

## 5. P2-4 标签重命名/删除不覆盖回收站：去掉 deleted_at 过滤（✅ 已修）

`retagUser` 查询原带 `deleted_at IS NULL`，恢复笔记后出现全局改名的旧标签。改为覆盖全部
行（含软删），并把逐条 UPDATE 改为 `env.DB.batch` 单批原子提交（与账号注销级联同一模式），
中途失败不会留下半改状态。语义上「全局重命名/删除」本就应含回收站——恢复是常态操作。

## 6. P2-5 四个无限流端点：并入既有 D1 限流（✅ 已修）

与既有 `checkRateLimit` 中间件统一，不另起炉灶：

- `POST /api/tags/rename`、`POST /api/tags/delete`：并入既有 `batch_write` 桶
  （30/min/user）——与批量打标签同为「批量写」性质，共享桶防组合刷写。
- `POST /api/notes/:id/refetch-link`、`POST /api/notes/:id/retry-media`：新共享桶
  `media_retry`（10/min/user）——两者同为「重抓外部资源/AI 重提取」的贵操作，
  正常用户手动重试不会超过 10 次/分钟。

单测证明超额请求返回 429（含 retryable 提示文案，与既有限流端点一致）。

## 7. 设计建议逐条评估

1. **「开会」单词级输入的轻确认（不改，附论证）**：分拣管线不输出置信度（已核 `ai.ts`
   triage schema，无 confidence 字段），"低置信时轻确认"需要新增 置信度字段 + 卡片一次性
   状态（dismissal 持久化）两个实体，收益面是 50 条语料中 1 条单词级输入，且既有纠正路径
   已经很短（卡片 ⋯ → 编辑 → 分类下拉，两步）。启发式替代（"短单词即弹确认"）会对正常短
   想法产生持续误扰。判定：成本/干扰 > 收益，如无必要勿增实体，不改。
2. **q12 关键词计数路由不稳定（✅ 部分实施 + 论证边界）**：路由不稳定已修——
   `topicCountIntent` 新增「几条跟 X 有关/相关」措辞家族，q12 类问法现在第一跳即走
   确定性计数，不再先答"没找到"。同义词展开（健身→运动/锻炼）论证不改：计数答案承诺
   「数据库精确统计（关键词匹配口径）」，注入同义词典会让"精确"名不副实且引入需长期维护的
   词表实体；答案已如实标注口径并提示换关键词，语义召回与关键词计数分层是 R132 的既定架构。
3. **移动端 Lighthouse inspector-issues（已实测，无可修项）**：本轮对生产
   https://suinian.zalize.com 桌面+移动各跑一次 Lighthouse best-practices，
   `inspector-issues` 均为满分（无 Issues 面板告警），R167 的 96 分告警未复现——
   与审方推测一致（第三方 header/瞬态告警类），当前无可修对象，持续观察。
4. **隐藏 file input 无可访问名（✅ 已修）**：三处隐藏 `<input type="file">`
   （速记上传、设置导入、设置恢复）加 `aria-hidden="true"` + `tabIndex={-1}` 移出
   AX 树与 Tab 序；同功能可见按钮本就有中文可访问名，读屏语义不变。

## 8. 残留清理

上轮遗留 `[QA-R165]-timeout`（u_670cc2eb3462，3 条笔记）：经生产账号注销级联
（`deleteUserData` + R2/Vectorize 清理的同一代码路径）删除，逐表（USER_ID_TABLES +
NOTE_ID_TABLES + auth_rate_limits + R2 前缀）确认零残留。结果见 PR 汇报。
