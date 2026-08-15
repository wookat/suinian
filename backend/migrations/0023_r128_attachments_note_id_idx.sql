-- R128 P2-1: attachments 按 note_id 查询走索引（媒体下载/重试/删除热路径此前全表扫）
CREATE INDEX IF NOT EXISTS idx_attachments_note_id ON attachments(note_id);
