CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 1000000000),
  password_hash TEXT,
  edit_password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  last_downloaded_at TEXT
);

CREATE INDEX IF NOT EXISTS files_expires_at_idx ON files (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS multipart_uploads (
  file_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 100000000 AND expected_size <= 1000000000),
  password_hash TEXT,
  edit_password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS multipart_uploads_expires_at_idx
  ON multipart_uploads (expires_at);
