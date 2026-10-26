export const normalizeIsbn = (value: string): string => value.toUpperCase().replace(/[^0-9X]/g, '');

export type DetectedIsbnCandidate = {
  isbn10: string | null;
  isbn13: string;
  kind: 'exact' | 'ocr-cleaned' | 'checksum-corrected';
  source: string;
};

export function isValidIsbn10(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  const sum = [...isbn].reduce((total, char, index) => {
    const digit = char === 'X' ? 10 : Number(char);
    return total + digit * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

export function isValidIsbn13(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^97[89]\d{10}$/.test(isbn)) return false;
  const sum = [...isbn.slice(0, 12)].reduce(
    (total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 === Number(isbn[12]);
}

export function isbn10To13(value: string): string {
  const isbn = normalizeIsbn(value);
  if (!isValidIsbn10(isbn)) throw new Error('Invalid ISBN-10 checksum');
  const base = `978${isbn.slice(0, 9)}`;
  const sum = [...base].reduce(
    (total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

export function isbn13To10(value: string): string | null {
  const isbn = normalizeIsbn(value);
  if (!isValidIsbn13(isbn)) throw new Error('Invalid ISBN-13 checksum');
  if (!isbn.startsWith('978')) return null;
  const base = isbn.slice(3, 12);
  const sum = [...base].reduce((total, char, index) => total + Number(char) * (10 - index), 0);
  const check = (11 - (sum % 11)) % 11;
  return `${base}${check === 10 ? 'X' : check}`;
}

export function parseIsbn(value: string) {
  const normalized = normalizeIsbn(value);
  if (isValidIsbn10(normalized))
    return { normalized, isbn10: normalized, isbn13: isbn10To13(normalized) };
  if (isValidIsbn13(normalized))
    return { normalized, isbn10: isbn13To10(normalized), isbn13: normalized };
  throw new Error(`Invalid ISBN checksum: ${value}`);
}

export function extractIsbns(text: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:97[89][ -]?(?:\d[ -]?){9}\d|(?:\d[ -]?){9}[\dX])/gi;
  for (const token of text.match(pattern) ?? []) {
    try {
      found.add(parseIsbn(token).isbn13);
    } catch {
      /* not an ISBN */
    }
  }
  return [...found];
}

function ocrCompact(value: string) {
  return value
    .toUpperCase()
    .replace(/ISBN(?:-1[03])?/g, ' ')
    .replace(/[OQD]/g, '0')
    .replace(/[IL|]/g, '1')
    .replace(/Z/g, '2')
    .replace(/S/g, '5')
    .replace(/G/g, '6')
    .replace(/B/g, '8')
    .replace(/[^0-9X]/g, '');
}

function isbn13WithCorrectCheckDigit(value: string) {
  if (!/^97[89]\d{10}$/.test(value)) return null;
  const base = value.slice(0, 12);
  const sum = [...base].reduce(
    (total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function isbn10WithCorrectCheckDigit(value: string) {
  if (!/^\d{9}[\dX]$/.test(value)) return null;
  const base = value.slice(0, 9);
  const sum = [...base].reduce((total, char, index) => total + Number(char) * (10 - index), 0);
  const check = (11 - (sum % 11)) % 11;
  return `${base}${check === 10 ? 'X' : check}`;
}

/**
 * Produces conservative ISBN candidates from barcode/OCR text. Exact checksum-valid values win.
 * If none exist, only a corrected final check digit is suggested; callers must independently
 * confirm checksum-corrected candidates before accepting them.
 */
export function detectedIsbnCandidates(value: string): DetectedIsbnCandidate[] {
  const withoutLabel = value.toUpperCase().replace(/ISBN(?:-1[03])?/g, ' ');
  const literal = normalizeIsbn(withoutLabel);
  const cleaned = ocrCompact(value);
  const found = new Map<string, DetectedIsbnCandidate>();

  const addValidWindows = (compact: string, cleanedInput: boolean, length: 10 | 13) => {
    for (let offset = 0; offset <= compact.length - length; offset += 1) {
      const source = compact.slice(offset, offset + length);
      try {
        const parsed = parseIsbn(source);
        const kind = cleanedInput || compact.length !== length ? 'ocr-cleaned' : 'exact';
        const current = found.get(parsed.isbn13);
        if (!current || (current.kind === 'ocr-cleaned' && kind === 'exact'))
          found.set(parsed.isbn13, { ...parsed, kind, source });
      } catch {
        // Keep looking for a complete, checksum-valid ISBN within noisy OCR output.
      }
    }
  };

  addValidWindows(literal, false, 13);
  if (cleaned !== literal) addValidWindows(cleaned, true, 13);
  if (found.size) return [...found.values()];

  const hasIsbn13Shape = [literal, cleaned].some((compact) =>
    Array.from({ length: Math.max(0, compact.length - 12) }, (_, offset) =>
      compact.slice(offset, offset + 13),
    ).some((source) => /^97[89]\d{10}$/.test(source)),
  );
  if (!hasIsbn13Shape) {
    addValidWindows(literal, false, 10);
    if (cleaned !== literal) addValidWindows(cleaned, true, 10);
    if (found.size) return [...found.values()];
  }

  const corrections = new Map<string, DetectedIsbnCandidate>();
  for (const compact of new Set([literal, cleaned])) {
    for (const length of (hasIsbn13Shape ? [13] : [13, 10]) as (10 | 13)[]) {
      for (let offset = 0; offset <= compact.length - length; offset += 1) {
        const source = compact.slice(offset, offset + length);
        const corrected =
          length === 13 ? isbn13WithCorrectCheckDigit(source) : isbn10WithCorrectCheckDigit(source);
        if (!corrected || corrected === source) continue;
        try {
          const parsed = parseIsbn(corrected);
          corrections.set(parsed.isbn13, {
            ...parsed,
            kind: 'checksum-corrected',
            source,
          });
        } catch {
          // A non-ISBN EAN or malformed OCR fragment is not a correction candidate.
        }
      }
    }
  }
  return [...corrections.values()];
}
