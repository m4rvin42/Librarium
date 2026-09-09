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
import { z } from 'zod';
import {
  ApiCredentialInput,
  BookInput,
  BookQuery,
  BookPatch,
  ConfirmationAction,
  CoverDraftConfirmInput,
  DiscoveryInput,
  ReadingSessionInput,
  ReadingSessionQuery,
  RecommendationInput,
  RecommendationSettingsInput,
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
  libraryFacets,
  librarySummary,
  listTrash,
  permanentlyDeleteBook,
  restoreBook,
  refreshAllBookSearch,
} from './repository.js';
import { lookupIsbn, searchMetadata } from './metadata.js';
import { metadataSettingsStatus, saveMetadataSettings } from './metadata-settings.js';
import {
  analyzeCoverCorners,
  analyzeImage,
  detectBarcode,
  normalizeImage,
  straightenCover,
  validateCoverCorners,
} from './images.js';
import {
  allCredentialScopes,
  AssistantIdentity,
  audit,
  authenticateCredential,
  createCredential,
  hasScope,
  listAuditEvents,
  listCredentials,
  findIdempotentResponse,
  requireScope,
  requestDigest,
  revokeCredential,
  saveIdempotentResponse,
} from './assistant-auth.js';
import {
  createDiscovery,
  executeConfirmation,
  listImports,
  listReadingSessions,
  prepareConfirmation,
} from './assistant-service.js';
import { recommendBooks } from './recommendations.js';
import {
  recommendationConfiguration,
  saveRecommendationSettings,
} from './recommendation-settings.js';
import { handleMcpRequest } from './mcp.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a: string, b: string) =>
  crypto.timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const error = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
function jsonSchema(schema: z.ZodType) {
  const converted = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as any;
  const stripDefaults = (value: any): any => {
    if (Array.isArray(value)) return value.map(stripDefaults);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'default')
        .map(([key, child]) => [key, stripDefaults(child)]),
    );
  };
  return stripDefaults(converted);
}

function assistantSafeBook(book: any) {
  if (!book) return book;
  const safe = { ...book };
  delete safe.localCover;
  delete safe.coverUrl;
  return { ...safe, coverAvailable: Boolean(book.localCover || book.coverUrl) };
}

