import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const books = sqliteTable('books', {
  id: text().primaryKey(),
  isbn10: text().unique(),
  isbn13: text().unique(),
  title: text().notNull(),
  subtitle: text(),
  publisher: text(),
  publicationDate: text('publication_date'),
  language: text(),
  pageCount: integer('page_count'),
  description: text(),
  coverUrl: text('cover_url'),
  localCover: text('local_cover'),
  editionFormat: text('edition_format'),
  ownershipStatus: text('ownership_status').notNull(),
  readingStatus: text('reading_status').notNull(),
  rating: integer(),
  notes: text(),
  metadataSource: text('metadata_source'),
  metadataSourceId: text('metadata_source_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const authors = sqliteTable('authors', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
});
export const bookAuthors = sqliteTable(
  'book_authors',
  {
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => authors.id),
    position: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.authorId] })],
);
export const categories = sqliteTable('categories', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
});
export const bookCategories = sqliteTable(
  'book_categories',
  {
    bookId: text('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.categoryId] })],
);
export const readingSessions = sqliteTable('reading_sessions', {
  id: text().primaryKey(),
  bookId: text('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  startedDate: text('started_date'),
  finishedDate: text('finished_date'),
  rating: integer(),
  notes: text(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const importBatches = sqliteTable('import_batches', {
  id: text().primaryKey(),
  kind: text().notNull(),
  status: text().notNull(),
  sourceMetadata: text('source_metadata'),
  error: text(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const importCandidates = sqliteTable('import_candidates', {
  id: text().primaryKey(),
  batchId: text('batch_id')
    .notNull()
    .references(() => importBatches.id, { onDelete: 'cascade' }),
  title: text(),
  author: text(),
  isbn10: text(),
  isbn13: text(),
  confidence: real().notNull(),
  evidence: text().notNull(),
  metadata: text(),
  alternatives: text(),
  reviewStatus: text('review_status').notNull(),
  error: text(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const appSettings = sqliteTable('app_settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const coverDrafts = sqliteTable('cover_drafts', {
  id: text().primaryKey(),
  bookId: text('book_id')
    .notNull()
    .references(() => books.id, { onDelete: 'cascade' }),
  sourcePath: text('source_path').notNull(),
  width: integer().notNull(),
  height: integer().notNull(),
  corners: text().notNull(),
  status: text().notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
