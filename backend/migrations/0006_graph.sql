-- R20: knowledge graph layer (entities + edges)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,                -- person|project|concept|product|org|place|other
  aliases TEXT NOT NULL DEFAULT '[]',-- JSON array of alternate names
  note_count INTEGER NOT NULL DEFAULT 0,
  vector TEXT,                       -- bge-m3 name embedding for alias merging
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_user_name ON entities(user_id, name);
CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities(user_id, type);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  src_type TEXT NOT NULL,            -- 'note'|'entity'
  src_id TEXT NOT NULL,
  dst_type TEXT NOT NULL,            -- 'note'|'entity'
  dst_id TEXT NOT NULL,
  relation TEXT NOT NULL,            -- mentions|supports|premise_of|belongs_to|todo_of|relates_to
  confidence REAL NOT NULL DEFAULT 1.0,
  note_id TEXT,                      -- evidence note the relation was extracted from
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edges_user_src ON edges(user_id, src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_edges_user_dst ON edges(user_id, dst_type, dst_id);
CREATE INDEX IF NOT EXISTS idx_edges_note ON edges(note_id);
