import { BookInput } from '@librarium/shared';
import { createBook, listBooks } from './repository.js';
if (!listBooks({}).total) {
  createBook(
    BookInput.parse({
      title: 'The Left Hand of Darkness',
      authors: ['Ursula K. Le Guin'],
      isbn13: '9780441478125',
      categories: ['Science Fiction'],
      readingStatus: 'read',
      ownershipStatus: 'owned',
      rating: 5,
      notes: 'Demo record',
    }),
  );
  console.log('Demo book created');
} else console.log('Database already contains books');
