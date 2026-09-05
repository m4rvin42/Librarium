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

export type ApiError = { error: { code: string; message: string; details?: unknown } };
