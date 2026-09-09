CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS api_credentials_active_idx
  ON api_credentials(token_hash, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  credential_id TEXT REFERENCES api_credentials(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_credential_idx ON audit_events(credential_id, created_at DESC);

CREATE TABLE IF NOT EXISTS confirmation_intents (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES api_credentials(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS confirmation_intents_active_idx
  ON confirmation_intents(credential_id, expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  credential_id TEXT NOT NULL REFERENCES api_credentials(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, key, method, path)
);

CREATE INDEX IF NOT EXISTS idempotency_records_created_idx ON idempotency_records(created_at);

CREATE TABLE IF NOT EXISTS book_trash (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  deleted_at TEXT NOT NULL,
  deleted_by_credential_id TEXT REFERENCES api_credentials(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS book_trash_deleted_idx ON book_trash(deleted_at DESC);

CREATE TABLE IF NOT EXISTS book_search_documents (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS book_search_fts USING fts5(
  book_id UNINDEXED,
  title,
  subtitle,
  authors,
  publisher,
  description,
  categories,
  isbn,
  notes,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT OR REPLACE INTO book_search_documents(
  book_id,title,subtitle,authors,publisher,description,categories,isbn,notes
)
SELECT
  b.id,
  b.title,
  COALESCE(b.subtitle,''),
  COALESCE((SELECT group_concat(a.name,' ') FROM book_authors ba JOIN authors a ON a.id=ba.author_id WHERE ba.book_id=b.id),''),
  COALESCE(b.publisher,''),
  COALESCE(b.description,''),
  COALESCE((SELECT group_concat(c.name,' ') FROM book_categories bc JOIN categories c ON c.id=bc.category_id WHERE bc.book_id=b.id),''),
  trim(COALESCE(b.isbn10,'') || ' ' || COALESCE(b.isbn13,'')),
  COALESCE(b.notes,'')
FROM books b;

DELETE FROM book_search_fts;
INSERT INTO book_search_fts SELECT book_id,title,subtitle,authors,publisher,description,categories,isbn,notes
FROM book_search_documents;
