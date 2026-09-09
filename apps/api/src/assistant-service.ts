import {
  ConfirmationAction,
  ConfirmationActionType,
  DiscoveryInput,
  ReadingSessionQuery,
} from '@librarium/shared';
import { AssistantIdentity, requireScope } from './assistant-auth.js';
import { db, id, now } from './db.js';
import { lookupIsbn, searchMetadata } from './metadata.js';
import {
  createBook,
  deleteBook,
  getBook,
  permanentlyDeleteBook,
  restoreBook,
  updateBook,
} from './repository.js';

export function listReadingSessions(raw: unknown, includeNotes = true) {
  const query = ReadingSessionQuery.parse(raw);
  const clauses: string[] = ['NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=s.book_id)'];
  const args: unknown[] = [];
  if (query.bookId) {
    clauses.push('s.book_id=?');
    args.push(query.bookId);
  }
  if (query.ratingMin) {
    clauses.push('s.rating>=?');
    args.push(query.ratingMin);
  }
  if (query.startedAfter) {
    clauses.push('s.started_date>=?');
    args.push(query.startedAfter);
  }
  if (query.finishedAfter) {
    clauses.push('s.finished_date>=?');
    args.push(query.finishedAfter);
  }
  if (query.author) {
    clauses.push(
      'EXISTS(SELECT 1 FROM book_authors ba JOIN authors a ON a.id=ba.author_id WHERE ba.book_id=s.book_id AND a.name LIKE ?)',
    );
    args.push(`%${query.author}%`);
  }
  if (query.category) {
    clauses.push(
      'EXISTS(SELECT 1 FROM book_categories bc JOIN categories c ON c.id=bc.category_id WHERE bc.book_id=s.book_id AND c.name=?)',
    );
    args.push(query.category);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const total = (
    db.prepare(`SELECT count(*) count FROM reading_sessions s ${where}`).get(...args) as any
  ).count;
  const rows = db
    .prepare(
      `SELECT s.* FROM reading_sessions s ${where}
       ORDER BY COALESCE(s.finished_date,s.started_date,s.created_at) DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, query.limit, (query.page - 1) * query.limit) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      bookId: row.book_id,
      startedDate: row.started_date,
      finishedDate: row.finished_date,
      rating: row.rating,
      notes: includeNotes ? row.notes : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      book: getBook(row.book_id, { summary: true }),
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function createDiscovery(raw: unknown) {
  const input = DiscoveryInput.parse(raw);
  const batchId = id();
  const timestamp = now();
  db.prepare(
    'INSERT INTO import_batches(id,kind,status,source_metadata,created_at,updated_at) VALUES(?,?,?,?,?,?)',
  ).run(batchId, 'discovery', 'review', JSON.stringify(input), timestamp, timestamp);
  const results = input.isbn
    ? [await lookupIsbn(input.isbn)].filter(Boolean)
    : await searchMetadata(input.query!, input.author);
  const unique = new Map<string, any>();
  for (const result of results.slice(0, input.limit)) {
    const key = result!.isbn13 || `${result!.metadataSource}:${result!.metadataSourceId}`;
    if (key && !unique.has(key)) unique.set(key, result);
  }
  for (const metadata of unique.values())
    db.prepare(
      `INSERT INTO import_candidates(
        id,batch_id,title,author,isbn10,isbn13,confidence,evidence,metadata,alternatives,review_status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id(),
      batchId,
      metadata.title,
      metadata.authors[0] ?? null,
      metadata.isbn10,
      metadata.isbn13,
      1,
      JSON.stringify([metadata.metadataSource]),
      JSON.stringify(metadata),
      '[]',
      'pending',
      now(),
      now(),
    );
  return getImport(batchId);
}

export function getImport(batchId: string) {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id=?').get(batchId) as any;
  if (!batch) return null;
  const candidates = (
    db.prepare('SELECT * FROM import_candidates WHERE batch_id=?').all(batchId) as any[]
  ).map((candidate) => ({
    ...candidate,
    evidence: JSON.parse(candidate.evidence),
    metadata: candidate.metadata ? JSON.parse(candidate.metadata) : null,
    alternatives: JSON.parse(candidate.alternatives || '[]'),
    duplicate: candidate.isbn13
      ? db
          .prepare(
            'SELECT b.id,b.title FROM books b WHERE b.isbn13=? AND NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)',
          )
          .get(candidate.isbn13)
      : null,
  }));
  return { ...batch, candidates };
}

export function listImports(raw: any) {
  const page = Math.max(1, Number(raw?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(raw?.limit) || 24));
  const clauses: string[] = [];
  const args: unknown[] = [];
  for (const [value, column] of [
    [raw?.kind, 'kind'],
    [raw?.status, 'status'],
  ] as const)
    if (value) {
      clauses.push(`${column}=?`);
      args.push(value);
    }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT count(*) count FROM import_batches ${where}`).get(...args) as any
  ).count;
  const items = db
    .prepare(`SELECT * FROM import_batches ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit);
  return { items, page, limit, total };
}

function confirmationSummary(action: ConfirmationActionType) {
  switch (action.type) {
    case 'deleteBook':
      return `Move “${getBook(action.bookId)?.title ?? action.bookId}” to trash`;
    case 'permanentlyDeleteBook':
      return `Permanently delete “${getBook(action.bookId, { includeTrashed: true })?.title ?? action.bookId}”`;
    case 'restoreBook':
      return `Restore “${getBook(action.bookId, { includeTrashed: true })?.title ?? action.bookId}”`;
    case 'approveImport':
      return `Approve ${action.candidateIds.length} import candidate(s)`;
    case 'bulkUpdateBooks':
      return `Update ${action.bookIds.length} book(s): ${Object.keys(action.patch).join(', ')}`;
    case 'deleteReadingSession':
      return `Delete reading session ${action.sessionId}`;
  }
}

function scopeForAction(action: ConfirmationActionType) {
  if (action.type === 'approveImport') return 'imports:write' as const;
  if (action.type === 'deleteReadingSession') return 'reading:write' as const;
  if (action.type === 'deleteBook' || action.type === 'permanentlyDeleteBook')
    return 'books:delete' as const;
  return 'books:write' as const;
}

export function prepareConfirmation(identity: AssistantIdentity, raw: unknown) {
  const action = ConfirmationAction.parse(raw);
  requireScope(identity, scopeForAction(action));
  const confirmationId = id();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const summary = confirmationSummary(action);
  db.prepare(
    'INSERT INTO confirmation_intents(id,credential_id,action_type,action_payload,summary,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    confirmationId,
    identity.id,
    action.type,
    JSON.stringify(action),
    summary,
    expiresAt,
    createdAt,
  );
  return { id: confirmationId, action: action.type, summary, expiresAt };
}

function approveImport(action: Extract<ConfirmationActionType, { type: 'approveImport' }>) {
  const selected = new Set(action.candidateIds);
  const rows = db
    .prepare('SELECT * FROM import_candidates WHERE batch_id=?')
    .all(action.importId) as any[];
  const created: any[] = [];
  for (const row of rows) {
    if (!selected.has(row.id)) continue;
    const alternatives = JSON.parse(row.alternatives || '[]');
    const metadata =
      action.editions[row.id] ??
      (row.metadata
        ? JSON.parse(row.metadata)
        : alternatives.length === 1
          ? alternatives[0]
          : null);
    if (!metadata) throw new Error(`Candidate ${row.id} requires an edition selection`);
    const duplicate = metadata.isbn13
      ? db.prepare('SELECT id FROM books WHERE isbn13=?').get(metadata.isbn13)
      : null;
    if (duplicate) {
      db.prepare(
        "UPDATE import_candidates SET review_status='duplicate',updated_at=? WHERE id=?",
      ).run(now(), row.id);
      continue;
    }
    created.push(
      createBook({
        ...metadata,
        ownershipStatus: 'owned',
        readingStatus: 'unread',
        rating: null,
        notes: null,
      }),
    );
    db.prepare("UPDATE import_candidates SET review_status='approved',updated_at=? WHERE id=?").run(
      now(),
      row.id,
    );
  }
  db.prepare("UPDATE import_batches SET status='completed',updated_at=? WHERE id=?").run(
    now(),
    action.importId,
  );
  return { created, import: getImport(action.importId) };
}

export function executeConfirmation(identity: AssistantIdentity, confirmationId: string) {
  const row = db
    .prepare(
      'SELECT * FROM confirmation_intents WHERE id=? AND credential_id=? AND consumed_at IS NULL AND expires_at>?',
    )
    .get(confirmationId, identity.id, now()) as any;
  if (!row) {
    const cause = new Error(
      'Confirmation is missing, expired, consumed, or belongs to another credential',
    ) as Error & {
      statusCode: number;
      code: string;
    };
    cause.statusCode = 409;
    cause.code = 'CONFIRMATION_INVALID';
    throw cause;
  }
  const action = ConfirmationAction.parse(JSON.parse(row.action_payload));
  requireScope(identity, scopeForAction(action));
  const result = db.transaction(() => {
    let value: unknown;
    switch (action.type) {
      case 'deleteBook':
        value = { deleted: deleteBook(action.bookId), bookId: action.bookId };
        break;
      case 'permanentlyDeleteBook':
        value = { permanentlyDeleted: permanentlyDeleteBook(action.bookId), bookId: action.bookId };
        break;
      case 'restoreBook':
        value = { restored: restoreBook(action.bookId), book: getBook(action.bookId) };
        break;
      case 'bulkUpdateBooks':
        value = {
          books: action.bookIds.map((bookId) => updateBook(bookId, action.patch)).filter(Boolean),
        };
        break;
      case 'approveImport':
        value = approveImport(action);
        break;
      case 'deleteReadingSession':
        value = {
          deleted:
            db.prepare('DELETE FROM reading_sessions WHERE id=?').run(action.sessionId).changes > 0,
          sessionId: action.sessionId,
        };
        break;
    }
    db.prepare('UPDATE confirmation_intents SET consumed_at=? WHERE id=?').run(
      now(),
      confirmationId,
    );
    return value;
  })();
  return { confirmationId, action: action.type, result };
}
