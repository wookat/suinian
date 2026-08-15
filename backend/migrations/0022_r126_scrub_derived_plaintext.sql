-- R126 P1-1 存量修复：敏感笔记的派生明文（语音转写/图片描述/文件摘录/链接摘录、
-- 链接标题/AI 摘要）曾原样留库并进导出/备份，统一洗净。
UPDATE notes
SET meta = json_remove(meta, '$.raw_transcript', '$.image_description', '$.file_excerpt', '$.link_excerpt')
WHERE is_sensitive = 1 AND meta IS NOT NULL;

UPDATE notes
SET url_title = NULL, url_summary = NULL, url_titles = NULL
WHERE is_sensitive = 1 AND (url_title IS NOT NULL OR url_summary IS NOT NULL OR url_titles IS NOT NULL);

-- R126 P1-2 存量排查：skip_triage 入库的笔记（manual_override.category 且非敏感）
-- 曾只走高精度检测、永不复判——标 needs_retriage 交 cron 复判敏感与否
-- （分类/标签已标 manual，复判不会改动它们）。
UPDATE notes
SET meta = json_set(coalesce(meta, '{}'), '$.needs_retriage', json('true'))
WHERE is_sensitive = 0 AND deleted_at IS NULL
  AND meta IS NOT NULL
  AND json_extract(meta, '$.manual_override.category') = 1
  AND json_extract(meta, '$.needs_retriage') IS NULL;
