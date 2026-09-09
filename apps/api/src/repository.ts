import { BookInputType, BookQuery, BookQueryType, parseIsbn } from '@librarium/shared';
import { db, id, now } from './db.js';

type Row = Record<string, any>;

function hydrate(row: Row, options: { summary?: boolean; includeNotes?: boolean } = {}): any {
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
  const book = {
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
    coverAvailable: Boolean(row.local_cover || row.cover_url),
    editionFormat: row.edition_format,
    ownershipStatus: row.ownership_status,
    readingStatus: row.reading_status,
    rating: row.rating,
    notes: options.includeNotes === false ? undefined : row.notes,
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
  if (!options.summary) return book;
  return {
    id: book.id,
    isbn10: book.isbn10,
    isbn13: book.isbn13,
    title: book.title,
    subtitle: book.subtitle,
    authors: book.authors,
    publicationDate: book.publicationDate,
    language: book.language,
    pageCount: book.pageCount,
    categories: book.categories,
    editionFormat: book.editionFormat,
    ownershipStatus: book.ownershipStatus,
    readingStatus: book.readingStatus,
    rating: book.rating,
    coverAvailable: book.coverAvailable,
    dateAdded: book.dateAdded,
    dateUpdated: book.dateUpdated,
  };
}

export function refreshBookSearch(bookId: string) {
  const row = db.prepare('SELECT * FROM books WHERE id=?').get(bookId) as Row | undefined;
  if (!row) {
    db.prepare('DELETE FROM book_search_documents WHERE book_id=?').run(bookId);
    db.prepare('DELETE FROM book_search_fts WHERE book_id=?').run(bookId);
    return;
  }
  const authors = (
    db
      .prepare(
        'SELECT a.name FROM authors a JOIN book_authors ba ON a.id=ba.author_id WHERE ba.book_id=? ORDER BY ba.position',
      )
      .all(bookId) as Row[]
  ).map((entry) => entry.name);
  const categories = (
    db
      .prepare(
        'SELECT c.name FROM categories c JOIN book_categories bc ON c.id=bc.category_id WHERE bc.book_id=? ORDER BY c.name',
      )
      .all(bookId) as Row[]
  ).map((entry) => entry.name);
  const document = {
    bookId,
    title: row.title,
    subtitle: row.subtitle ?? '',
    authors: authors.join(' '),
    publisher: row.publisher ?? '',
    description: row.description ?? '',
    categories: categories.join(' '),
    isbn: [row.isbn10, row.isbn13].filter(Boolean).join(' '),
    notes: row.notes ?? '',
  };
  db.prepare('DELETE FROM book_search_documents WHERE book_id=?').run(bookId);
  db.prepare('DELETE FROM book_search_fts WHERE book_id=?').run(bookId);
  db.prepare(
    'INSERT INTO book_search_documents(book_id,title,subtitle,authors,publisher,description,categories,isbn,notes) VALUES(@bookId,@title,@subtitle,@authors,@publisher,@description,@categories,@isbn,@notes)',
  ).run(document);
  db.prepare(
    'INSERT INTO book_search_fts(book_id,title,subtitle,authors,publisher,description,categories,isbn,notes) VALUES(@bookId,@title,@subtitle,@authors,@publisher,@description,@categories,@isbn,@notes)',
  ).run(document);
}

export function refreshAllBookSearch() {
  db.transaction(() => {
    db.prepare('DELETE FROM book_search_fts').run();
    db.prepare('DELETE FROM book_search_documents').run();
    const bookIds = db.prepare('SELECT id FROM books').all() as { id: string }[];
    bookIds.forEach(({ id: bookId }) => refreshBookSearch(bookId));
  })();
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

export function getBook(
  bookId: string,
  options: { includeTrashed?: boolean; includeNotes?: boolean; summary?: boolean } = {},
): any {
  const row = db
    .prepare(
      `SELECT b.* FROM books b WHERE b.id=? ${
        options.includeTrashed
          ? ''
          : 'AND NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)'
      }`,
    )
    .get(bookId) as Row | undefined;
  return row ? hydrate(row, options) : null;
}

export function findBookByIsbn(isbn: string) {
  const parsed = parseIsbn(isbn);
  const row = db
    .prepare(
      'SELECT b.* FROM books b WHERE (isbn13=? OR isbn10=?) AND NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)',
    )
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
    refreshBookSearch(bookId);
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
    refreshBookSearch(bookId);
    return getBook(bookId);
  })();
}

