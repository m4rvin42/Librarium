import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import OpenAI from 'openai';
import {
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { ImageAnalysis, parseIsbn } from '@librarium/shared';
import { config } from './config.js';

export async function normalizeImage(buffer: Buffer, target: string) {
  const source = sharp(buffer, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate();
  const meta = await source.metadata();
  if (!['jpeg', 'png', 'webp', 'heif', 'tiff'].includes(meta.format || ''))
    throw new Error('Unsupported image format');
  const normalized = await source
    .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, normalized);
  const result = await sharp(normalized).metadata();
  return { buffer: normalized, width: result.width, height: result.height, mime: 'image/jpeg' };
}

export async function detectBarcode(buffer: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(buffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const source = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
    const result = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source)));
    return parseIsbn(result.getText()).isbn13;
  } catch {
    return null;
  }
}

export async function analyzeImage(buffer: Buffer) {
  if (!config.visionEnabled || !config.openAiKey)
    throw new Error('OpenAI image analysis is disabled');
  const client = new OpenAI({ apiKey: config.openAiKey });
  const response = await client.responses.create({
    model: config.visionModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Identify only books supported by visible evidence. Never invent ISBNs. Use null when unreadable. Handle German and English text and multiple shelf books. Preserve uncertainty.',
          },
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${buffer.toString('base64')}`,
            detail: 'high',
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'visible_books',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['books'],
          properties: {
            books: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'author', 'isbn10', 'isbn13', 'confidence', 'visibleText'],
                properties: {
                  title: { type: ['string', 'null'] },
                  author: { type: ['string', 'null'] },
                  isbn10: { type: ['string', 'null'] },
                  isbn13: { type: ['string', 'null'] },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  visibleText: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  });
  return ImageAnalysis.parse(JSON.parse(response.output_text));
}
