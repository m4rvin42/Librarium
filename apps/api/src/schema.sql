PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS books (
 id TEXT PRIMARY KEY, isbn10 TEXT UNIQUE, isbn13 TEXT UNIQUE, title TEXT NOT NULL, subtitle TEXT,
 publisher TEXT, publication_date TEXT, language TEXT, page_count INTEGER, description TEXT,
 cover_url TEXT, local_cover TEXT, edition_format TEXT, ownership_status TEXT NOT NULL DEFAULT 'owned',
 reading_status TEXT NOT NULL DEFAULT 'unread', rating INTEGER, notes TEXT, metadata_source TEXT,
 metadata_source_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS books_title_idx ON books(title);
CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS book_authors (book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES authors(id), position INTEGER NOT NULL, PRIMARY KEY(book_id,author_id));
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS book_categories (book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, category_id TEXT NOT NULL REFERENCES categories(id), PRIMARY KEY(book_id,category_id));
CREATE TABLE IF NOT EXISTS reading_sessions (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, started_date TEXT, finished_date TEXT, rating INTEGER, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, source_metadata TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_images (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE, filename TEXT NOT NULL, mime_type TEXT NOT NULL, path TEXT NOT NULL, width INTEGER, height INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_candidates (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE, title TEXT, author TEXT, isbn10 TEXT, isbn13 TEXT, confidence REAL NOT NULL, evidence TEXT NOT NULL, metadata TEXT, alternatives TEXT, review_status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_cache (cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,datetime('now'));
