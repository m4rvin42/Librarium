import { describe, expect, it } from 'vitest';
import {
  detectedIsbnCandidates,
  extractIsbns,
  isbn10To13,
  isbn13To10,
  isValidIsbn10,
  isValidIsbn13,
} from './isbn.js';
describe('ISBN', () => {
  it('validates checksums', () => {
    expect(isValidIsbn10('0-306-40615-2')).toBe(true);
    expect(isValidIsbn13('9780306406157')).toBe(true);
    expect(isValidIsbn13('9780306406158')).toBe(false);
    expect(isValidIsbn13('4006381333931')).toBe(false);
  });
  it('converts formats', () => {
    expect(isbn10To13('0306406152')).toBe('9780306406157');
    expect(isbn13To10('9780306406157')).toBe('0306406152');
  });
  it('extracts formatted bulk input', () => {
    expect(extractIsbns('0-306-40615-2, 978 0 306 40615 7')).toEqual(['9780306406157']);
  });
  it('cleans common OCR noise and isolates an ISBN from surrounding characters', () => {
    expect(detectedIsbnCandidates('ISBN: 978-O-306-40615-7')).toEqual([
      expect.objectContaining({ isbn13: '9780306406157', kind: 'ocr-cleaned' }),
    ]);
    expect(detectedIsbnCandidates('ref 99 / 978-0-306-40615-7 / page 12')).toEqual([
      expect.objectContaining({ isbn13: '9780306406157', kind: 'ocr-cleaned' }),
    ]);
  });
  it('suggests only a corrected check digit when checksum validation fails', () => {
    expect(detectedIsbnCandidates('9780306406158')).toEqual([
      expect.objectContaining({
        isbn13: '9780306406157',
        kind: 'checksum-corrected',
        source: '9780306406158',
      }),
    ]);
  });
});
