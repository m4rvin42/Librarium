import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('assistant API migration', () => {
  it('is idempotent and preserves an existing catalog', () => {
    const target = path.join('/tmp', `librarium-migration-${process.pid}-${Date.now()}.sqlite`);
    const database = new Database(target);
    try {
      database.exec(fs.readFileSync(path.resolve('src/schema.sql'), 'utf8'));
      database
        .prepare(
          `INSERT INTO books(
            id,title,ownership_status,reading_status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?)`,
        )
        .run('existing-book', 'Existing Book', 'owned', 'unread', '2026-01-01', '2026-01-01');
      const migration = fs.readFileSync(path.resolve('migrations/0004_assistant_api.sql'), 'utf8');
      database.exec(migration);
      database.exec(migration);
      expect(database.prepare('SELECT title FROM books WHERE id=?').get('existing-book')).toEqual({
        title: 'Existing Book',
      });
      expect(
        database
          .prepare("SELECT book_id FROM book_search_fts WHERE book_search_fts MATCH 'Existing'")
          .get(),
      ).toEqual({ book_id: 'existing-book' });
    } finally {
      database.close();
      fs.rmSync(target, { force: true });
    }
  });
});
