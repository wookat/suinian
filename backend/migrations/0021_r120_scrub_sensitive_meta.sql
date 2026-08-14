-- R120 P1-1 存量修复：历史敏感笔记的 AI 派生 title/tags 可能把秘密值明文带出
-- （content 已加密但 title 形如「xx密码是<真实值>」）。SQL 无法逐词甄别，
-- 按加密同口径从严处理：title 置空、tags 清空。原文仍在 content_enc，
-- 用户解密查看不受影响。
UPDATE notes SET title = NULL WHERE is_sensitive = 1 AND title IS NOT NULL;
UPDATE notes SET tags = '[]' WHERE is_sensitive = 1 AND tags != '[]';
