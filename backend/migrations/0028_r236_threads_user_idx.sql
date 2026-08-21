-- R236 P2-2（audit-r235 §5：UI 注销请求偶发 ~60s 超时）：注销级联里
-- DELETE FROM threads WHERE user_id = ? 是唯一没有 user_id 索引的表，
-- 全表扫描随全站线程数线性变慢。与其余 user_id 表同口径补索引。
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id);
