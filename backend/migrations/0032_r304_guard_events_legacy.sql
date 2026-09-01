-- R304 P1（audit-r303 §10）：guard_events 旧口径行（R298–R301 的
-- classifierUnavailable / veto / isolated，按**次数**计，出现过
-- isolated=503 > total_requests=77 的量纲错乱）与 R302 起的新口径
-- （*_requests，按请求计）混在同表，跨日期聚合会把两种量纲加在一起。
-- 处置：旧 kind 统一加 legacy: 前缀标记（保留数据，不删除），任何按
-- kind 聚合的查询天然不再混入旧口径。
UPDATE guard_events
SET kind = 'legacy:' || kind
WHERE kind IN ('classifierUnavailable', 'veto', 'isolated');
