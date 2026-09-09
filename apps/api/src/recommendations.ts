import OpenAI from 'openai';
import { RecommendationInput } from '@librarium/shared';
import { config } from './config.js';
import { db } from './db.js';
import { recommendationConfiguration } from './recommendation-settings.js';
import { listBooks } from './repository.js';

function words(value: string) {
  return new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1),
  );
}

function textScore(book: any, query: string) {
  const wanted = words(query);
  if (!wanted.size) return 0;
  const available = words(
    [
      book.title,
      book.subtitle,
      book.authors?.join(' '),
      book.publisher,
      book.description,
      book.categories?.join(' '),
    ]
      .filter(Boolean)
      .join(' '),
  );
  return [...wanted].filter((word) => available.has(word)).length / wanted.size;
}

function preferenceProfile() {
  const rows = db
    .prepare(
      `SELECT b.id,b.rating,a.name author,c.name category
       FROM books b
       LEFT JOIN book_authors ba ON ba.book_id=b.id LEFT JOIN authors a ON a.id=ba.author_id
       LEFT JOIN book_categories bc ON bc.book_id=b.id LEFT JOIN categories c ON c.id=bc.category_id
       WHERE b.rating>=4 AND NOT EXISTS(SELECT 1 FROM book_trash t WHERE t.book_id=b.id)`,
    )
    .all() as any[];
  return {
    authors: new Set(rows.map((row) => row.author).filter(Boolean)),
    categories: new Set(rows.map((row) => row.category).filter(Boolean)),
  };
}

function localRank(input: ReturnType<typeof RecommendationInput.parse>) {
  const candidates = listBooks(
    {
      ...input.filters,
      search: input.query || undefined,
      excludeIds: [...new Set([...(input.filters.excludeIds ?? []), ...input.excludeIds])],
      view: 'full',
      limit: 100,
      page: 1,
    },
    { includeNotes: false },
  ).items as any[];
  const profile = preferenceProfile();
  return candidates
    .map((book) => {
      const text = textScore(book, input.query);
      const authorAffinity = book.authors?.some((author: string) => profile.authors.has(author));
      const categoryMatches =
        book.categories?.filter((category: string) => profile.categories.has(category)).length ?? 0;
      const affinity = Math.min(
        1,
        (authorAffinity ? 0.6 : 0) + Math.min(0.4, categoryMatches * 0.2),
      );
      const rating = book.rating ? (book.rating - 1) / 4 : 0.5;
      const novelty =
        book.readingStatus === 'unread' ? 1 : book.readingStatus === 'reading' ? 0.5 : 0;
      const score = input.query
        ? 0.55 * text + 0.2 * affinity + 0.15 * rating + 0.1 * novelty
        : 0.45 * affinity + 0.3 * rating + 0.25 * novelty;
      const reasons = [
        ...(text > 0 ? ['Matches the requested title, author, or subject terms'] : []),
        ...(authorAffinity ? ['Author appears among highly rated books'] : []),
        ...(categoryMatches
          ? [`Matches ${categoryMatches} preferred categor${categoryMatches === 1 ? 'y' : 'ies'}`]
          : []),
        ...(book.rating ? [`Rated ${book.rating} out of 5`] : []),
        ...(book.readingStatus === 'unread' ? ['Owned and not yet read'] : []),
      ].slice(0, 4);
      return {
        book,
        score: Math.round(score * 1000) / 1000,
        signals: { text, affinity, rating, novelty },
        reasons: reasons.length ? reasons : ['Matches the selected library constraints'],
        source: 'library' as const,
      };
    })
    .sort((a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title));
}

async function rerankWithOpenAi(query: string, candidates: any[]) {
  const client = new OpenAI({ apiKey: config.openAiKey });
  const response = await client.responses.create({
    model: config.recommendationModel,
    store: false,
    input: `Rank these books for the request: ${query || 'Recommend from my library'}. Use only the supplied metadata and return every supplied id once.\n${JSON.stringify(
      candidates.slice(0, 20).map(({ book }) => ({
        id: book.id,
        title: book.title,
        subtitle: book.subtitle,
        authors: book.authors,
        publisher: book.publisher,
        publicationDate: book.publicationDate,
        language: book.language,
        pageCount: book.pageCount,
        description: book.description,
        categories: book.categories,
        editionFormat: book.editionFormat,
        rating: book.rating,
      })),
    )}`,
    text: {
      format: {
        type: 'json_schema',
        name: 'library_recommendations',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['results'],
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'reason'],
                properties: { id: { type: 'string' }, reason: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  });
  const parsed = JSON.parse(response.output_text) as { results: { id: string; reason: string }[] };
  const byId = new Map(candidates.map((candidate) => [candidate.book.id, candidate]));
  const seen = new Set<string>();
  const ordered = parsed.results.flatMap((entry) => {
    const candidate = byId.get(entry.id);
    if (!candidate || seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [{ ...candidate, reasons: [entry.reason, ...candidate.reasons].slice(0, 4) }];
  });
  return [...ordered, ...candidates.filter((candidate) => !seen.has(candidate.book.id))];
}

export async function recommendBooks(raw: unknown) {
  const input = RecommendationInput.parse(raw);
  let candidates = localRank(input);
  let rerank = { requested: input.rerank, applied: false, warning: null as string | null };
  if (input.rerank === 'openai') {
    const settings = recommendationConfiguration();
    if (!settings.openAiRerankingEnabled || !config.openAiKey) {
      rerank.warning = 'OpenAI reranking is not enabled or configured; local ranking was used';
    } else {
      try {
        candidates = await rerankWithOpenAi(input.query, candidates);
        rerank = { requested: input.rerank, applied: true, warning: null };
      } catch {
        rerank.warning = 'OpenAI reranking was unavailable; local ranking was used';
      }
    }
  }
  const results = candidates.slice(0, input.limit).map((candidate) => {
    const book = { ...candidate.book };
    delete book.localCover;
    delete book.coverUrl;
    return {
      ...candidate,
      book: {
        ...book,
        coverAvailable: Boolean(candidate.book.localCover || candidate.book.coverUrl),
      },
    };
  });
  return { results, rerank };
}
