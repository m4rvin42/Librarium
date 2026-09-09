import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { BookInput, BookPatch, ReadingSessionInput } from '@librarium/shared';
import { AssistantIdentity, hasScope, requireScope } from './assistant-auth.js';
import {
  createDiscovery,
  executeConfirmation,
  listImports,
  listReadingSessions,
  prepareConfirmation,
} from './assistant-service.js';
import { db, id, now } from './db.js';
import { recommendBooks } from './recommendations.js';
import {
  createBook,
  findBookByIsbn,
  getBook,
  libraryFacets,
  librarySummary,
  listBooks,
  restoreBook,
  updateBook,
} from './repository.js';

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const openWorld = { ...readOnly, openWorldHint: true };
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

function assistantBook(book: any, includeNotes: boolean) {
  if (!book) return book;
  const safe = { ...book };
  delete safe.localCover;
  delete safe.coverUrl;
  if (!includeNotes) delete safe.notes;
  return { ...safe, coverAvailable: Boolean(book.localCover || book.coverUrl) };
}

function assistantImport(batch: any) {
  if (!batch) return batch;
  return {
    ...batch,
    candidates: batch.candidates?.map((candidate: any) => ({
      ...candidate,
      metadata: assistantBook(candidate.metadata, false),
      alternatives: candidate.alternatives?.map((alternative: any) =>
        assistantBook(alternative, false),
      ),
    })),
  };
}