export function setBookLocalCover(bookId: string, localCover: string | null) {
  const result = db
    .prepare('UPDATE books SET local_cover=?,updated_at=? WHERE id=?')
    .run(localCover, now(), bookId);
  return result.changes ? getBook(bookId) : null;
}

export const deleteBook = (bookId: string) =>
  db
    .prepare(
      'INSERT OR IGNORE INTO book_trash(book_id,deleted_at) SELECT id,? FROM books WHERE id=?',
    )
    .run(now(), bookId).changes > 0;

export const restoreBook = (bookId: string) =>
  db.prepare('DELETE FROM book_trash WHERE book_id=?').run(bookId).changes > 0;

export const permanentlyDeleteBook = (bookId: string) => {
  const deleted =
    db
      .prepare('DELETE FROM books WHERE id=? AND EXISTS(SELECT 1 FROM book_trash WHERE book_id=?)')
      .run(bookId, bookId).changes > 0;
  if (deleted) refreshBookSearch(bookId);
  return deleted;
};

export function listTrash() {
  return (
    db
      .prepare(
        'SELECT b.*,t.deleted_at FROM books b JOIN book_trash t ON t.book_id=b.id ORDER BY t.deleted_at DESC',
      )
      .all() as Row[]
  ).map((row) => ({ ...hydrate(row, { summary: true }), deletedAt: row.deleted_at }));
}

