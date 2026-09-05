import { parseIsbn } from '@librarium/shared';
import { db, now } from './db.js';
import { config } from './config.js';

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': `Librarium/1.0 (${config.contact || 'self-hosted'})`,
          accept: 'application/json',
        },
      });
      if (response.ok) return response.json();
      if (response.status === 404) return null;
      if (response.status < 500 && response.status !== 429)
        throw new Error(`Metadata provider returned ${response.status}`);
    } catch (cause) {
      if (attempt === 2) throw new Error('Metadata provider unavailable after retries', { cause });
    } finally {
      clearTimeout(timer);
    }
    await delay(350 * (attempt + 1));
  }
  throw new Error('Metadata provider unavailable after retries');
}

function mapDoc(doc: any, isbn?: string): MetadataBook {
  let isbn10: string | null = null,
    isbn13: string | null = null;
  const candidate = isbn || doc.isbn?.find((x: string) => x.length === 13) || doc.isbn?.[0];
  if (candidate)
    try {
      ({ isbn10, isbn13 } = parseIsbn(candidate));
    } catch {
      /* ignore invalid provider ISBN */
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

export async function lookupIsbn(value: string): Promise<MetadataBook | null> {
  const parsed = parseIsbn(value),
    key = `isbn:${parsed.isbn13}`;
  const cached = db
    .prepare('SELECT value FROM metadata_cache WHERE cache_key=? AND expires_at>?')
    .get(key, now()) as any;
  if (cached) return JSON.parse(cached.value);
  const data = (await fetchJson(`https://openlibrary.org/isbn/${parsed.isbn13}.json`)) as any;
  if (!data) {
    const search = (await fetchJson(
      `https://openlibrary.org/search.json?isbn=${parsed.isbn13}&limit=5`,
    )) as any;
    const exact = (search?.docs ?? []).find((doc: any) =>
      (doc.isbn ?? []).some((candidate: string) => {
        try {
          return parseIsbn(candidate).isbn13 === parsed.isbn13;
        } catch {
          return false;
        }
      }),
    );
    if (!exact) return null;
    const book = mapDoc(exact, parsed.isbn13);
    db.prepare(
      'INSERT OR REPLACE INTO metadata_cache(cache_key,value,expires_at) VALUES(?,?,?)',
    ).run(key, JSON.stringify(book), new Date(Date.now() + 7 * 86_400_000).toISOString());
    return book;
  }
  const authors: string[] = [];
  for (const author of data.authors ?? []) {
    const a = (await fetchJson(`https://openlibrary.org${author.key}.json`)) as any;
    if (a?.name) authors.push(a.name);
    await delay(100);
  }
  const book = mapDoc({ ...data, author_name: authors }, parsed.isbn13);
  db.prepare('INSERT OR REPLACE INTO metadata_cache(cache_key,value,expires_at) VALUES(?,?,?)').run(
    key,
    JSON.stringify(book),
    new Date(Date.now() + 7 * 86_400_000).toISOString(),
  );
  return book;
}

export async function searchMetadata(title: string, author?: string): Promise<MetadataBook[]> {
  const params = new URLSearchParams({ title, limit: '5' });
  if (author) params.set('author', author);
  const data = (await fetchJson(`https://openlibrary.org/search.json?${params}`)) as any;
  return (data?.docs ?? []).map((doc: any) => mapDoc(doc));
}
