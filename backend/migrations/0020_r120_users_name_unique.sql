-- R120 P1-2: 并发注册可产生同名多账号——数据库级唯一约束是唯一可靠的
-- 原子检查（应用层 SELECT→INSERT 存在竞态窗口）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_unique ON users(name);