export function createLibrariumMcpServer(identity: AssistantIdentity) {
  const server = new McpServer({ name: 'librarium', version: '1.0.0' });
  const canReadNotes = hasScope(identity, 'notes:read');

  if (hasScope(identity, 'library:read')) {
    server.registerTool(
      'search_books',
      {
        description: 'Search and filter books in the private Librarium catalog.',
        inputSchema: z.object({
          search: z.string().optional(),
          author: z.string().optional(),
          categories: z.array(z.string()).optional(),
          readingStatus: z.array(z.string()).optional(),
          ownershipStatus: z.array(z.string()).optional(),
          language: z.array(z.string()).optional(),
          pageCountMax: z.number().int().positive().optional(),
          ratingMin: z.number().int().min(1).max(5).optional(),
          page: z.number().int().positive().default(1),
          limit: z.number().int().min(1).max(100).default(24),
        }),
        annotations: readOnly,
      },
      async (input) => {
        const result = listBooks({ ...input, view: 'summary' }, { includeNotes: false });
        return json(result);
      },
    );
    server.registerTool(
      'get_book',
      {
        description: 'Get one catalog book and its reading history.',
        inputSchema: z.object({ id: z.string().uuid() }),
        annotations: readOnly,
      },
      async ({ id: bookId }) => json({ book: assistantBook(getBook(bookId), canReadNotes) }),
    );
    server.registerTool(
      'find_book_by_isbn',
      {
        description: 'Find an owned catalog book by ISBN-10 or ISBN-13.',
        inputSchema: z.object({ isbn: z.string() }),
        annotations: readOnly,
      },
      async ({ isbn }) => json({ book: assistantBook(findBookByIsbn(isbn), canReadNotes) }),
    );
    server.registerTool(
      'get_library_summary',
      { description: 'Get compact catalog counts and preference signals.', annotations: readOnly },
      async () => json(librarySummary()),
    );
    server.registerTool(
      'get_library_facets',
      {
        description: 'List available authors, categories, formats, languages, and statuses.',
        annotations: readOnly,
      },
      async () => json(libraryFacets()),
    );
    server.registerTool(
      'recommend_books',
      {
        description:
          'Recommend owned books first using explainable local ranking and optional configured OpenAI reranking.',
        inputSchema: z.object({
          query: z.string().default(''),
          limit: z.number().int().min(1).max(20).default(5),
          excludeIds: z.array(z.string().uuid()).default([]),
          rerank: z.enum(['local', 'openai']).default('local'),
        }),
        annotations: readOnly,
      },
      async (input) => json(await recommendBooks(input)),
    );
    server.registerTool(
      'get_reading_history',
      {
        description: 'Get paginated reading sessions with book summaries.',
        inputSchema: z.object({
          bookId: z.string().uuid().optional(),
          page: z.number().int().positive().default(1),
          limit: z.number().int().min(1).max(100).default(24),
        }),
        annotations: readOnly,
      },
      async (input) => json(listReadingSessions(input, canReadNotes)),
    );
    server.registerTool(
      'list_imports',
      {
        description: 'List import and discovery batches awaiting review or already completed.',
        inputSchema: z.object({
          kind: z.string().optional(),
          status: z.string().optional(),
          page: z.number().int().positive().default(1),
          limit: z.number().int().min(1).max(100).default(24),
        }),
        annotations: readOnly,
      },
      async (input) => json(listImports(input)),
    );
  }

  if (hasScope(identity, 'imports:write')) {
    server.registerTool(
      'discover_books',
      {
        description:
          'Search configured external metadata providers. Results remain import candidates until confirmed.',
        inputSchema: z.object({
          query: z.string().min(1),
          author: z.string().optional(),
          limit: z.number().int().min(1).max(20).default(10),
        }),
        annotations: openWorld,
      },
      async (input) => json(assistantImport(await createDiscovery(input))),
    );
    server.registerTool(
      'preview_isbn_import',
      {
        description:
          'Look up an ISBN and create a review candidate without adding it to the catalog.',
        inputSchema: z.object({ isbn: z.string() }),
        annotations: openWorld,
      },
      async ({ isbn }) => json(assistantImport(await createDiscovery({ isbn, limit: 1 }))),
    );
    server.registerTool(
      'prepare_import_approval',
      {
        description: 'Prepare a reviewable, expiring confirmation for selected import candidates.',
        inputSchema: z.object({
          importId: z.string().uuid(),
          candidateIds: z.array(z.string().uuid()).min(1),
        }),
        annotations: write,
      },
      async ({ importId, candidateIds }) =>
        json(
          prepareConfirmation(identity, {
            type: 'approveImport',
            importId,
            candidateIds,
            editions: {},
          }),
        ),
    );
  }

  if (hasScope(identity, 'books:write')) {
    server.registerTool(
      'create_book',
      { description: 'Create one catalog book.', inputSchema: BookInput, annotations: write },
      async (input) => {
        if (input.notes !== undefined) requireScope(identity, 'notes:write');
        return json({ book: assistantBook(createBook(input), canReadNotes) });
      },
    );
    server.registerTool(
      'update_book',
      {
        description: 'Update fields on one existing catalog book.',
        inputSchema: z.object({ id: z.string().uuid(), patch: BookPatch }),
        annotations: write,
      },
      async ({ id: bookId, patch }) => {
        if (patch.notes !== undefined) requireScope(identity, 'notes:write');
        return json({ book: assistantBook(updateBook(bookId, patch), canReadNotes) });
      },
    );
    server.registerTool(
      'prepare_bulk_update',
      {
        description: 'Prepare a confirmation for updating up to 100 books.',
        inputSchema: z.object({
          bookIds: z.array(z.string().uuid()).min(1).max(100),
          patch: BookPatch,
        }),
        annotations: write,
      },
      async ({ bookIds, patch }) =>
        json(prepareConfirmation(identity, { type: 'bulkUpdateBooks', bookIds, patch })),
    );
    server.registerTool(
      'restore_book',
      {
        description: 'Restore a book from trash.',
        inputSchema: z.object({ id: z.string().uuid() }),
        annotations: write,
      },
      async ({ id: bookId }) =>
        json({ restored: restoreBook(bookId), book: assistantBook(getBook(bookId), canReadNotes) }),
    );
  }

  if (hasScope(identity, 'reading:write')) {
    server.registerTool(
      'record_reading_session',
      {
        description: 'Record a reading session for a catalog book.',
        inputSchema: z.object({ bookId: z.string().uuid(), session: ReadingSessionInput }),
        annotations: write,
      },
      async ({ bookId, session }) => {
        if (!getBook(bookId)) throw new Error('Book not found');
        if (session.notes !== undefined) requireScope(identity, 'notes:write');
        const sessionId = id();
        const timestamp = now();
        db.prepare(
          'INSERT INTO reading_sessions(id,book_id,started_date,finished_date,rating,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          sessionId,
          bookId,
          session.startedDate ?? null,
          session.finishedDate ?? null,
          session.rating ?? null,
          session.notes ?? null,
          timestamp,
          timestamp,
        );
        return json({ id: sessionId, bookId, ...session });
      },
    );
    server.registerTool(
      'update_reading_session',
      {
        description: 'Update dates, rating, or notes on one reading session.',
        inputSchema: z.object({ id: z.string().uuid(), patch: ReadingSessionInput.partial() }),
        annotations: write,
      },
      async ({ id: sessionId, patch }) => {
        if (patch.notes !== undefined) requireScope(identity, 'notes:write');
        const current = db
          .prepare('SELECT * FROM reading_sessions WHERE id=?')
          .get(sessionId) as any;
        if (!current) throw new Error('Reading session not found');
        const next = {
          ...current,
          started_date: patch.startedDate ?? current.started_date,
          finished_date: patch.finishedDate ?? current.finished_date,
          rating: patch.rating ?? current.rating,
          notes: patch.notes ?? current.notes,
          updated_at: now(),
        };
        db.prepare(
          'UPDATE reading_sessions SET started_date=@started_date,finished_date=@finished_date,rating=@rating,notes=@notes,updated_at=@updated_at WHERE id=@id',
        ).run(next);
        return json({
          id: current.id,
          bookId: current.book_id,
          startedDate: next.started_date,
          finishedDate: next.finished_date,
          rating: next.rating,
          notes: canReadNotes ? next.notes : undefined,
          updatedAt: next.updated_at,
        });
      },
    );
  }

  if (hasScope(identity, 'books:delete')) {
    server.registerTool(
      'prepare_delete_book',
      {
        description: 'Prepare an expiring confirmation that moves a book to trash.',
        inputSchema: z.object({ id: z.string().uuid() }),
        annotations: destructive,
      },
      async ({ id: bookId }) => json(prepareConfirmation(identity, { type: 'deleteBook', bookId })),
    );
    server.registerTool(
      'prepare_permanent_delete',
      {
        description: 'Prepare an expiring confirmation that permanently removes a trashed book.',
        inputSchema: z.object({ id: z.string().uuid() }),
        annotations: destructive,
      },
      async ({ id: bookId }) =>
        json(prepareConfirmation(identity, { type: 'permanentlyDeleteBook', bookId })),
    );
  }

  if (!identity.legacy) {
    server.registerTool(
      'confirm_action',
      {
        description:
          'Execute one previously prepared action after the user has approved its exact summary.',
        inputSchema: z.object({ confirmationId: z.string().uuid() }),
        annotations: destructive,
      },
      async ({ confirmationId }) => json(executeConfirmation(identity, confirmationId)),
    );
  }

  return server;
}

export async function handleMcpRequest(request: any, reply: any, identity: AssistantIdentity) {
  const handler = createMcpHandler(() => createLibrariumMcpServer(identity), {
    responseMode: 'json',
  });
  const nodeHandler = toNodeHandler(handler);
  reply.hijack();
  request.raw.on('close', () => void handler.close());
  await nodeHandler(request.raw, reply.raw, request.body);
}
