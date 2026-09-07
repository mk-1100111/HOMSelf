PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO settings VALUES ('schema_version','1'), ('paused','1'), ('batch_active','0'), ('batch_items','[]');
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  manager_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS request_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  material_code TEXT NOT NULL,
  material_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0 AND quantity <= 100000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN
    ('pending','approved','claimed','submitting','completed','needs_review','cancelled')),
  attempt_id TEXT,
  updated_at INTEGER NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  UNIQUE(request_id, material_code)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_item ON request_items((1))
  WHERE status IN ('claimed','submitting');
CREATE INDEX IF NOT EXISTS idx_items_status_updated ON request_items(status,updated_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  item_id TEXT REFERENCES request_items(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id,id);
CREATE TABLE IF NOT EXISTS worker_status (
  id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL, mode TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS homs_receipts (
  transaction_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES request_items(id),
  evidence TEXT NOT NULL,
  verified_at INTEGER NOT NULL
) STRICT;
UPDATE settings SET value='2' WHERE key='schema_version';
PRAGMA user_version = 2;
