export const normalizeIsbn = (value: string): string => value.toUpperCase().replace(/[^0-9X]/g, '');

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
  if (!/^\d{13}$/.test(isbn)) return false;
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
