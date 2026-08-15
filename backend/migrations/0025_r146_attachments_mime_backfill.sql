-- R146 P2-1: 存量 octet-stream 附件按 r2_key 扩展名回填 mime（仅已知类型，未知保持不变）
UPDATE attachments SET mime = CASE
  WHEN lower(r2_key) LIKE '%.m4a' THEN 'audio/mp4'
  WHEN lower(r2_key) LIKE '%.aac' THEN 'audio/aac'
  WHEN lower(r2_key) LIKE '%.mp3' THEN 'audio/mpeg'
  WHEN lower(r2_key) LIKE '%.amr' THEN 'audio/amr'
  WHEN lower(r2_key) LIKE '%.wav' THEN 'audio/wav'
  WHEN lower(r2_key) LIKE '%.ogg' THEN 'audio/ogg'
  WHEN lower(r2_key) LIKE '%.oga' THEN 'audio/ogg'
  WHEN lower(r2_key) LIKE '%.opus' THEN 'audio/ogg'
  WHEN lower(r2_key) LIKE '%.flac' THEN 'audio/flac'
  WHEN lower(r2_key) LIKE '%.webm' THEN 'audio/webm'
  WHEN lower(r2_key) LIKE '%.jpg' THEN 'image/jpeg'
  WHEN lower(r2_key) LIKE '%.jpeg' THEN 'image/jpeg'
  WHEN lower(r2_key) LIKE '%.png' THEN 'image/png'
  WHEN lower(r2_key) LIKE '%.gif' THEN 'image/gif'
  WHEN lower(r2_key) LIKE '%.webp' THEN 'image/webp'
  WHEN lower(r2_key) LIKE '%.bmp' THEN 'image/bmp'
  WHEN lower(r2_key) LIKE '%.heic' THEN 'image/heic'
  WHEN lower(r2_key) LIKE '%.mp4' THEN 'video/mp4'
  WHEN lower(r2_key) LIKE '%.mov' THEN 'video/quicktime'
  WHEN lower(r2_key) LIKE '%.pdf' THEN 'application/pdf'
  WHEN lower(r2_key) LIKE '%.txt' THEN 'text/plain'
  WHEN lower(r2_key) LIKE '%.md' THEN 'text/markdown'
  ELSE mime
END
WHERE (mime IS NULL OR mime = '' OR mime = 'application/octet-stream');
