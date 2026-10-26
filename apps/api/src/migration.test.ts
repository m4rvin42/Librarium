import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('database migrations', () => {
  it('is idempotent and preserves an existing catalog', () => {
    const target = path.join('/tmp', `librarium-migration-${process.pid}-${Date.now()}.sqlite`);
    const database = new Database(target);
    try {
      database.exec(fs.readFileSync(path.resolve('src/schema.sql'), 'utf8'));
      // Recreate the shape of a pre-0005 database while retaining a real catalog row.
      database.exec('DROP TABLE book_images');
      database
        .prepare(
          `INSERT INTO books(
            id,title,ownership_status,reading_status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?)`,
        )
        .run('existing-book', 'Existing Book', 'owned', 'unread', '2026-01-01', '2026-01-01');
      const migration = fs.readFileSync(path.resolve('migrations/0004_assistant_api.sql'), 'utf8');
      const imageMigration = fs.readFileSync(
        path.resolve('migrations/0005_book_images.sql'),
        'utf8',
      );
      database.exec(migration);
      database.exec(migration);
      database.exec(imageMigration);
      database.exec(imageMigration);
      expect(database.prepare('SELECT title FROM books WHERE id=?').get('existing-book')).toEqual({
        title: 'Existing Book',
      });
      expect(
        database
          .prepare("SELECT book_id FROM book_search_fts WHERE book_search_fts MATCH 'Existing'")
          .get(),
      ).toEqual({ book_id: 'existing-book' });
      database
        .prepare(
          'INSERT INTO book_images(id,book_id,kind,path,mime_type,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          'back-image',
          'existing-book',
          'back_cover',
          'books/existing-book/back.jpg',
          'image/jpeg',
          '2026-01-01',
        );
      expect(
        database.prepare("SELECT kind FROM book_images WHERE book_id='existing-book'").get(),
      ).toEqual({ kind: 'back_cover' });
    } finally {
      database.close();
      fs.rmSync(target, { force: true });
    }
  });
});
