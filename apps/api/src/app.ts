import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticPlugin from '@fastify/static';
import {
  BookInput,
  BookPatch,
  ReadingSessionInput,
  extractIsbns,
  parseIsbn,
} from '@librarium/shared';
import { config } from './config.js';
import { db, id, now } from './db.js';
import {
  createBook,
  deleteBook,
  findBookByIsbn,
  getBook,
  listBooks,
  setBookLocalCover,
  updateBook,
} from './repository.js';
import { lookupIsbn, searchMetadata } from './metadata.js';
import { metadataSettingsStatus, saveMetadataSettings } from './metadata-settings.js';
import { analyzeImage, detectBarcode, normalizeImage } from './images.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a: string, b: string) =>
  crypto.timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const error = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

export async function buildApp() {
  const app = Fastify({
    logger: {
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'body.password',
        'body.image',
        'body.googleBooksApiKey',
      ],
    },
  });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: config.maxImageMb * 1024 * 1024, files: 10 },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Librarium API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.setErrorHandler(
    (cause: Error & { statusCode?: number; code?: string; details?: unknown }, request, reply) => {
    request.log.warn({ err: cause }, 'Request failed');
    const batchId = (request as any).importBatchId;
    if (batchId)
      db.prepare("UPDATE import_batches SET status='failed',error=?,updated_at=? WHERE id=?").run(
        cause.message,
        now(),
        batchId,
      );
    const isConstraint =
      typeof cause.code === 'string' && cause.code.startsWith('SQLITE_CONSTRAINT');
    const status = cause.statusCode || (isConstraint ? 409 : 400);
    const code =
      status === 409 ? 'CONFLICT' : cause.code === 'METADATA_PROVIDER_UNAVAILABLE' || cause.code === 'SETTINGS_ENCRYPTION_UNAVAILABLE' ? cause.code : 'BAD_REQUEST';
      reply.code(status).send(error(code, cause.message, cause.details));
    },
  );

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    database: 'connected',
    version: '1.0.0',
  }));
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const body = req.body as any;
      if (!config.adminPassword)
        return reply
          .code(503)
          .send(error('ADMIN_PASSWORD_REQUIRED', 'Set ADMIN_PASSWORD before signing in'));
      if (
        !body ||
        !safeEqual(String(body.username || ''), config.adminUsername) ||
        !safeEqual(String(body.password || ''), config.adminPassword)
      )
        return reply.code(401).send(error('INVALID_CREDENTIALS', 'Invalid username or password'));
      const token = crypto.randomBytes(32).toString('base64url'),
        csrf = crypto.randomBytes(24).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
      db.prepare(
        'INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES(?,?,?,?)',
      ).run(
        hash(token),
        config.adminUsername,
        csrf,
        new Date(Date.now() + 7 * 86400000).toISOString(),
      );
      reply.setCookie('librarium_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        path: '/',
        maxAge: 604800,
      });
      return { username: config.adminUsername, csrfToken: csrf };
    },
  );
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const token = req.cookies.librarium_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    reply.clearCookie('librarium_session', { path: '/' });
    return { ok: true };
  });

  app.addHook('preHandler', async (req, reply) => {
    if (
      !req.url.startsWith('/api/v1/') ||
      req.url === '/api/v1/health' ||
      req.url === '/api/v1/auth/login'
    )
      return;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer && config.apiToken && safeEqual(bearer, config.apiToken)) {
      (req as any).auth = 'token';
      return;
    }
    const token = req.cookies.librarium_session;
    const session = token
      ? (db
          .prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?')
          .get(hash(token), now()) as any)
      : null;
    if (!session) return reply.code(401).send(error('UNAUTHORIZED', 'Authentication required'));
    (req as any).session = session;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.url !== '/api/v1/auth/logout' &&
      !safeEqual(String(req.headers['x-csrf-token'] || ''), session.csrf_token)
    )
      return reply.code(403).send(error('CSRF_INVALID', 'Missing or invalid CSRF token'));
  });
  app.get('/api/v1/auth/me', async (req) => ({
    username: (req as any).session?.username ?? config.adminUsername,
    csrfToken: (req as any).session?.csrf_token ?? null,
  }));

  app.get('/api/v1/books', async (req) => listBooks(req.query as any));
  app.post('/api/v1/books', async (req, reply) =>
    reply.code(201).send(createBook(BookInput.parse(req.body))),
  );
  app.get(
    '/api/v1/books/:id',
    async (req, reply) =>
      getBook((req.params as any).id) ?? reply.code(404).send(error('NOT_FOUND', 'Book not found')),
  );
  app.get('/api/v1/books/:id/cover', async (req, reply) => {
    const book = getBook((req.params as any).id);
    if (!book?.localCover) return reply.code(404).send(error('NOT_FOUND', 'Local cover not found'));
    const imageRoot = path.resolve(config.dataDir, 'images');
    const coverPath = path.resolve(imageRoot, book.localCover);
    if (!coverPath.startsWith(`${imageRoot}${path.sep}`) || !fs.existsSync(coverPath))
      return reply.code(404).send(error('NOT_FOUND', 'Local cover not found'));
    return reply.type('image/jpeg').send(fs.createReadStream(coverPath));
  });
  app.post('/api/v1/books/:id/enrich', async (req, reply) => {
    const bookId = (req.params as any).id;
    if (!getBook(bookId)) return reply.code(404).send(error('NOT_FOUND', 'Book not found'));
    const part = await req.file();
    if (!part?.mimetype.startsWith('image/'))
      return reply.code(400).send(error('INVALID_IMAGE', 'Upload one image to enhance this book'));
    const imageId = id();
    const relativeCover = path.join('books', bookId, `${imageId}.jpg`);
    const normalized = await normalizeImage(
      await part.toBuffer(),
      path.join(config.dataDir, 'images', relativeCover),
    );
    const useAsCover = String((part.fields as any)?.useAsCover?.value || '') === 'true';
    if (useAsCover) setBookLocalCover(bookId, relativeCover);
    let metadata: any = null;
    let proposal: any = null;
    const isbn = await detectBarcode(normalized.buffer);
    if (isbn) {
      try {
        metadata = await lookupIsbn(isbn);
      } catch {
        metadata = null;
      }
      proposal = metadata ?? { isbn13: isbn, isbn10: parseIsbn(isbn).isbn10 };
    } else {
      try {
        const detected = (await analyzeImage(normalized.buffer)).books.find(
          (candidate) => candidate.title || candidate.isbn13,
        );
        if (detected) {
          if (detected.isbn13)
            try {
              metadata = await lookupIsbn(detected.isbn13);
            } catch {
              metadata = null;
            }
          proposal =
            metadata ?? {
              title: detected.title,
              authors: detected.author ? [detected.author] : [],
              isbn10: detected.isbn10,
              isbn13: detected.isbn13,
              confidence: detected.confidence,
            };
        }
      } catch {
        proposal = null;
      }
    }
    return reply.code(201).send({
      coverUpdated: useAsCover,
      proposal,
      previewUrl: `/api/v1/books/${bookId}/cover`,
    });
  });
  app.patch(
    '/api/v1/books/:id',
    async (req, reply) =>
      updateBook((req.params as any).id, BookPatch.parse(req.body)) ??
      reply.code(404).send(error('NOT_FOUND', 'Book not found')),
  );
  app.delete('/api/v1/books/:id', async (req, reply) =>
    deleteBook((req.params as any).id)
      ? reply.code(204).send()
      : reply.code(404).send(error('NOT_FOUND', 'Book not found')),
  );
  app.get(
    '/api/v1/books/isbn/:isbn',
    async (req, reply) =>
      findBookByIsbn((req.params as any).isbn) ??
      reply.code(404).send(error('NOT_FOUND', 'ISBN not present in library')),
  );
  app.get('/api/v1/dashboard', async () => {
    const count = (where = '') =>
      (db.prepare(`SELECT count(*) n FROM books ${where}`).get() as any).n;
    return {
      total: count(),
      reading: count("WHERE reading_status='reading'"),
      unread: count("WHERE reading_status='unread'"),
      recent: listBooks({ limit: 6 }).items,
      recentlyFinished: db
        .prepare(
          'SELECT * FROM reading_sessions WHERE finished_date IS NOT NULL ORDER BY finished_date DESC LIMIT 6',
        )
        .all(),
    };
  });

  async function importOne(isbn: string) {
    const parsed = parseIsbn(isbn),
      duplicate = findBookByIsbn(parsed.isbn13);
    if (duplicate) return { status: 'duplicate', isbn: parsed.isbn13, book: duplicate };
    const metadata = await lookupIsbn(parsed.isbn13);
    if (!metadata) return { status: 'unknown', isbn: parsed.isbn13 };
    return {
      status: 'created',
      isbn: parsed.isbn13,
      book: createBook({
        ...metadata,
        ownershipStatus: 'owned',
        readingStatus: 'unread',
        rating: null,
        notes: null,
      }),
    };
  }
  app.post('/api/v1/imports/isbn', async (req, reply) => {
    const result = await importOne((req.body as any)?.isbn);
    if (result.status === 'created') return reply.code(201).send(result);
    if (result.status === 'duplicate')
      return reply
        .code(409)
        .send(error('DUPLICATE_ISBN', `ISBN ${result.isbn} is already in your library`, result));
    return reply
      .code(404)
      .send(
        error(
          'ISBN_METADATA_NOT_FOUND',
          `No exact edition metadata was found for ISBN ${result.isbn}. You can add it manually instead.`,
          result,
        ),
      );
  });
  app.post('/api/v1/imports/isbn/bulk', async (req) => {
    const values = Array.isArray((req.body as any)?.isbns)
      ? (req.body as any).isbns
      : extractIsbns(String((req.body as any)?.text || ''));
    const results = [];
    for (const value of values) {
      try {
        results.push(await importOne(value));
      } catch (e) {
        results.push({ status: 'invalid', isbn: value, error: (e as Error).message });
      }
    }
    return {
      total: values.length,
      created: results.filter((x) => x.status === 'created').length,
      results,
    };
  });

  app.get('/api/v1/reading-history', async () =>
    db
      .prepare(
        'SELECT * FROM reading_sessions ORDER BY COALESCE(finished_date,started_date,created_at) DESC',
      )
      .all(),
  );
  app.post('/api/v1/books/:id/reading-sessions', async (req, reply) => {
    const bookId = (req.params as any).id;
    if (!getBook(bookId)) return reply.code(404).send(error('NOT_FOUND', 'Book not found'));
    const body = ReadingSessionInput.parse(req.body),
      sessionId = id(),
      timestamp = now();
    db.prepare(
      'INSERT INTO reading_sessions(id,book_id,started_date,finished_date,rating,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      sessionId,
      bookId,
      body.startedDate ?? null,
      body.finishedDate ?? null,
      body.rating ?? null,
      body.notes ?? null,
      timestamp,
      timestamp,
    );
    return reply
      .code(201)
      .send(db.prepare('SELECT * FROM reading_sessions WHERE id=?').get(sessionId));
  });
  app.patch('/api/v1/reading-sessions/:id', async (req, reply) => {
    const body = ReadingSessionInput.partial().parse(req.body),
      current = db
        .prepare('SELECT * FROM reading_sessions WHERE id=?')
        .get((req.params as any).id) as any;
    if (!current) return reply.code(404).send(error('NOT_FOUND', 'Reading session not found'));
    const next = {
      ...current,
      ...body,
      started_date: body.startedDate ?? current.started_date,
      finished_date: body.finishedDate ?? current.finished_date,
      updated_at: now(),
    };
    db.prepare(
      'UPDATE reading_sessions SET started_date=@started_date,finished_date=@finished_date,rating=@rating,notes=@notes,updated_at=@updated_at WHERE id=@id',
    ).run(next);
    return db.prepare('SELECT * FROM reading_sessions WHERE id=?').get(current.id);
  });
  app.delete('/api/v1/reading-sessions/:id', async (req, reply) =>
    db.prepare('DELETE FROM reading_sessions WHERE id=?').run((req.params as any).id).changes
      ? reply.code(204).send()
      : reply.code(404).send(error('NOT_FOUND', 'Reading session not found')),
  );

  app.post('/api/v1/imports/images', async (req, reply) => {
    const batchId = id(),
      timestamp = now();
    db.prepare(
      'INSERT INTO import_batches(id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run(batchId, 'images', 'processing', timestamp, timestamp);
    (req as any).importBatchId = batchId;
    const parts = req.files();
    let imageCount = 0;
    for await (const part of parts) {
      if (!part.mimetype.startsWith('image/')) throw new Error('Only image uploads are accepted');
      const buffer = await part.toBuffer();
      const imageId = id(),
        target = path.join(config.dataDir, 'imports', batchId, `${imageId}.jpg`);
      const normalized = await normalizeImage(buffer, target);
      db.prepare(
        'INSERT INTO import_images(id,batch_id,filename,mime_type,path,width,height,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        imageId,
        batchId,
        path.basename(part.filename),
        normalized.mime,
        target,
        normalized.width,
        normalized.height,
        now(),
      );
      imageCount++;
      const isbn = await detectBarcode(normalized.buffer);
      let candidates: any[];
      if (isbn) {
        const metadata = await lookupIsbn(isbn);
        candidates = [
          {
            title: metadata?.title ?? null,
            author: metadata?.authors[0] ?? null,
            isbn13: isbn,
            isbn10: parseIsbn(isbn).isbn10,
            confidence: 1,
            visibleText: [isbn],
            metadata,
          },
        ];
      } else candidates = (await analyzeImage(normalized.buffer)).books;
      for (const candidate of candidates) {
        let metadata = candidate.metadata ?? null,
          alternatives: any[] = [];
        if (!metadata && candidate.isbn13) metadata = await lookupIsbn(candidate.isbn13);
        if (!metadata && candidate.title)
          alternatives = await searchMetadata(candidate.title, candidate.author ?? undefined);
        db.prepare(
          'INSERT INTO import_candidates(id,batch_id,title,author,isbn10,isbn13,confidence,evidence,metadata,alternatives,review_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id(),
          batchId,
          candidate.title,
          candidate.author,
          candidate.isbn10,
          candidate.isbn13,
          candidate.confidence,
          JSON.stringify(candidate.visibleText),
          metadata ? JSON.stringify(metadata) : null,
          JSON.stringify(alternatives),
          'pending',
          now(),
          now(),
        );
      }
    }
    if (!imageCount) throw new Error('No images uploaded');
    db.prepare("UPDATE import_batches SET status='review',updated_at=? WHERE id=?").run(
      now(),
      batchId,
    );
    return reply.code(202).send(getImport(batchId));
  });

  function getImport(batchId: string) {
    const batch = db.prepare('SELECT * FROM import_batches WHERE id=?').get(batchId) as any;
    if (!batch) return null;
    const images = (
      db
        .prepare(
          'SELECT id,filename,mime_type,width,height,created_at FROM import_images WHERE batch_id=?',
        )
        .all(batchId) as any[]
    ).map((image) => ({ ...image, previewUrl: `/api/v1/imports/${batchId}/images/${image.id}` }));
    const candidates = (
      db.prepare('SELECT * FROM import_candidates WHERE batch_id=?').all(batchId) as any[]
    ).map((x) => ({
      ...x,
      evidence: JSON.parse(x.evidence),
      metadata: x.metadata ? JSON.parse(x.metadata) : null,
      alternatives: JSON.parse(x.alternatives || '[]'),
      duplicate: x.isbn13 ? findBookByIsbn(x.isbn13) : null,
    }));
    return { ...batch, images, candidates };
  }
  app.get(
    '/api/v1/imports/:id',
    async (req, reply) =>
      getImport((req.params as any).id) ??
      reply.code(404).send(error('NOT_FOUND', 'Import not found')),
  );
  app.get('/api/v1/imports/:id/images/:imageId', async (req, reply) => {
    const params = req.params as any;
    const image = db
      .prepare('SELECT path,mime_type FROM import_images WHERE id=? AND batch_id=?')
      .get(params.imageId, params.id) as any;
    if (!image) return reply.code(404).send(error('NOT_FOUND', 'Import image not found'));
    return reply.type(image.mime_type).send(fs.createReadStream(image.path));
  });
  app.post('/api/v1/imports/:id/approve', async (req, reply) => {
    const batchId = (req.params as any).id,
      body = req.body as any;
    const selected = new Set(body?.candidateIds ?? []),
      editions = body?.editions ?? {},
      created: any[] = [];
    if (!selected.size)
      return reply.code(400).send(error('NO_CANDIDATES_SELECTED', 'Select at least one candidate'));
    db.transaction(() => {
      const rows = db
        .prepare('SELECT * FROM import_candidates WHERE batch_id=?')
        .all(batchId) as any[];
      for (const row of rows) {
        if (!selected.has(row.id)) continue;
        const alternatives = JSON.parse(row.alternatives || '[]');
        let metadata = editions[row.id] ?? (row.metadata ? JSON.parse(row.metadata) : null);
        if (!metadata && alternatives.length === 1) metadata = alternatives[0];
        if (!metadata && alternatives.length > 1)
          throw new Error(
            `Candidate "${row.title || row.id}" has multiple possible editions; choose one before approval`,
          );
        if (!metadata && row.title)
          metadata = {
            title: row.title,
            subtitle: null,
            authors: row.author ? [row.author] : [],
            publisher: null,
            publicationDate: null,
            language: null,
            pageCount: null,
            description: null,
            categories: [],
            coverUrl: null,
            isbn10: row.isbn10,
            isbn13: row.isbn13,
            editionFormat: null,
            metadataSource: 'image-analysis',
            metadataSourceId: null,
          };
        if (!metadata)
          throw new Error(`Candidate ${row.id} has no readable title or metadata to approve`);
        const duplicate = metadata.isbn13 ? findBookByIsbn(metadata.isbn13) : null;
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
        db.prepare(
          "UPDATE import_candidates SET review_status='approved',metadata=?,updated_at=? WHERE id=?",
        ).run(JSON.stringify(metadata), now(), row.id);
      }
      db.prepare("UPDATE import_batches SET status='completed',updated_at=? WHERE id=?").run(
        now(),
        batchId,
      );
    })();
    return reply.send({ created, batch: getImport(batchId) });
  });
  app.post('/api/v1/imports/:id/reject', async (req) => {
    const batchId = (req.params as any).id,
      ids = (req.body as any)?.candidateIds as string[] | undefined;
    if (ids?.length) {
      const stmt = db.prepare(
        "UPDATE import_candidates SET review_status='rejected',updated_at=? WHERE id=? AND batch_id=?",
      );
      db.transaction(() => ids.forEach((x) => stmt.run(now(), x, batchId)))();
    } else
      db.prepare(
        "UPDATE import_candidates SET review_status='rejected',updated_at=? WHERE batch_id=?",
      ).run(now(), batchId);
    db.prepare("UPDATE import_batches SET status='completed',updated_at=? WHERE id=?").run(
      now(),
      batchId,
    );
    return getImport(batchId);
  });

  function exportDocument() {
    const books = listBooks({ limit: 100000 }).items;
    return {
      schemaVersion: 1,
      exportedAt: now(),
      application: 'Librarium',
      books,
      authors: db.prepare('SELECT * FROM authors').all(),
      readingHistory: db.prepare('SELECT * FROM reading_sessions').all(),
    };
  }
  app.get('/api/v1/export/json', async (_req, reply) =>
    reply
      .header(
        'content-disposition',
        `attachment; filename="librarium-${new Date().toISOString().slice(0, 10)}.json"`,
      )
      .send(exportDocument()),
  );
  app.post('/api/v1/import/json', async (req, reply) => {
    const payload = (req.body as any)?.document ?? (req.body as any),
      strategy = (req.body as any)?.strategy ?? 'skip',
      dryRun = (req.body as any)?.dryRun !== false;
    if (
      payload?.schemaVersion !== 1 ||
      payload?.application !== 'Librarium' ||
      !Array.isArray(payload.books) ||
      !Array.isArray(payload.authors) ||
      !Array.isArray(payload.readingHistory)
    )
      return reply
        .code(400)
        .send(error('INVALID_IMPORT', 'Unsupported or malformed Librarium export'));
    const valid: any[] = [],
      invalid: any[] = [],
      conflicts: any[] = [];
    payload.books.forEach((raw: any, index: number) => {
      const parsed = BookInput.safeParse(raw);
      if (!parsed.success) invalid.push({ index, issues: parsed.error.issues });
      else {
        valid.push({ data: parsed.data, sourceId: raw.id });
        if (parsed.data.isbn13 && findBookByIsbn(parsed.data.isbn13))
          conflicts.push({ index, isbn13: parsed.data.isbn13 });
      }
    });
    const summary = {
      total: payload.books.length,
      valid: valid.length,
      invalid,
      conflicts,
      wouldCreate: valid.length - conflicts.length,
    };
    if (dryRun) return { dryRun: true, summary };
    if (invalid.length)
      return reply
        .code(400)
        .send(error('INVALID_IMPORT', 'Import contains invalid records', summary));
    db.transaction(() => {
      if (strategy === 'replace') {
        db.prepare('DELETE FROM books').run();
      }
      const idMap = new Map<string, string>();
      for (const entry of valid) {
        const book = entry.data;
        const existing = book.isbn13 ? findBookByIsbn(book.isbn13) : null;
        if (existing && strategy === 'skip') {
          if (entry.sourceId) idMap.set(entry.sourceId, existing.id);
          continue;
        }
        if (existing && strategy === 'merge') {
          updateBook(existing.id, book);
          if (entry.sourceId) idMap.set(entry.sourceId, existing.id);
        } else if (!existing) {
          const created = createBook(book);
          if (entry.sourceId) idMap.set(entry.sourceId, created.id);
        }
      }
      for (const session of payload.readingHistory) {
        const bookId = idMap.get(session.book_id);
        if (!bookId) continue;
        db.prepare(
          'INSERT OR IGNORE INTO reading_sessions(id,book_id,started_date,finished_date,rating,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          session.id || id(),
          bookId,
          session.started_date ?? null,
          session.finished_date ?? null,
          session.rating ?? null,
          session.notes ?? null,
          session.created_at || now(),
          session.updated_at || now(),
        );
      }
    })();
    return { dryRun: false, summary };
  });
  app.get('/api/v1/export/sqlite', async (_req, reply) => {
    const snapshot = path.join(config.dataDir, 'backups', `download-${Date.now()}.sqlite`);
    await db.backup(snapshot);
    reply
      .header('content-type', 'application/vnd.sqlite3')
      .header('content-disposition', 'attachment; filename="librarium.sqlite"');
    return reply.send(
      fs.createReadStream(snapshot).on('close', () => void fsp.unlink(snapshot).catch(() => {})),
    );
  });
  app.post('/api/v1/import/sqlite', async (req, reply) => {
    const confirmation = String(req.headers['x-librarium-confirm'] || '');
    if (confirmation !== 'RESTORE')
      return reply
        .code(400)
        .send(error('CONFIRMATION_REQUIRED', 'Set X-Librarium-Confirm: RESTORE'));
    const part = await req.file();
    if (!part) throw new Error('SQLite file required');
    const temporary = path.join(config.dataDir, 'imports', `restore-${id()}.sqlite`);
    await fsp.writeFile(temporary, await part.toBuffer());
    const Database = (await import('better-sqlite3')).default;
    const source = new Database(temporary, { readonly: true });
    try {
      const version = source
        .prepare('SELECT max(version) version FROM schema_migrations')
        .get() as any;
      if (![1, 2].includes(version?.version)) throw new Error('Unsupported Librarium database schema');
      source.prepare('PRAGMA integrity_check').get();
    } finally {
      source.close();
    }
    const backup = path.join(config.dataDir, 'backups', `pre-restore-${Date.now()}.sqlite`);
    await db.backup(backup);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        `ATTACH DATABASE '${temporary.replaceAll("'", "''")}' AS restore; DELETE FROM reading_sessions; DELETE FROM book_authors; DELETE FROM book_categories; DELETE FROM books; DELETE FROM authors; DELETE FROM categories; INSERT INTO books SELECT * FROM restore.books; INSERT INTO authors SELECT * FROM restore.authors; INSERT INTO categories SELECT * FROM restore.categories; INSERT INTO book_authors SELECT * FROM restore.book_authors; INSERT INTO book_categories SELECT * FROM restore.book_categories; INSERT INTO reading_sessions SELECT * FROM restore.reading_sessions; COMMIT; DETACH DATABASE restore;`,
      );
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
    return { restored: true, backup: path.basename(backup) };
  });
  app.get('/api/v1/settings/status', async () => ({
    metadata: metadataSettingsStatus(),
    imageAnalysis: {
      enabled: config.visionEnabled && Boolean(config.openAiKey),
      model: config.visionModel,
      keyConfigured: Boolean(config.openAiKey),
    },
    maxImageSizeMb: config.maxImageMb,
  }));
  app.put('/api/v1/settings/metadata', async (req) =>
    saveMetadataSettings(req.body),
  );

  const publicDir = path.resolve('dist/public');
  if (fs.existsSync(publicDir)) {
    await app.register(staticPlugin, { root: publicDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send(error('NOT_FOUND', 'Route not found'))
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