export function listBooks(rawQuery: Record<string, any>, options: { includeNotes?: boolean } = {}) {
  const query = BookQuery.parse(rawQuery) as BookQueryType;
  const clauses: string[] = [],
    args: unknown[] = [];
  let searchJoin = '';
  if (query.search) {
    const terms = query.search.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) ?? [];
    if (terms.length) {
      const columns = [
        'title',
        'subtitle',
        'authors',
        'publisher',
        'description',
        'categories',
        'isbn',
        ...(options.includeNotes ? ['notes'] : []),
      ];
      const match = terms
        .map(
          (term) =>
            `(${columns.map((column) => `${column}:"${term.replaceAll('"', '""')}"*`).join(' OR ')})`,
        )
        .join(' AND ');
      searchJoin =
        'JOIN (SELECT book_id,bm25(book_search_fts) relevance FROM book_search_fts WHERE book_search_fts MATCH ?) search_match ON search_match.book_id=b.id';
      args.push(match);
    }
  }
  for (const [values, column] of [
    [query.readingStatus, 'reading_status'],
    [query.ownershipStatus, 'ownership_status'],
    [query.language, 'language'],
    [query.editionFormat, 'edition_format'],
  ] as const) {
    if (values?.length) {
      clauses.push(`b.${column} IN (${values.map(() => '?').join(',')})`);
      args.push(...values);
    }
  }
  if (query.author) {
    clauses.push(
      'EXISTS(SELECT 1 FROM book_authors ba JOIN authors a ON a.id=ba.author_id WHERE ba.book_id=b.id AND a.name LIKE ?)',
    );
    args.push(`%${query.author}%`);
  }
  const categories = [...(query.categories ?? []), ...(query.category ? [query.category] : [])];
  if (categories.length) {
    clauses.push(
      `b.id IN (SELECT bc.book_id FROM book_categories bc JOIN categories c ON c.id=bc.category_id WHERE c.name IN (${categories
        .map(() => '?')
        .join(
          ',',
        )}) GROUP BY bc.book_id ${query.categoryMode === 'all' ? 'HAVING count(DISTINCT lower(c.name))=?' : ''})`,
    );
    args.push(
      ...categories,
      ...(query.categoryMode === 'all'
        ? [new Set(categories.map((x) => x.toLowerCase())).size]
        : []),
    );
  }
  for (const [value, operator, column] of [
    [query.ratingMin, '>=', 'rating'],
    [query.ratingMax, '<=', 'rating'],
    [query.pageCountMin, '>=', 'page_count'],
    [query.pageCountMax, '<=', 'page_count'],
    [query.publishedFrom, '>=', 'publication_date'],
    [query.publishedTo, '<=', 'publication_date'],
    [query.addedAfter, '>=', 'created_at'],
    [query.updatedAfter, '>=', 'updated_at'],
  ] as const)
    if (value !== undefined) {
      clauses.push(`b.${column}${operator}?`);
      args.push(value);
    }
  for (const [value, column] of [
    [query.hasNotes, 'notes'],
    [query.hasDescription, 'description'],
    [query.hasLocalCover, 'local_cover'],
  ] as const)
    if (value !== undefined) clauses.push(`b.${column} IS ${value ? 'NOT ' : ''}NULL`);
  if (query.excludeIds?.length) {
    clauses.push(`b.id NOT IN (${query.excludeIds.map(() => '?').join(',')})`);
    args.push(...query.excludeIds);
  }
  clauses.push('NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sorts: Record<string, string> = {
    title: 'title',
    dateAdded: 'created_at',
    dateUpdated: 'updated_at',
    rating: 'rating',
  };
  const sort = sorts[query.sort ?? ''] ?? 'created_at',
    order = query.order === 'asc' ? 'ASC' : 'DESC';
  const page = query.page,
    limit = query.limit;
  const total = (
    db.prepare(`SELECT count(*) count FROM books b ${searchJoin} ${where}`).get(...args) as Row
  ).count;
  const orderBy =
    query.search && (query.sort === 'relevance' || !query.sort)
      ? 'search_match.relevance ASC'
      : `b.${sort} ${order}`;
  const rows = db
    .prepare(`SELECT b.* FROM books b ${searchJoin} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit) as Row[];
  return {
    items: rows.map((row) =>
      hydrate(row, { summary: query.view === 'summary', includeNotes: options.includeNotes }),
    ),
    page,
    limit,
    total,
  };
}

export function libraryFacets() {
  const counts = (table: string, name: string, join: string) =>
    db
      .prepare(
        `SELECT ${name} value,count(*) count FROM ${table} ${join} WHERE NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id) GROUP BY ${name} ORDER BY count DESC,${name}`,
      )
      .all();
  return {
    authors: counts(
      'books b',
      'a.name',
      'JOIN book_authors ba ON ba.book_id=b.id JOIN authors a ON a.id=ba.author_id',
    ),
    categories: counts(
      'books b',
      'c.name',
      'JOIN book_categories bc ON bc.book_id=b.id JOIN categories c ON c.id=bc.category_id',
    ),
    languages: counts('books b', 'b.language', '').filter((entry: any) => entry.value),
    editionFormats: counts('books b', 'b.edition_format', '').filter((entry: any) => entry.value),
    readingStatuses: counts('books b', 'b.reading_status', ''),
    ownershipStatuses: counts('books b', 'b.ownership_status', ''),
  };
}

export function librarySummary() {
  const active = 'NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)';
  const statusCounts = (column: string) =>
    Object.fromEntries(
      (
        db
          .prepare(
            `SELECT ${column} value,count(*) count FROM books b WHERE ${active} GROUP BY ${column}`,
          )
          .all() as Row[]
      ).map((entry) => [entry.value, entry.count]),
    );
  return {
    total: (db.prepare(`SELECT count(*) count FROM books b WHERE ${active}`).get() as Row).count,
    trashed: (db.prepare('SELECT count(*) count FROM book_trash').get() as Row).count,
    readingStatuses: statusCounts('reading_status'),
    ownershipStatuses: statusCounts('ownership_status'),
    recent: listBooks({ limit: 6, view: 'summary' }).items,
    favorites: listBooks({ limit: 6, sort: 'rating', order: 'desc', ratingMin: 4, view: 'summary' })
      .items,
    facets: libraryFacets(),
  };
}
