import OpenAI from 'openai';
import { OpenAiDiscoveryResult, OpenAiMetadataResult, parseIsbn } from '@librarium/shared';
import { db, now } from './db.js';
import { config } from './config.js';
import { metadataConfiguration } from './metadata-settings.js';

export type MetadataBook = {
  title: string;
  subtitle: string | null;
  authors: string[];
  publisher: string | null;
  publicationDate: string | null;
  language: string | null;
  pageCount: number | null;
  description: string | null;
  categories: string[];
  coverUrl: string | null;
  isbn10: string | null;
  isbn13: string | null;
  editionFormat: string | null;
  metadataSource: string;
  metadataSourceId: string | null;
};

type MetadataProvider = 'openlibrary' | 'googlebooks' | 'openai-web-search';
type ProviderAttempt = {
  provider: MetadataProvider;
  outcome: 'unavailable' | 'not_found' | 'not_configured';
};

const providerName: Record<MetadataProvider, string> = {
  openlibrary: 'Open Library',
  googlebooks: 'Google Books',
  'openai-web-search': 'OpenAI web search',
};

export class MetadataProviderUnavailableError extends Error {
  statusCode = 503;
  code = 'METADATA_PROVIDER_UNAVAILABLE';
  details: { attempts: Array<ProviderAttempt & { name: string }> };

  constructor(attempts: ProviderAttempt[]) {
    const details = attempts.map((attempt) => ({
      ...attempt,
      name: providerName[attempt.provider],
    }));
    super(
      `Metadata lookup failed after trying: ${details
        .map(({ name, outcome }) => `${name} (${outcome.replace('_', ' ')})`)
        .join('; ')}.`,
    );
    this.details = { attempts: details };
  }
}

class ProviderUnavailableError extends Error {}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string, provider: MetadataProvider) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': `Librarium/1.0 (${config.openLibraryContact || 'self-hosted'})`,
          accept: 'application/json',
        },
      });
      if (response.ok) return response.json();
      if (response.status === 404) return null;
      if (response.status < 500 && response.status !== 429)
        throw new ProviderUnavailableError(`${provider} returned ${response.status}`);
    } catch (cause) {
      if (cause instanceof ProviderUnavailableError || attempt === 2)
        throw new ProviderUnavailableError(`${provider} is unavailable`);
    } finally {
      clearTimeout(timer);
    }
    await delay(350 * (attempt + 1));
  }
  throw new ProviderUnavailableError(`${provider} is unavailable`);
}

function mapOpenLibraryDoc(doc: any, isbn?: string): MetadataBook {
  let isbn10: string | null = null;
  let isbn13: string | null = null;
  const candidate = isbn || doc.isbn?.find((value: string) => value.length === 13) || doc.isbn?.[0];
  if (candidate)
    try {
      ({ isbn10, isbn13 } = parseIsbn(candidate));
    } catch {
      isbn10 = null;
      isbn13 = null;
    }
  return {
    title: doc.title,
    subtitle: doc.subtitle ?? null,
    authors: doc.author_name ?? [],
    publisher: doc.publisher?.[0] ?? doc.publishers?.[0] ?? null,
    publicationDate: doc.first_publish_year
      ? String(doc.first_publish_year)
      : (doc.publish_date ?? null),
    language: doc.language?.[0] ?? null,
    pageCount: doc.number_of_pages_median ?? doc.number_of_pages ?? null,
    description:
      typeof doc.description === 'string' ? doc.description : (doc.description?.value ?? null),
    categories: (doc.subject ?? doc.subjects ?? []).slice(0, 20),
    coverUrl: doc.cover_i
      ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
      : isbn13
        ? `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`
        : null,
    isbn10,
    isbn13,
    editionFormat: doc.physical_format ?? null,
    metadataSource: 'openlibrary',
    metadataSourceId: doc.key ?? null,
  };
}

function mapGoogleBook(volume: any, isbn: string): MetadataBook | null {
  const info = volume.volumeInfo ?? {};
  let isbn10: string | null = null;
  let isbn13: string | null = null;
  for (const identifier of info.industryIdentifiers ?? []) {
    try {
      const parsed = parseIsbn(identifier.identifier || '');
      isbn10 ||= parsed.isbn10;
      isbn13 ||= parsed.isbn13;
    } catch {
      continue;
    }
  }
  if (isbn13 !== isbn || !info.title) return null;
  return {
    title: info.title,
    subtitle: info.subtitle ?? null,
    authors: info.authors ?? [],
    publisher: info.publisher ?? null,
    publicationDate: info.publishedDate ?? null,
    language: info.language ?? null,
    pageCount: info.pageCount ?? null,
    description: info.description ?? null,
    categories: (info.categories ?? []).slice(0, 20),
    coverUrl: info.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? null,
    isbn10,
    isbn13,
    editionFormat: info.printType ?? null,
    metadataSource: 'googlebooks',
    metadataSourceId: volume.id ?? null,
  };
}

