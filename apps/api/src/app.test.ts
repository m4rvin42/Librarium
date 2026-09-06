import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildApp } from './app.js';
import { db, id, now } from './db.js';

const app = await buildApp();
beforeEach(() => {
  db.exec(
    'DELETE FROM reading_sessions; DELETE FROM import_candidates; DELETE FROM import_images; DELETE FROM import_batches; DELETE FROM book_authors; DELETE FROM book_categories; DELETE FROM books; DELETE FROM authors; DELETE FROM categories; DELETE FROM sessions;',
  );
});
afterAll(() => app.close());
const bearer = { authorization: 'Bearer test-token' };

describe('API', () => {
  it('requires authentication', async () => {
    expect((await app.inject({ url: '/api/v1/books' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/books', headers: bearer })).statusCode).toBe(200);
  });
  it('supports login and CSRF', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/books',
          headers: { cookie },
          payload: { title: 'Dune', authors: ['Frank Herbert'] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/books',
          headers: { cookie, 'x-csrf-token': login.json().csrfToken },
          payload: { title: 'Dune', authors: ['Frank Herbert'] },
        })
      ).statusCode,
    ).toBe(201);
  });
  it('creates, searches, patches, exports, and deletes books', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/books',
      headers: bearer,
      payload: {
        title: 'Foundation',
        authors: ['Isaac Asimov'],
        isbn13: '9780553293357',
        categories: ['SF'],
      },
    });
    expect(created.statusCode).toBe(201);
    const book = created.json();
    expect(
      (await app.inject({ url: '/api/v1/books?search=asimov', headers: bearer })).json().total,
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/books/${book.id}`,
          headers: bearer,
          payload: { readingStatus: 'read' },
        })
      ).json().readingStatus,
    ).toBe('read');
    const exported = (await app.inject({ url: '/api/v1/export/json', headers: bearer })).json();
    expect(exported.schemaVersion).toBe(1);
    expect(exported.books).toHaveLength(1);
    const dryRun = await app.inject({
      method: 'POST',
      url: '/api/v1/import/json',
      headers: bearer,
      payload: { document: exported, dryRun: true, strategy: 'skip' },
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().summary.conflicts).toHaveLength(1);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/books/${book.id}`, headers: bearer }))
        .statusCode,
    ).toBe(204);
  });
  it('detects duplicate ISBNs', async () => {
    const payload = { title: 'Dune', authors: ['Frank Herbert'], isbn13: '9780441172719' };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/books', headers: bearer, payload }))
        .statusCode,
    ).toBe(201);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/books',
      headers: bearer,
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CONFLICT');
  });
  it('stores and serves a local cover for an existing book', async () => {
    const book = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/books',
        headers: bearer,
        payload: { title: 'Cover Book', authors: [] },
      })
    ).json();
    const boundary = 'librarium-cover-test';
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="useAsCover"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="cover.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const enriched = await app.inject({
      method: 'POST',
      url: `/api/v1/books/${book.id}/enrich`,
      headers: { ...bearer, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(enriched.statusCode).toBe(201);
    expect(enriched.json().coverUpdated).toBe(true);
    const cover = await app.inject({ url: `/api/v1/books/${book.id}/cover`, headers: bearer });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toContain('image/jpeg');
  });
  it('keeps AI candidates pending until approval', async () => {
    const batch = id(),
      candidate = id(),
      timestamp = now();
    db.prepare(
      'INSERT INTO import_batches(id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run(batch, 'images', 'review', timestamp, timestamp);
    db.prepare(
      'INSERT INTO import_candidates(id,batch_id,title,author,isbn13,confidence,evidence,metadata,alternatives,review_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      candidate,
      batch,
      'Dune',
      'Frank Herbert',
      '9780441172719',
      0.9,
      '["DUNE"]',
      JSON.stringify({
        title: 'Dune',
        subtitle: null,
        authors: ['Frank Herbert'],
        publisher: null,
        publicationDate: null,
        language: 'en',
        pageCount: null,
        description: null,
        categories: [],
        coverUrl: null,
        isbn10: '0441172717',
        isbn13: '9780441172719',
        editionFormat: null,
        metadataSource: 'test',
        metadataSourceId: null,
      }),
      '[]',
      'pending',
      timestamp,
      timestamp,
    );
    expect((await app.inject({ url: '/api/v1/books', headers: bearer })).json().total).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/imports/${batch}/approve`,
          headers: bearer,
          payload: { candidateIds: [candidate] },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/v1/books', headers: bearer })).json().total).toBe(1);
  });
  it('allows explicit approval of a titled AI candidate without a metadata match', async () => {
    const batch = id(),
      candidate = id(),
      timestamp = now();
    db.prepare(
      'INSERT INTO import_batches(id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run(batch, 'images', 'review', timestamp, timestamp);
    db.prepare(
      'INSERT INTO import_candidates(id,batch_id,title,author,confidence,evidence,alternatives,review_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      candidate,
      batch,
      'A Visible Book',
      'A Visible Author',
      0.81,
      '["A VISIBLE BOOK"]',
      '[]',
      'pending',
      timestamp,
      timestamp,
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${batch}/approve`,
      headers: bearer,
      payload: { candidateIds: [candidate] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().created[0]).toMatchObject({
      title: 'A Visible Book',
      authors: ['A Visible Author'],
      metadataSource: 'image-analysis',
    });
  });
});
