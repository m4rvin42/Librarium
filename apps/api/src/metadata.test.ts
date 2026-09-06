import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const responseCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    responses = { create: responseCreate };
  },
}));

import { db } from './db.js';
import { lookupIsbn, MetadataProviderUnavailableError } from './metadata.js';
import { metadataSettingsStatus, saveMetadataSettings } from './metadata-settings.js';

const originalFetch = global.fetch;

beforeEach(() => {
  db.exec('DELETE FROM metadata_cache; DELETE FROM app_settings;');
  responseCreate.mockReset();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('metadata providers', () => {
  it('reports every provider attempt without exposing upstream errors', () => {
    const error = new MetadataProviderUnavailableError([
      { provider: 'openlibrary', outcome: 'unavailable' },
      { provider: 'googlebooks', outcome: 'unavailable' },
      { provider: 'openai-web-search', outcome: 'unavailable' },
    ]);
    expect(error.message).toBe(
      'Metadata lookup failed after trying: Open Library (unavailable); Google Books (unavailable); OpenAI web search (unavailable).',
    );
    expect(error.details).toEqual({
      attempts: [
        { provider: 'openlibrary', outcome: 'unavailable', name: 'Open Library' },
        { provider: 'googlebooks', outcome: 'unavailable', name: 'Google Books' },
        { provider: 'openai-web-search', outcome: 'unavailable', name: 'OpenAI web search' },
      ],
    });
  });

  it('uses Google Books when Open Library has no exact edition', async () => {
    saveMetadataSettings({ providers: ['openlibrary', 'googlebooks'] });
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('openlibrary.org')) return new Response(null, { status: 404 });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'google-volume-id',
              volumeInfo: {
                title: 'Fallback Book',
                authors: ['Fallback Author'],
                industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780306406157' }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await expect(lookupIsbn('9780306406157')).resolves.toMatchObject({
      title: 'Fallback Book',
      metadataSource: 'googlebooks',
      metadataSourceId: 'google-volume-id',
    });
  });

  it('encrypts saved Google Books credentials and never returns them in status', () => {
    saveMetadataSettings({ providers: ['googlebooks'], googleBooksApiKey: 'private-google-key' });
    const stored = db.prepare('SELECT value FROM app_settings WHERE key=?').get('google_books_api_key') as {
      value: string;
    };
    expect(stored.value).not.toContain('private-google-key');
    expect(metadataSettingsStatus()).toEqual({
      providers: ['googlebooks'],
      googleBooksKeyConfigured: true,
      openAiWebSearchConfigured: true,
      openAiMetadataModel: 'test-metadata-model',
      editable: true,
      usingSavedProviders: true,
      usingSavedGoogleBooksKey: true,
    });
  });

  it('uses OpenAI web search only after catalog providers miss', async () => {
    saveMetadataSettings({ providers: ['openlibrary', 'googlebooks', 'openai-web-search'] });
    global.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
    responseCreate.mockResolvedValue({
      output_text: JSON.stringify({
        title: 'Web Search Book',
        subtitle: null,
        authors: ['Search Author'],
        publisher: null,
        publicationDate: null,
        language: 'en',
        pageCount: null,
        description: null,
        categories: [],
        coverUrl: null,
        isbn10: '0306406152',
        isbn13: '9780306406157',
        editionFormat: null,
      }),
    });

    await expect(lookupIsbn('9780306406157')).resolves.toMatchObject({
      title: 'Web Search Book',
      metadataSource: 'openai-web-search',
    });
    expect(responseCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-metadata-model', tools: [{ type: 'web_search' }] }),
    );
  });

  it('rejects an OpenAI result with a different ISBN', async () => {
    saveMetadataSettings({ providers: ['openai-web-search'] });
    responseCreate.mockResolvedValue({
      output_text: JSON.stringify({
        title: 'Wrong Edition',
        subtitle: null,
        authors: [],
        publisher: null,
        publicationDate: null,
        language: null,
        pageCount: null,
        description: null,
        categories: [],
        coverUrl: null,
        isbn10: null,
        isbn13: '9780441172719',
        editionFormat: null,
      }),
    });

    await expect(lookupIsbn('9780306406157')).resolves.toBeNull();
  });
});