function mapGoogleSearchBook(volume: any): MetadataBook | null {
  const info = volume.volumeInfo ?? {};
  if (!info.title) return null;
  let isbn10: string | null = null;
  let isbn13: string | null = null;
  for (const identifier of info.industryIdentifiers ?? [])
    try {
      ({ isbn10, isbn13 } = parseIsbn(identifier.identifier || ''));
      if (isbn13) break;
    } catch {
      continue;
    }
  return {
    title: info.title,
    subtitle: info.subtitle ?? null,
    authors: info.authors ?? [],
    publisher: info.publisher ?? null,
    publicationDate: info.publishedDate ?? null,
    language: info.language ?? null,
    pageCount: info.pageCount ?? null,
    description: info.description ?? null,
    categories: (info.categories ?? []).slice(0, 20),
    coverUrl: info.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? null,
    isbn10,
    isbn13,
    editionFormat: info.printType ?? null,
    metadataSource: 'googlebooks',
    metadataSourceId: volume.id ?? null,
  };
}

function mapOpenAiBook(value: unknown, isbn: string): MetadataBook | null {
  const result = OpenAiMetadataResult.safeParse(value);
  if (!result.success || !result.data.title) return null;
  const candidate = result.data.isbn13 || result.data.isbn10;
  if (!candidate) return null;
  try {
    const parsed = parseIsbn(candidate);
    if (parsed.isbn13 !== isbn) return null;
    return {
      ...result.data,
      title: result.data.title,
      isbn10: parsed.isbn10,
      isbn13: parsed.isbn13,
      metadataSource: 'openai-web-search',
      metadataSourceId: null,
    };
  } catch {
    return null;
  }
}

async function lookupOpenLibrary(isbn: string) {
  const data = (await fetchJson(`https://openlibrary.org/isbn/${isbn}.json`, 'openlibrary')) as any;
  if (!data) {
    const search = (await fetchJson(
      `https://openlibrary.org/search.json?isbn=${isbn}&limit=5`,
      'openlibrary',
    )) as any;
    const exact = (search?.docs ?? []).find((doc: any) =>
      (doc.isbn ?? []).some((candidate: string) => {
        try {
          return parseIsbn(candidate).isbn13 === isbn;
        } catch {
          return false;
        }
      }),
    );
    return exact ? mapOpenLibraryDoc(exact, isbn) : null;
  }
  const authors: string[] = [];
  for (const author of data.authors ?? []) {
    const person = (await fetchJson(
      `https://openlibrary.org${author.key}.json`,
      'openlibrary',
    )) as any;
    if (person?.name) authors.push(person.name);
    await delay(100);
  }
  return mapOpenLibraryDoc({ ...data, author_name: authors }, isbn);
}

async function lookupGoogleBooks(isbn: string, apiKey: string) {
  const params = new URLSearchParams({ q: `isbn:${isbn}`, maxResults: '5' });
  if (apiKey) params.set('key', apiKey);
  const data = (await fetchJson(
    `https://www.googleapis.com/books/v1/volumes?${params}`,
    'googlebooks',
  )) as any;
  return (
    (data?.items ?? []).map((volume: any) => mapGoogleBook(volume, isbn)).find(Boolean) ?? null
  );
}

async function lookupOpenAiWebSearch(isbn: string) {
  if (!config.openAiKey) return null;
  const client = new OpenAI({ apiKey: config.openAiKey });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.responses.create({
        model: config.metadataModel,
        store: false,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        input: `Use web search to find the exact book edition with ISBN ${isbn}. Return only verified edition metadata. Do not guess; if the exact ISBN cannot be verified, return null title and null ISBN fields.`,
        text: {
          format: {
            type: 'json_schema',
            name: 'isbn_metadata',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'title',
                'subtitle',
                'authors',
                'publisher',
                'publicationDate',
                'language',
                'pageCount',
                'description',
                'categories',
                'coverUrl',
                'isbn10',
                'isbn13',
                'editionFormat',
              ],
              properties: {
                title: { type: ['string', 'null'] },
                subtitle: { type: ['string', 'null'] },
                authors: { type: 'array', items: { type: 'string' } },
                publisher: { type: ['string', 'null'] },
                publicationDate: { type: ['string', 'null'] },
                language: { type: ['string', 'null'] },
                pageCount: { type: ['integer', 'null'] },
                description: { type: ['string', 'null'] },
                categories: { type: 'array', items: { type: 'string' } },
                coverUrl: { type: ['string', 'null'] },
                isbn10: { type: ['string', 'null'] },
                isbn13: { type: ['string', 'null'] },
                editionFormat: { type: ['string', 'null'] },
              },
            },
          },
        },
      });
      try {
        return mapOpenAiBook(JSON.parse(response.output_text), isbn);
      } catch {
        return null;
      }
    } catch {
      if (attempt === 2) throw new ProviderUnavailableError('openai-web-search is unavailable');
      await delay(350 * (attempt + 1));
    }
  }
  throw new ProviderUnavailableError('openai-web-search is unavailable');
}

