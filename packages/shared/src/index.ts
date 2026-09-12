import { z } from 'zod';
export * from './isbn.js';

export const readingStatuses = [
  'unread',
  'reading',
  'read',
  'abandoned',
  'reference',
  'wishlist',
] as const;
export const ownershipStatuses = ['owned', 'wishlist', 'loaned_out', 'borrowed'] as const;
export const ReadingStatus = z.enum(readingStatuses);
export const OwnershipStatus = z.enum(ownershipStatuses);

export const BookInput = z.object({
  isbn10: z.string().nullable().optional(),
  isbn13: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().max(500).nullable().optional(),
  authors: z.array(z.string().trim().min(1).max(200)).default([]),
  publisher: z.string().max(300).nullable().optional(),
  publicationDate: z.string().max(32).nullable().optional(),
  language: z.string().max(16).nullable().optional(),
  pageCount: z.number().int().positive().nullable().optional(),
  description: z.string().max(50000).nullable().optional(),
  categories: z.array(z.string().trim().min(1).max(100)).default([]),
  coverUrl: z.string().url().nullable().optional(),
  editionFormat: z.string().max(100).nullable().optional(),
  ownershipStatus: OwnershipStatus.default('owned'),
  readingStatus: ReadingStatus.default('unread'),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(50000).nullable().optional(),
  metadataSource: z.string().max(64).nullable().optional(),
  metadataSourceId: z.string().max(200).nullable().optional(),
});
export const BookPatch = BookInput.partial();
export type BookInputType = z.infer<typeof BookInput>;

export const ReadingSessionInput = z.object({
  startedDate: z.string().nullable().optional(),
  finishedDate: z.string().nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
});

export const ImageCandidate = z.object({
  title: z.string().trim().min(1).nullable(),
  author: z.string().trim().min(1).nullable(),
  isbn10: z.string().nullable(),
  isbn13: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  visibleText: z.array(z.string().max(500)).max(100),
});
export const ImageAnalysis = z.object({ books: z.array(ImageCandidate).max(100) });

export const BookPhotoRole = z.enum(['front', 'back', 'detail']);
export const BookPhotoAnalysis = z.object({
  frontCoverCorners: z
    .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
    .length(4)
    .nullable(),
  title: z.string().max(500).nullable(),
  authors: z.array(z.string().max(200)),
  isbn: z.string().nullable(),
  subtitle: z.string().max(500).nullable(),
  publisher: z.string().max(300).nullable(),
  publicationDate: z.string().max(32).nullable(),
  language: z.string().max(16).nullable(),
  pageCount: z.number().int().positive().nullable(),
  description: z.string().max(50000).nullable(),
  visibleText: z.array(z.string().max(500)).max(100),
  confidence: z.number().min(0).max(1),
});

export const metadataProviders = ['openlibrary', 'googlebooks', 'openai-web-search'] as const;
export const MetadataProvider = z.enum(metadataProviders);
export const MetadataSettingsInput = z.object({
  providers: z
    .array(MetadataProvider)
    .min(1)
    .max(metadataProviders.length)
    .refine(
      (providers) => new Set(providers).size === providers.length,
      'Providers must be unique',
    ),
  googleBooksApiKey: z.string().trim().min(1).max(512).optional(),
  clearGoogleBooksApiKey: z.boolean().optional(),
});

export const OpenAiMetadataResult = z.object({
  title: z.string().trim().min(1).max(500).nullable(),
  subtitle: z.string().max(500).nullable(),
  authors: z.array(z.string().trim().min(1).max(200)).max(50),
  publisher: z.string().max(300).nullable(),
  publicationDate: z.string().max(32).nullable(),
  language: z.string().max(16).nullable(),
  pageCount: z.number().int().positive().nullable(),
  description: z.string().max(50000).nullable(),
  categories: z.array(z.string().trim().min(1).max(100)).max(20),
  coverUrl: z.string().url().nullable(),
  isbn10: z.string().nullable(),
  isbn13: z.string().nullable(),
  editionFormat: z.string().max(100).nullable(),
});
export const OpenAiDiscoveryResult = z.object({ books: z.array(OpenAiMetadataResult).max(10) });

