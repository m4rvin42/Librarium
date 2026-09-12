import { describe, expect, it, vi } from 'vitest';
const createResponse = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    responses = { create: createResponse };
  },
}));
import sharp from 'sharp';
import { analyzeBookPhotos, straightenCover, validateCoverCorners } from './images.js';
import { config } from './config.js';

describe('combined photo analysis', () => {
  it('sends every photo with its role and requests a description and cover corners', async () => {
    const enabled = config.visionEnabled;
    config.visionEnabled = true;
    try {
      createResponse.mockResolvedValue({
        output_text: JSON.stringify({
          title: 'Book',
          authors: [],
          isbn: null,
          subtitle: null,
          publisher: null,
          publicationDate: null,
          language: null,
          pageCount: null,
          description: 'Back text',
          visibleText: [],
          confidence: 0.8,
          frontCoverCorners: null,
        }),
      });
      const result = await analyzeBookPhotos([
        { role: 'front', buffer: Buffer.from('front') },
        { role: 'back', buffer: Buffer.from('back') },
      ]);
      expect(result.description).toBe('Back text');
      const request = createResponse.mock.calls[0]![0];
      expect(
        request.input[0].content.filter((item: any) => item.type === 'input_image'),
      ).toHaveLength(2);
      expect(request.input[0].content.some((item: any) => item.text === 'Photo role: back')).toBe(
        true,
      );
      expect(request.text.format.schema.required).toContain('description');
      createResponse.mockRejectedValue(new Error('private upstream request'));
      await expect(
        analyzeBookPhotos([{ role: 'front', buffer: Buffer.from('front') }]),
      ).rejects.toThrow('Book photo analysis failed.');
    } finally {
      config.visionEnabled = enabled;
      createResponse.mockReset();
    }
  });
});

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