async function searchOpenAiWeb(title: string, author?: string) {
  if (!config.openAiKey) return [];
  const client = new OpenAI({ apiKey: config.openAiKey });
  const nullableString = { type: ['string', 'null'] } as const;
  const properties = {
    title: nullableString,
    subtitle: nullableString,
    authors: { type: 'array', items: { type: 'string' } },
    publisher: nullableString,
    publicationDate: nullableString,
    language: nullableString,
    pageCount: { type: ['integer', 'null'] },
    description: nullableString,
    categories: { type: 'array', items: { type: 'string' } },
    coverUrl: nullableString,
    isbn10: nullableString,
    isbn13: nullableString,
    editionFormat: nullableString,
  };
  const response = await client.responses.create({
    model: config.metadataModel,
    store: false,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    input: `Find up to 10 real book editions matching title/query ${JSON.stringify(title)}${
      author ? ` and author ${JSON.stringify(author)}` : ''
    }. Return only verifiable metadata and do not invent identifiers.`,
    text: {
      format: {
        type: 'json_schema',
        name: 'book_discovery',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['books'],
          properties: {
            books: {
              type: 'array',
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                required: Object.keys(properties),
                properties,
              },
            },
          },
        },
      },
    },
  });
  const parsed = OpenAiDiscoveryResult.parse(JSON.parse(response.output_text));
  return parsed.books.flatMap((book) => {
    if (!book.title) return [];
    let isbn10 = book.isbn10;
    let isbn13 = book.isbn13;
    if (isbn13 || isbn10)
      try {
        ({ isbn10, isbn13 } = parseIsbn(isbn13 || isbn10!));
      } catch {
        isbn10 = null;
        isbn13 = null;
      }
    return [
      {
        ...book,
        title: book.title,
        isbn10,
        isbn13,
        metadataSource: 'openai-web-search',
        metadataSourceId: null,
      } satisfies MetadataBook,
    ];
  });
}

function cacheBook(key: string, book: MetadataBook) {
  db.prepare('INSERT OR REPLACE INTO metadata_cache(cache_key,value,expires_at) VALUES(?,?,?)').run(
    key,
    JSON.stringify(book),
    new Date(Date.now() + 7 * 86_400_000).toISOString(),
  );
}

export async function lookupIsbn(value: string): Promise<MetadataBook | null> {
  const parsed = parseIsbn(value);
  const key = `isbn:${parsed.isbn13}`;
  const cached = db
    .prepare('SELECT value FROM metadata_cache WHERE cache_key=? AND expires_at>?')
    .get(key, now()) as { value: string } | undefined;
  if (cached) return JSON.parse(cached.value);

  const settings = metadataConfiguration();
  let providerResponded = false;
  const attempts: ProviderAttempt[] = [];
  for (const provider of settings.providers) {
    if (provider === 'openai-web-search' && !config.openAiKey) {
      attempts.push({ provider, outcome: 'not_configured' });
      continue;
    }
    try {
      const book =
        provider === 'openlibrary'
          ? await lookupOpenLibrary(parsed.isbn13)
          : provider === 'googlebooks'
            ? await lookupGoogleBooks(parsed.isbn13, settings.googleBooksApiKey)
            : await lookupOpenAiWebSearch(parsed.isbn13);
      providerResponded = true;
      if (book) {
        cacheBook(key, book);
        return book;
      }
      attempts.push({ provider, outcome: 'not_found' });
    } catch (cause) {
      if (!(cause instanceof ProviderUnavailableError)) throw cause;
      attempts.push({ provider, outcome: 'unavailable' });
    }
  }
  if (!providerResponded) throw new MetadataProviderUnavailableError(attempts);
  return null;
}

export async function searchMetadata(title: string, author?: string): Promise<MetadataBook[]> {
  const settings = metadataConfiguration();
  const results: MetadataBook[] = [];
  for (const provider of settings.providers) {
    try {
      if (provider === 'openlibrary') {
        const params = new URLSearchParams({ title, limit: '10' });
        if (author) params.set('author', author);
        const data = (await fetchJson(
          `https://openlibrary.org/search.json?${params}`,
          'openlibrary',
        )) as any;
        results.push(...(data?.docs ?? []).map((doc: any) => mapOpenLibraryDoc(doc)));
      } else if (provider === 'googlebooks') {
        const query = [`intitle:${title}`, ...(author ? [`inauthor:${author}`] : [])].join('+');
        const params = new URLSearchParams({ q: query, maxResults: '10' });
        if (settings.googleBooksApiKey) params.set('key', settings.googleBooksApiKey);
        const data = (await fetchJson(
          `https://www.googleapis.com/books/v1/volumes?${params}`,
          'googlebooks',
        )) as any;
        results.push(...(data?.items ?? []).map(mapGoogleSearchBook).filter(Boolean));
      } else if (provider === 'openai-web-search') {
        results.push(...(await searchOpenAiWeb(title, author)));
      }
    } catch {
      continue;
    }
  }
  const unique = new Map<string, MetadataBook>();
  for (const book of results) {
    const key = book.isbn13 || `${book.metadataSource}:${book.metadataSourceId}`;
    if (key && !unique.has(key)) unique.set(key, book);
  }
  return [...unique.values()].slice(0, 20);
}