export const CoverCornersInput = z.object({
  corners: z
    .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
    .length(4),
});
export const CoverDraftConfirmInput = CoverCornersInput;

export type ApiError = { error: { code: string; message: string; details?: unknown } };

export const apiCredentialScopes = [
  'library:read',
  'notes:read',
  'notes:write',
  'books:write',
  'reading:write',
  'imports:write',
  'books:delete',
] as const;
export const ApiCredentialScope = z.enum(apiCredentialScopes);
export type ApiCredentialScopeType = z.infer<typeof ApiCredentialScope>;

const optionalBooleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true')
  .optional();
const stringListQuery = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')).filter(Boolean))
  .optional();

export const BookQuery = z.object({
  search: z.string().trim().max(500).optional(),
  author: z.string().trim().max(200).optional(),
  readingStatus: stringListQuery,
  ownershipStatus: stringListQuery,
  category: z.string().trim().max(100).optional(),
  categories: stringListQuery,
  categoryMode: z.enum(['any', 'all']).default('any'),
  language: stringListQuery,
  editionFormat: stringListQuery,
  ratingMin: z.coerce.number().int().min(1).max(5).optional(),
  ratingMax: z.coerce.number().int().min(1).max(5).optional(),
  pageCountMin: z.coerce.number().int().positive().optional(),
  pageCountMax: z.coerce.number().int().positive().optional(),
  publishedFrom: z.string().max(32).optional(),
  publishedTo: z.string().max(32).optional(),
  addedAfter: z.string().datetime().optional(),
  updatedAfter: z.string().datetime().optional(),
  hasNotes: optionalBooleanQuery,
  hasDescription: optionalBooleanQuery,
  hasLocalCover: optionalBooleanQuery,
  excludeIds: stringListQuery,
  sort: z.enum(['title', 'dateAdded', 'dateUpdated', 'rating', 'relevance']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  view: z.enum(['summary', 'full']).default('full'),
});
export type BookQueryType = z.infer<typeof BookQuery>;

export const ReadingSessionQuery = z.object({
  bookId: z.string().uuid().optional(),
  author: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  ratingMin: z.coerce.number().int().min(1).max(5).optional(),
  startedAfter: z.string().max(32).optional(),
  finishedAfter: z.string().max(32).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export const RecommendationInput = z.object({
  query: z.string().trim().max(1000).default(''),
  filters: BookQuery.omit({
    search: true,
    sort: true,
    order: true,
    page: true,
    limit: true,
  }).default({
    categoryMode: 'any',
    view: 'full',
  }),
  limit: z.number().int().min(1).max(20).default(5),
  excludeIds: z.array(z.string().uuid()).max(100).default([]),
  includeExternal: z.boolean().default(false),
  rerank: z.enum(['local', 'openai']).default('local'),
});

export const DiscoveryInput = z
  .object({
    query: z.string().trim().min(1).max(500).optional(),
    author: z.string().trim().max(200).optional(),
    isbn: z.string().trim().max(32).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .refine((value) => Boolean(value.query || value.isbn), 'Provide query or isbn');

export const ApiCredentialInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiCredentialScope).min(1).max(apiCredentialScopes.length),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const RecommendationSettingsInput = z.object({
  openAiRerankingEnabled: z.boolean(),
});

export const ConfirmationAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deleteBook'), bookId: z.string().uuid() }),
  z.object({ type: z.literal('permanentlyDeleteBook'), bookId: z.string().uuid() }),
  z.object({ type: z.literal('restoreBook'), bookId: z.string().uuid() }),
  z.object({
    type: z.literal('approveImport'),
    importId: z.string().uuid(),
    candidateIds: z.array(z.string().uuid()).min(1),
    editions: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('bulkUpdateBooks'),
    bookIds: z.array(z.string().uuid()).min(1).max(100),
    patch: BookPatch,
  }),
  z.object({ type: z.literal('deleteReadingSession'), sessionId: z.string().uuid() }),
]);
export type ConfirmationActionType = z.infer<typeof ConfirmationAction>;
