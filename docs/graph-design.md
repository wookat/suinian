# 碎念知识图谱层设计（R20）

> 目标：给笔记加一层轻量知识图谱，让「线索」从纯向量相似度分桶升级为图连通性聚类，让问答（GraphRAG）能沿关系把强关联碎片带入上下文。

## 1. 调研：GraphRAG 在个人笔记场景的轻量实现模式

- **微软 GraphRAG**：LLM 抽实体/关系 → 建图 → Leiden 社区检测 → 逐社区生成摘要，查询时全局（社区摘要）+ 局部（实体邻域）两种模式。效果好但管线重（多轮 LLM、社区摘要成本高），面向大语料。个人笔记场景可借鉴的核心是「实体/关系抽取 + 实体邻域扩展」，社区摘要可以用已有的「线索 summary」替代。
- **LightRAG（HKUDS）**：简化为一次 LLM 抽取（实体+关系+关键词），图存储可插拔（默认 NetworkX/nano-vectordb），查询时 low-level（实体邻域）/high-level（关系主题）双通道召回。证明了**单次抽取 + 1 跳邻域扩展**在中小语料上即可拿到 GraphRAG 大部分收益。
- **个人笔记的特殊性**：单用户笔记量小（百~千条）、碎片短、增量到达。不需要社区检测和批量索引；需要的是**增量抽取**（新笔记到达即抽）、**实体归一**（同名/别名跨周合并）与**严格的用户隔离**。

结论：采用「LightRAG 式单次抽取 + 实体归一 + 1 跳邻域扩展」的最小图谱层。

## 2. 路线对比：A（D1 自建图表，纯 Workers） vs B（VPS 开源图谱服务）

| 维度 | A：D1 建 entities/edges 表 + Workers 内抽取/查询 | B：国内 VPS docker 跑 LightRAG / Neo4j 等 + Worker HTTP 调用 |
|---|---|---|
| 效果上限 | 1 跳/2 跳邻域、共享实体连通分量在 SQL 里即可；个人量级（<5k 笔记、<2 万边）完全够。多跳图算法（PageRank、社区检测）不便 | 完整图算法与 LightRAG 现成双通道检索，上限更高 |
| 复杂度 | 无新基础设施；一次 D1 迁移 + ~400 行 TS；与现有 waitUntil/cron 管线同构 | 新增服务：部署、token 鉴权、内网穿透/公网暴露、监控、备份、双写一致性（D1 笔记 ↔ 图库） |
| 自部署友好度 | 不变：`wrangler d1 migrations apply` 即完成，保持「3 分钟自部署」承诺 | 自部署用户需额外一台服务器 + docker-compose；文档与支持成本显著上升 |
| 实测资源约束 | 无 | 现有 VPS（49.232.x.x）实测 **1.7GB 内存，已用 879MB + swap 已用 1.5GB/2GB**，跑着 12 个容器和 suinian-bridge。Neo4j 官方最低建议 1GB+ 堆；LightRAG 服务 + 嵌入缓存常驻数百 MB。上去大概率触发 OOM/换页，**直接威胁 bridge 稳定性**（老板明确要求不影响 bridge） |
| 数据一致性/隔离 | 与 notes 同库同事务域，user_id 外键隔离，删号级联简单 | 跨系统删除/脱敏需双写协议；敏感笔记不出 CF 边界的承诺更难审计 |

**选定：路线 A**。理由：个人量级下 A 的效果上限足够本轮目标（图连通线索 + 1 跳 GraphRAG）；B 的效果增量主要在多跳/社区级分析，而当前 VPS 内存实测已经吃紧（swap 用掉 3/4），强上图库服务违反「别影响 bridge」的硬约束。**升级路径**：schema 设计成图库可平移（entities/edges 即属性图三元组），后续笔记量或分析需求上来后，可在新 VPS 用 docker-compose 起 LightRAG/Memgraph，把 D1 图表全量导出灌入即可，Worker 侧仅需把图查询函数换成 HTTP 调用（已在 `graph.ts` 中集中收口）。

