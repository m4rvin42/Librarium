import { describe, expect, it } from 'vitest';
import { ImageAnalysis } from './index.js';
describe('AI response validation', () => {
  it('rejects malformed or invented shapes', () => {
    expect(ImageAnalysis.safeParse({ books: [{ title: 'Dune' }] }).success).toBe(false);
    expect(
      ImageAnalysis.safeParse({
        books: [
          {
            title: 'Dune',
            author: null,
            isbn10: null,
            isbn13: null,
            confidence: 2,
            visibleText: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('accepts a constrained candidate', () => {
    expect(
      ImageAnalysis.safeParse({
        books: [
          {
            title: 'Dune',
            author: 'Frank Herbert',
            isbn10: null,
            isbn13: null,
            confidence: 0.8,
            visibleText: ['DUNE'],
          },
        ],
      }).success,
    ).toBe(true);
  });
});
