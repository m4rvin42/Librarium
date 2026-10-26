CREATE TABLE IF NOT EXISTS book_images (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('back_cover')),
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  created_at TEXT NOT NULL,
  UNIQUE(book_id, kind)
);

CREATE INDEX IF NOT EXISTS book_images_book_idx ON book_images(book_id, kind);
