import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { straightenCover, validateCoverCorners } from './images.js';

describe('cover straightening', () => {
  it('validates clockwise, distinct cover corners', () => {
    expect(() =>
      validateCoverCorners({
        corners: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateCoverCorners({
        corners: [
          { x: 0.1, y: 0.1 },
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.9 },
          { x: 0.9, y: 0.1 },
        ],
      }),
    ).toThrow();
  });

  it('writes a corrected JPEG for a selected quadrilateral', async () => {
    const source = await sharp({
      create: { width: 400, height: 500, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const corrected = await straightenCover(source, {
      corners: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.15 },
        { x: 0.85, y: 0.9 },
        { x: 0.15, y: 0.85 },
      ],
    });
    const metadata = await sharp(corrected).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeGreaterThan(200);
    expect(metadata.height).toBeGreaterThan(300);
  });

  it('accepts validated corners as an array', async () => {
    const source = await sharp({
      create: { width: 100, height: 150, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    await expect(
      straightenCover(source, [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ]),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