## 3. Schema（D1，migration 0006）

```sql
entities(
  id TEXT PK,            -- uuid
  user_id TEXT NOT NULL, -- 严格隔离
  name TEXT NOT NULL,    -- 规范名
  type TEXT NOT NULL,    -- person|project|concept|product|org|place|other
  aliases TEXT '[]',     -- JSON 别名数组（归一合并时累积）
  note_count INTEGER,    -- 提及计数（去重后）
  created_at, updated_at
)
edges(
  id TEXT PK,
  user_id TEXT NOT NULL,
  src_type TEXT,         -- 'note'|'entity'
  src_id TEXT,
  dst_type TEXT,         -- 'note'|'entity'
  dst_id TEXT,
  relation TEXT,         -- mentions|supports|premise_of|belongs_to|todo_of|relates_to
  confidence REAL,       -- 0~1，LLM 自评
  note_id TEXT,          -- 证据笔记（关系来自哪条笔记的抽取）
  created_at
)
```

两类边：
- `note --mentions--> entity`：笔记提及实体（图连通与 1 跳扩展的主干）。
- `entity --relation--> entity`：实体间语义关系（支撑/前提/属于/待办于），证据 note_id 可回溯。

敏感笔记（is_sensitive）**不进入图谱**（与不进向量库同一原则）。

## 4. 抽取管线

1. **触发**：笔记分拣（triage）完成后，在同一 `waitUntil` 链上调用 `extractGraph(env, note)`（clusterNote 之前，让聚类能用上图信号）。失败静默，绝不阻塞入库。
2. **抽取 prompt**（chatComplete 统一入口，严格 JSON）：输入笔记标题+内容（+链接摘要），输出
   `{"entities":[{"name","type","aliases":[]}],"relations":[{"src","dst","relation","confidence"}]}`，实体 ≤6、关系 ≤4，名字必须是笔记中出现或明确指代的具体事物，禁止泛化词（"想法/问题/东西"）。
3. **实体归一**：对每个抽取实体，按 user_id 查同名（不区分大小写）或别名命中 → 复用；未命中时用 bge-m3 向量比对现有同类型实体名，cos ≥ 0.92 判定同一实体并把新名字并入 aliases；否则新建。
4. **建边**：note→entity 建 `mentions` 边（去重）；实体间关系解析 src/dst 到归一后的实体建边，confidence 保留。
5. **存量补抽（cron）**：复用 10 分钟 cron，挑「无 graph_extracted 标记且非敏感」的笔记每轮抽 3 条（LLM 限速），notes.meta 里记 `graph_extracted_at`。

## 5. 查询模式

- **线索聚类（图优先，相似度兜底）**：新 idea 笔记先看图——与最近 90 天某条已入线索的 idea 笔记**共享 ≥2 个实体**（或共享 1 个实体且实体间有强关系边 confidence ≥0.6）→ 直接入该线索；图无信号时回落到原向量相似度 + DeepSeek 确认逻辑。线索详情新增「实体与关系脉络」：该线索笔记 mentions 的实体按提及数排序 + 涉及的实体间关系（文字化：`实体A —支撑→ 实体B（来自某碎片）`）。
- **GraphRAG 问答**：/api/ask 混合召回（关键词+语义）命中笔记后，取这些笔记 mentions 的实体，沿图扩 1 跳找到其他 mentions 同实体的笔记（按共享实体数 × 边置信度排序，最多补 5 条），标注「图谱关联」进入上下文；prompt 附实体关系三元组，让回答能说明关联依据。

## 6. 增量更新策略

- 新笔记：triage 后即抽（waitUntil）。
- 编辑笔记：PATCH content 时删除旧 note 边并重抽。
- 删除笔记：级联删 note 边；实体 note_count 归零则删实体及其关系边。
- 转敏感：同删除（图中彻底移除）。
- 存量：cron 每 10 分钟补抽 3 条，直至清空。
