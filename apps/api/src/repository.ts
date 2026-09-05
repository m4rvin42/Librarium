import { BookInputType, parseIsbn } from '@librarium/shared';
import { db, id, now } from './db.js';

type Row = Record<string, any>;

function hydrate(row: Row) {
  const authors = db
    .prepare(
      'SELECT a.name FROM authors a JOIN book_authors ba ON a.id=ba.author_id WHERE ba.book_id=? ORDER BY ba.position',
    )
    .all(row.id) as Row[];
  const categories = db
    .prepare(
      'SELECT c.name FROM categories c JOIN book_categories bc ON c.id=bc.category_id WHERE bc.book_id=? ORDER BY c.name',
    )
    .all(row.id) as Row[];
  return {
    id: row.id,
    isbn10: row.isbn10,
    isbn13: row.isbn13,
    title: row.title,
    subtitle: row.subtitle,
    authors: authors.map((x) => x.name),
    publisher: row.publisher,
    publicationDate: row.publication_date,
    language: row.language,
    pageCount: row.page_count,
    description: row.description,
    categories: categories.map((x) => x.name),
    coverUrl: row.cover_url,
    localCover: row.local_cover,
    editionFormat: row.edition_format,
    ownershipStatus: row.ownership_status,
    readingStatus: row.reading_status,
    rating: row.rating,
    notes: row.notes,
    metadataSource: row.metadata_source,
    metadataSourceId: row.metadata_source_id,
    dateAdded: row.created_at,
    dateUpdated: row.updated_at,
    readingHistory: db
      .prepare(
        'SELECT * FROM reading_sessions WHERE book_id=? ORDER BY COALESCE(finished_date,started_date,created_at) DESC',
      )
      .all(row.id),
  };
}

function setRelations(bookId: string, authors: string[], categories: string[]) {
  db.prepare('DELETE FROM book_authors WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM book_categories WHERE book_id=?').run(bookId);
  authors.forEach((name, position) => {
    const existing = db.prepare('SELECT id FROM authors WHERE name=? COLLATE NOCASE').get(name) as
      Row | undefined;
    const authorId = existing?.id ?? id();
    if (!existing) db.prepare('INSERT INTO authors(id,name) VALUES(?,?)').run(authorId, name);
    db.prepare('INSERT INTO book_authors(book_id,author_id,position) VALUES(?,?,?)').run(
      bookId,
      authorId,
      position,
    );
  });
  categories.forEach((name) => {
    const existing = db
      .prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE')
      .get(name) as Row | undefined;
    const categoryId = existing?.id ?? id();
    if (!existing) db.prepare('INSERT INTO categories(id,name) VALUES(?,?)').run(categoryId, name);
    db.prepare('INSERT INTO book_categories(book_id,category_id) VALUES(?,?)').run(
      bookId,
      categoryId,
    );
  });
}

export function getBook(bookId: string) {
  const row = db.prepare('SELECT * FROM books WHERE id=?').get(bookId) as Row | undefined;
  return row ? hydrate(row) : null;
}

export function findBookByIsbn(isbn: string) {
  const parsed = parseIsbn(isbn);
  const row = db
    .prepare('SELECT * FROM books WHERE isbn13=? OR isbn10=?')
    .get(parsed.isbn13, parsed.isbn10) as Row | undefined;
  return row ? hydrate(row) : null;
}

export function createBook(input: BookInputType) {
  return db.transaction(() => {
    const data = {
      isbn10: null,
      isbn13: null,
      subtitle: null,
      publisher: null,
      publicationDate: null,
      language: null,
      pageCount: null,
      description: null,
      coverUrl: null,
      editionFormat: null,
      rating: null,
      notes: null,
      metadataSource: null,
      metadataSourceId: null,
      ...input,
    } as any;
    let isbn10 = data.isbn10,
      isbn13 = data.isbn13;
    if (isbn10 || isbn13) ({ isbn10, isbn13 } = parseIsbn(isbn13 || isbn10!));
    const bookId = id(),
      timestamp = now();
    db.prepare(
      `INSERT INTO books
      (id,isbn10,isbn13,title,subtitle,publisher,publication_date,language,page_count,description,cover_url,edition_format,ownership_status,reading_status,rating,notes,metadata_source,metadata_source_id,created_at,updated_at)
      VALUES (@id,@isbn10,@isbn13,@title,@subtitle,@publisher,@publicationDate,@language,@pageCount,@description,@coverUrl,@editionFormat,@ownershipStatus,@readingStatus,@rating,@notes,@metadataSource,@metadataSourceId,@created,@updated)`,
    ).run({ ...data, id: bookId, isbn10, isbn13, created: timestamp, updated: timestamp });
    setRelations(bookId, data.authors, data.categories);
    return getBook(bookId)!;
  })();
}

export function updateBook(bookId: string, patch: Record<string, any>) {
  return db.transaction(() => {
    const current = getBook(bookId);
    if (!current) return null;
    const book = { ...current, ...patch };
    if (book.isbn10 || book.isbn13) Object.assign(book, parseIsbn(book.isbn13 || book.isbn10));
    db.prepare(
      `UPDATE books SET isbn10=@isbn10,isbn13=@isbn13,title=@title,subtitle=@subtitle,publisher=@publisher,
      publication_date=@publicationDate,language=@language,page_count=@pageCount,description=@description,
      cover_url=@coverUrl,edition_format=@editionFormat,ownership_status=@ownershipStatus,reading_status=@readingStatus,
      rating=@rating,notes=@notes,metadata_source=@metadataSource,metadata_source_id=@metadataSourceId,updated_at=@updated WHERE id=@id`,
    ).run({ ...book, updated: now() });
    setRelations(bookId, book.authors, book.categories);
    return getBook(bookId);
  })();
}

export const deleteBook = (bookId: string) =>
  db.prepare('DELETE FROM books WHERE id=?').run(bookId).changes > 0;

export function listBooks(query: Record<string, any>) {
  const clauses: string[] = [],
    args: unknown[] = [];
  if (query.search) {
    clauses.push(
      '(b.title LIKE ? OR b.isbn10 LIKE ? OR b.isbn13 LIKE ? OR EXISTS(SELECT 1 FROM book_authors ba JOIN authors a ON a.id=ba.author_id WHERE ba.book_id=b.id AND a.name LIKE ?))',
    );
    args.push(...Array(4).fill(`%${query.search}%`));
  }
  for (const [key, column] of [
    ['readingStatus', 'reading_status'],
    ['ownershipStatus', 'ownership_status'],
  ] as const) {
    if (query[key]) {
      clauses.push(`b.${column}=?`);
      args.push(query[key]);
    }
  }
  if (query.category) {
    clauses.push(
      'EXISTS(SELECT 1 FROM book_categories bc JOIN categories c ON c.id=bc.category_id WHERE bc.book_id=b.id AND c.name=?)',
    );
    args.push(query.category);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sorts: Record<string, string> = {
    title: 'title',
    dateAdded: 'created_at',
    dateUpdated: 'updated_at',
    rating: 'rating',
  };
  const sort = sorts[query.sort] ?? 'created_at',
    order = query.order === 'asc' ? 'ASC' : 'DESC';
  const page = Math.max(1, Number(query.page) || 1),
    limit = Math.min(100, Math.max(1, Number(query.limit) || 24));
  const total = (db.prepare(`SELECT count(*) count FROM books b ${where}`).get(...args) as Row)
    .count;
  const rows = db
    .prepare(`SELECT b.* FROM books b ${where} ORDER BY b.${sort} ${order} LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit) as Row[];
  return { items: rows.map(hydrate), page, limit, total };
}