export async function buildApp() {
  const credentialWindows = new Map<string, { startedAt: number; count: number }>();
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
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'librarium_session' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  // Runtime contracts are parsed with the shared Zod schemas in handlers. Route JSON Schemas are
  // documentation-only so Zod defaults/transforms cannot change requests before those parsers run.
  app.setValidatorCompiler(() => (data) => ({ value: data }));

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1/')) return;
    const schema = (route.schema ??= {});
    const method = (
      (Array.isArray(route.method) ? route.method[0] : route.method) ?? 'GET'
    ).toLowerCase();
    schema.operationId ??= `${method}${
      route.url
        .replace('/api/v1', '')
        .split('/')
        .filter(Boolean)
        .map((part) =>
          part.startsWith(':')
            ? `By${part.slice(1, 2).toUpperCase()}${part.slice(2)}`
            : `${part.slice(0, 1).toUpperCase()}${part.slice(1).replaceAll('-', '')}`,
        )
        .join('') || 'Root'
    }`;
    schema.tags ??= [route.url.split('/')[3] || 'system'];
    if (!['/api/v1/health', '/api/v1/auth/login'].includes(route.url))
      schema.security ??= [{ bearerAuth: [] }, { cookieAuth: [] }];
    const params = [...route.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    if (params.length && !schema.params)
      schema.params = {
        type: 'object',
        properties: Object.fromEntries(params.map((name) => [name, { type: 'string' }])),
        required: params,
      };
    if (!['get', 'head', 'delete'].includes(method) && !schema.body)
      schema.body = { description: 'Request body; see the operation description and examples.' };
    schema.response = {
      ...(schema.response ?? { 200: { description: 'Successful response' } }),
      400: { $ref: 'ApiError#' },
      401: { $ref: 'ApiError#' },
      403: { $ref: 'ApiError#' },
      404: { $ref: 'ApiError#' },
      409: { $ref: 'ApiError#' },
    };
  });

  app.addSchema({
    $id: 'ApiError',
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: {},
        },
      },
    },
  });

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
        typeof cause.code === 'string' && !cause.code.startsWith('SQLITE_')
          ? cause.code
          : status === 409
            ? 'CONFLICT'
            : status === 401
              ? 'UNAUTHORIZED'
              : status === 403
                ? 'FORBIDDEN'
                : 'BAD_REQUEST';
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
      (req as any).assistant = {
        id: 'legacy-api-token',
        name: 'Legacy API token',
        scopes: allCredentialScopes,
        legacy: true,
      } satisfies AssistantIdentity;
      return;
    }
    if (bearer) {
      const identity = authenticateCredential(bearer);
      if (identity) {
        const currentWindow = credentialWindows.get(identity.id);
        if (!currentWindow || Date.now() - currentWindow.startedAt >= 60_000)
          credentialWindows.set(identity.id, { startedAt: Date.now(), count: 1 });
        else if (++currentWindow.count > 120)
          return reply
            .code(429)
            .send(error('RATE_LIMITED', 'Credential request limit exceeded; retry shortly'));
        (req as any).auth = 'credential';
        (req as any).assistant = identity;
        const route = req.routeOptions.url ?? req.url;
        const method = req.method;
        if (
          route.startsWith('/api/v1/settings/') ||
          route === '/api/v1/export/json' ||
          route === '/api/v1/export/sqlite' ||
          route === '/api/v1/import/json' ||
          route === '/api/v1/import/sqlite'
        )
          return reply
            .code(403)
            .send(
              error('INSUFFICIENT_SCOPE', 'Assistant credentials cannot access administration'),
            );
        const directRisky =
          method === 'DELETE' ||
          route === '/api/v1/imports/:id/approve' ||
          route === '/api/v1/imports/:id/reject';
        if (directRisky)
          return reply
            .code(403)
            .send(error('CONFIRMATION_REQUIRED', 'Prepare and execute a confirmation instead'));
        if (route.startsWith('/api/v1/confirmations') || route === '/api/v1/mcp') return;
        const required =
          method === 'GET' || method === 'HEAD' || route === '/api/v1/recommendations'
            ? 'library:read'
            : route.includes('reading-session')
              ? 'reading:write'
              : route.includes('/imports') || route.includes('/discovery')
                ? 'imports:write'
                : 'books:write';
        if (!hasScope(identity, required))
          return reply
            .code(403)
            .send(error('INSUFFICIENT_SCOPE', `Credential requires the ${required} scope`));
        return;
      }
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

  app.addHook('onResponse', async (req, reply) => {
    const identity = (req as any).assistant as AssistantIdentity | undefined;
    if (!identity || !req.url.startsWith('/api/v1/')) return;
    const route = req.routeOptions.url ?? req.url;
    const targetType = route.includes('/books')
      ? 'book'
      : route.includes('/reading-session')
        ? 'reading_session'
        : route.includes('/imports')
          ? 'import'
          : route.includes('/confirmations')
            ? 'confirmation'
            : undefined;
    audit(
      identity,
      `${req.method} ${route}`,
      reply.statusCode,
      targetType,
      (req.params as any)?.id,
    );
  });

  app.addHook('preHandler', async (req, reply) => {
    const identity = (req as any).assistant as AssistantIdentity | undefined;
    if (!identity || identity.legacy) return;
    const eligible = new Set([
      'POST /api/v1/books',
      'PATCH /api/v1/books/:id',
      'POST /api/v1/books/:id/reading-sessions',
      'PATCH /api/v1/reading-sessions/:id',
      'POST /api/v1/imports/isbn/preview',
      'POST /api/v1/discovery/search',
    ]);
    const route = req.routeOptions.url ?? req.url;
    const operation = `${req.method} ${route}`;
    if (!eligible.has(operation)) return;
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      return reply
        .code(400)
        .send(
          error('IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key of 8–128 safe characters'),
        );
    const hash = requestDigest(req.body);
    const previous = findIdempotentResponse(identity.id, key, req.method, route);
    if (previous) {
      if (previous.request_hash !== hash)
        return reply
          .code(409)
          .send(
            error('IDEMPOTENCY_CONFLICT', 'This key was already used with a different request'),
          );
      (req as any).idempotencyReplay = true;
      return reply.code(previous.response_status).send(JSON.parse(previous.response_body));
    }
    (req as any).idempotencyRecord = {
      credentialId: identity.id,
      key,
      method: req.method,
      path: route,
      requestHash: hash,
    };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const record = (req as any).idempotencyRecord;
    if (!record || (req as any).idempotencyReplay || reply.statusCode >= 500) return payload;
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    saveIdempotentResponse({ ...record, status: reply.statusCode, body });
    return payload;
  });
  app.get('/api/v1/auth/me', async (req) => ({
    username: (req as any).session?.username ?? config.adminUsername,
    csrfToken: (req as any).session?.csrf_token ?? null,
  }));

  app.get(
    '/api/v1/library/summary',
    { schema: { description: 'Compact catalog totals, favorites, and preference signals.' } },
    async () => librarySummary(),
  );
  app.get(
    '/api/v1/library/facets',
    { schema: { description: 'Available authors, categories, languages, formats, and statuses.' } },
    async () => libraryFacets(),
  );
  app.get(
    '/api/v1/reading-sessions',
    { schema: { querystring: jsonSchema(ReadingSessionQuery) } },
    async (req) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      return listReadingSessions(req.query, !identity || hasScope(identity, 'notes:read'));
    },
  );
  app.get('/api/v1/imports', async (req) => listImports(req.query));
  app.post(
    '/api/v1/imports/isbn/preview',
    {
      schema: {
        body: { type: 'object', required: ['isbn'], properties: { isbn: { type: 'string' } } },
        response: { 201: { description: 'ISBN review candidate created' } },
      },
    },
    async (req, reply) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity) requireScope(identity, 'imports:write');
      const result = await createDiscovery({
        isbn: String((req.body as any)?.isbn || ''),
        limit: 1,
      });
      return reply.code(201).send(result);
    },
  );
  app.post(
    '/api/v1/discovery/search',
    {
      schema: {
        body: jsonSchema(DiscoveryInput),
        description: 'Search external metadata providers and create review candidates.',
        response: { 201: { description: 'Discovery review batch created' } },
      },
    },
    async (req, reply) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity) requireScope(identity, 'imports:write');
      return reply.code(201).send(await createDiscovery(DiscoveryInput.parse(req.body)));
    },
  );
  app.post(
    '/api/v1/recommendations',
    {
      schema: {
        body: jsonSchema(RecommendationInput),
        description: 'Rank owned books locally with optional metadata-only OpenAI reranking.',
      },
    },
    async (req) => {
      const input = RecommendationInput.parse(req.body);
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity) requireScope(identity, 'library:read');
      const recommendations = await recommendBooks(input);
      if (!input.includeExternal || recommendations.results.length >= input.limit || !input.query)
        return recommendations;
      if (identity) requireScope(identity, 'imports:write');
      const discovery = await createDiscovery({
        query: input.query,
        limit: input.limit - recommendations.results.length,
      });
      const external = discovery!.candidates
        .filter((candidate: any) => !candidate.duplicate)
        .slice(0, input.limit - recommendations.results.length)
        .map((candidate: any) => ({
          candidateId: candidate.id,
          book: assistantSafeBook(candidate.metadata),
          score: candidate.confidence,
          signals: { externalDiscovery: 1 },
          reasons: [`Found through ${candidate.metadata?.metadataSource || 'external discovery'}`],
          source: 'external',
        }));
      return {
        ...recommendations,
        results: [...recommendations.results, ...external],
        discoveryImportId: discovery!.id,
      };
    },
  );
  app.post(
    '/api/v1/confirmations',
    {
      schema: {
        body: jsonSchema(ConfirmationAction),
        description: 'Prepare a credential-bound, expiring risky action.',
        response: {
          201: { description: 'Confirmation intent prepared' },
          403: { $ref: 'ApiError#' },
        },
      },
    },
    async (req, reply) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (!identity || identity.legacy)
        return reply
          .code(403)
          .send(error('SCOPED_CREDENTIAL_REQUIRED', 'Use a named scoped credential'));
      return reply.code(201).send(prepareConfirmation(identity, req.body));
    },
  );
  app.post('/api/v1/confirmations/:id/execute', async (req, reply) => {
    const identity = (req as any).assistant as AssistantIdentity | undefined;
    if (!identity || identity.legacy)
      return reply
        .code(403)
        .send(error('SCOPED_CREDENTIAL_REQUIRED', 'Use a named scoped credential'));
    return reply.send(executeConfirmation(identity, (req.params as any).id));
  });
  app.post('/api/v1/mcp', async (req, reply) => {
    const identity = (req as any).assistant as AssistantIdentity | undefined;
    if (!identity)
      return reply.code(401).send(error('UNAUTHORIZED', 'Bearer authentication required'));
    const host = String(req.headers.host || '')
      .split(':')[0]!
      .toLowerCase();
    const origin = req.headers.origin ? new URL(req.headers.origin).hostname.toLowerCase() : null;
    if (config.mcpAllowedHosts.length && !config.mcpAllowedHosts.includes(host))
      return reply.code(403).send(error('MCP_HOST_REJECTED', 'MCP host is not allowed'));
    if (origin && origin !== host && !config.mcpAllowedOrigins.includes(origin))
      return reply.code(403).send(error('MCP_ORIGIN_REJECTED', 'MCP origin is not allowed'));
    return handleMcpRequest(req, reply, identity);
  });
  app.get('/api/v1/mcp', async (_req, reply) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Use POST for stateless MCP' },
      id: null,
    }),
  );
  app.delete('/api/v1/mcp', async (_req, reply) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Sessions are not used' },
      id: null,
    }),
  );
  app.get('/api/v1/trash/books', async () => ({ items: listTrash() }));
  app.post('/api/v1/trash/books/:id/restore', async (req, reply) =>
    restoreBook((req.params as any).id)
      ? reply.send({ book: getBook((req.params as any).id) })
      : reply.code(404).send(error('NOT_FOUND', 'Trashed book not found')),
  );
  app.delete('/api/v1/trash/books/:id', async (req, reply) =>
    permanentlyDeleteBook((req.params as any).id)
      ? reply.code(204).send()
      : reply.code(404).send(error('NOT_FOUND', 'Trashed book not found')),
  );

  app.get(
    '/api/v1/books',
    {
      schema: {
        querystring: jsonSchema(BookQuery),
        description: 'Search and filter the active catalog.',
      },
    },
    async (req) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      const result = listBooks(BookQuery.parse(req.query), {
        includeNotes: !identity || hasScope(identity, 'notes:read'),
      });
      return identity
        ? { ...result, items: result.items.map((book: any) => assistantSafeBook(book)) }
        : result;
    },
  );
  app.post(
    '/api/v1/books',
    { schema: { body: jsonSchema(BookInput), description: 'Create a catalog book.' } },
    async (req, reply) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity && (req.body as any)?.notes !== undefined) requireScope(identity, 'notes:write');
      return reply.code(201).send(createBook(BookInput.parse(req.body)));
    },
  );
  app.get('/api/v1/books/:id', async (req, reply) => {
    const identity = (req as any).assistant as AssistantIdentity | undefined;
    const book = getBook((req.params as any).id, {
      includeNotes: !(req as any).assistant || hasScope((req as any).assistant, 'notes:read'),
    });
    if (!book) return reply.code(404).send(error('NOT_FOUND', 'Book not found'));
    return identity ? assistantSafeBook(book) : book;
  });
  app.get('/api/v1/books/:id/cover', async (req, reply) => {
    const book = getBook((req.params as any).id);
    if (!book?.localCover) return reply.code(404).send(error('NOT_FOUND', 'Local cover not found'));
    const imageRoot = path.resolve(config.dataDir, 'images');
    const coverPath = path.resolve(imageRoot, book.localCover);
    if (!coverPath.startsWith(`${imageRoot}${path.sep}`) || !fs.existsSync(coverPath))
      return reply.code(404).send(error('NOT_FOUND', 'Local cover not found'));
    return reply.type('image/jpeg').send(fs.createReadStream(coverPath));
  });
  app.get('/api/v1/books/:id/cover-drafts/:draftId', async (req, reply) => {
    const { id: bookId, draftId } = req.params as any;
    const draft = db
      .prepare(
        "SELECT source_path FROM cover_drafts WHERE id=? AND book_id=? AND status='pending' AND expires_at>?",
      )
      .get(draftId, bookId, now()) as { source_path: string } | undefined;
    if (!draft) return reply.code(404).send(error('NOT_FOUND', 'Cover draft not found'));
    const imageRoot = path.resolve(config.dataDir, 'images');
    const sourcePath = path.resolve(imageRoot, draft.source_path);
    if (!sourcePath.startsWith(`${imageRoot}${path.sep}`) || !fs.existsSync(sourcePath))
      return reply.code(404).send(error('NOT_FOUND', 'Cover draft not found'));
    return reply.type('image/jpeg').send(fs.createReadStream(sourcePath));
  });
  app.post('/api/v1/books/:id/enrich', async (req, reply) => {
    const bookId = (req.params as any).id;
    if (!getBook(bookId)) return reply.code(404).send(error('NOT_FOUND', 'Book not found'));
    const part = await req.file();
    if (!part?.mimetype.startsWith('image/'))
      return reply.code(400).send(error('INVALID_IMAGE', 'Upload one image to enhance this book'));
    const imageId = id();
    const useAsCover = String((part.fields as any)?.useAsCover?.value || '') === 'true';
    const straightenRequested =
      useAsCover && String((part.fields as any)?.straightenCover?.value || '') === 'true';
    const relativeImage = straightenRequested
      ? path.join('books', bookId, 'drafts', `${imageId}.jpg`)
      : path.join('books', bookId, `${imageId}.jpg`);
    const normalized = await normalizeImage(
      await part.toBuffer(),
      path.join(config.dataDir, 'images', relativeImage),
    );
    let coverDraft: any = null;
    if (straightenRequested) {
      try {
        const corners = await analyzeCoverCorners(normalized.buffer);
        const timestamp = now();
        db.prepare(
          'INSERT INTO cover_drafts(id,book_id,source_path,width,height,corners,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          imageId,
          bookId,
          relativeImage,
          normalized.width,
          normalized.height,
          JSON.stringify(corners),
          'pending',
          new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          timestamp,
          timestamp,
        );
        coverDraft = {
          id: imageId,
          corners,
          previewUrl: `/api/v1/books/${bookId}/cover-drafts/${imageId}`,
        };
      } catch (cause) {
        await fsp.unlink(path.join(config.dataDir, 'images', relativeImage)).catch(() => undefined);
        throw cause;
      }
    } else if (useAsCover) setBookLocalCover(bookId, relativeImage);
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
          proposal = metadata ?? {
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
      coverUpdated: useAsCover && !straightenRequested,
      coverDraft,
      proposal,
      previewUrl: coverDraft?.previewUrl ?? `/api/v1/books/${bookId}/cover`,
    });
  });
  app.post('/api/v1/books/:id/cover-drafts/:draftId/confirm', async (req, reply) => {
    const { id: bookId, draftId } = req.params as any;
    const { corners } = CoverDraftConfirmInput.parse(
      Array.isArray(req.body) ? { corners: req.body } : req.body,
    );
    const draft = db
      .prepare(
        "SELECT * FROM cover_drafts WHERE id=? AND book_id=? AND status='pending' AND expires_at>?",
      )
      .get(draftId, bookId, now()) as any;
    if (!draft) return reply.code(404).send(error('NOT_FOUND', 'Cover draft not found'));
    const imageRoot = path.resolve(config.dataDir, 'images');
    const sourcePath = path.resolve(imageRoot, draft.source_path);
    if (!sourcePath.startsWith(`${imageRoot}${path.sep}`) || !fs.existsSync(sourcePath))
      return reply.code(404).send(error('NOT_FOUND', 'Cover draft not found'));
    const finalCover = path.join('books', bookId, `${draftId}.jpg`);
    const finalPath = path.join(imageRoot, finalCover);
    const straightened = await straightenCover(
      await fsp.readFile(sourcePath),
      validateCoverCorners({ corners }),
    );
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.writeFile(finalPath, straightened);
    const timestamp = now();
    db.transaction(() => {
      db.prepare('UPDATE books SET local_cover=?,updated_at=? WHERE id=?').run(
        finalCover,
        timestamp,
        bookId,
      );
      db.prepare("UPDATE cover_drafts SET status='applied',corners=?,updated_at=? WHERE id=?").run(
        JSON.stringify(corners),
        timestamp,
        draftId,
      );
    })();
    return reply.send({ book: getBook(bookId), coverUrl: `/api/v1/books/${bookId}/cover` });
  });
  app.patch(
    '/api/v1/books/:id',
    { schema: { body: jsonSchema(BookPatch), description: 'Update fields on a catalog book.' } },
    async (req, reply) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity && (req.body as any)?.notes !== undefined) requireScope(identity, 'notes:write');
      return (
        updateBook((req.params as any).id, BookPatch.parse(req.body)) ??
        reply.code(404).send(error('NOT_FOUND', 'Book not found'))
      );
    },
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
      (
        db
          .prepare(
            `SELECT count(*) n FROM books b ${where ? `${where} AND` : 'WHERE'} NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)`,
          )
          .get() as any
      ).n;
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
  app.post(
    '/api/v1/books/:id/reading-sessions',
    { schema: { body: jsonSchema(ReadingSessionInput) } },
    async (req, reply) => {
      const bookId = (req.params as any).id;
      if (!getBook(bookId)) return reply.code(404).send(error('NOT_FOUND', 'Book not found'));
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity && (req.body as any)?.notes !== undefined) requireScope(identity, 'notes:write');
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
    },
  );
  app.patch(
    '/api/v1/reading-sessions/:id',
    { schema: { body: jsonSchema(ReadingSessionInput.partial()) } },
    async (req, reply) => {
      const identity = (req as any).assistant as AssistantIdentity | undefined;
      if (identity && (req.body as any)?.notes !== undefined) requireScope(identity, 'notes:write');
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
    },
  );
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
    const first = listBooks({ limit: 100, page: 1 });
    const books = [...first.items];
    for (let page = 2; books.length < first.total; page++)
      books.push(...listBooks({ limit: 100, page }).items);
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
      if (![1, 2].includes(version?.version))
        throw new Error('Unsupported Librarium database schema');
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
    refreshAllBookSearch();
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
    recommendations: recommendationConfiguration(),
  }));
  app.put('/api/v1/settings/metadata', async (req) => saveMetadataSettings(req.body));
  app.put('/api/v1/settings/recommendations', async (req) =>
    saveRecommendationSettings(RecommendationSettingsInput.parse(req.body)),
  );
  app.get('/api/v1/settings/api-credentials', async () => ({
    items: listCredentials(),
    availableScopes: allCredentialScopes,
  }));
  app.post('/api/v1/settings/api-credentials', async (req, reply) => {
    const credential = createCredential(ApiCredentialInput.parse(req.body));
    audit(undefined, 'CREATE API CREDENTIAL', 201, 'api_credential', credential.id);
    return reply.code(201).send(credential);
  });
  app.delete('/api/v1/settings/api-credentials/:id', async (req, reply) => {
    const credentialId = (req.params as any).id;
    if (!revokeCredential(credentialId))
      return reply.code(404).send(error('NOT_FOUND', 'Credential not found or already revoked'));
    audit(undefined, 'REVOKE API CREDENTIAL', 204, 'api_credential', credentialId);
    return reply.code(204).send();
  });
  app.get('/api/v1/settings/audit-events', async (req) => {
    const query = req.query as any;
    return listAuditEvents(Number(query?.page), Number(query?.limit));
  });

  app.get('/api/docs/assistant.json', async () => {
    const document = structuredClone(app.swagger()) as any;
    document.info = {
      ...document.info,
      title: 'Librarium Assistant API',
      description:
        'Curated catalog, reading, recommendation, discovery, and confirmed-write operations for private assistants.',
    };
    const allowed = [
      '/api/v1/health',
      '/api/v1/books',
      '/api/v1/library/',
      '/api/v1/reading-sessions',
      '/api/v1/recommendations',
      '/api/v1/discovery/',
      '/api/v1/imports',
      '/api/v1/confirmations',
      '/api/v1/trash/',
    ];
    for (const route of Object.keys(document.paths)) {
      if (!allowed.some((prefix) => route === prefix || route.startsWith(prefix))) {
        delete document.paths[route];
        continue;
      }
      if (route === '/api/v1/books/{id}') delete document.paths[route].delete;
      if (
        route.includes('/cover') ||
        route.includes('/enrich') ||
        route.includes('/images/') ||
        route.endsWith('/images') ||
        route === '/api/v1/imports/isbn' ||
        route === '/api/v1/imports/isbn/bulk'
      )
        delete document.paths[route];
      if (route.endsWith('/approve') || route.endsWith('/reject')) delete document.paths[route];
      if (route === '/api/v1/trash/books/{id}') delete document.paths[route].delete;
    }
    return document;
  });
  app.get('/api/assistant-docs', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Librarium Assistant API</title><link rel="stylesheet" href="/api/docs/static/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api/docs/static/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/api/docs/assistant.json',dom_id:'#swagger-ui',deepLinking:true})</script></body></html>`,
      ),
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
