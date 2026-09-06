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
import { CoverCornersInput, ImageAnalysis, parseIsbn } from '@librarium/shared';
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

type Corner = { x: number; y: number };

export class CoverStraighteningUnavailableError extends Error {
  statusCode = 503;
  code = 'COVER_STRAIGHTENING_UNAVAILABLE';

  constructor() {
    super(
      'Automatic cover straightening is unavailable. Check the OpenAI vision settings and try again.',
    );
  }
}

function polygonArea(corners: Corner[]) {
  return corners.reduce((area, corner, index) => {
    const next = corners[(index + 1) % corners.length]!;
    return area + corner.x * next.y - next.x * corner.y;
  }, 0);
}

export function validateCoverCorners(input: unknown): Corner[] {
  const corners = CoverCornersInput.parse(input).corners;
  const area = polygonArea(corners);
  if (area <= 0.03) throw new Error('Cover corners must form a clockwise quadrilateral');
  for (let index = 0; index < corners.length; index += 1) {
    const first = corners[index]!;
    const second = corners[(index + 1) % corners.length]!;
    if (Math.hypot(first.x - second.x, first.y - second.y) < 0.04)
      throw new Error('Cover corners must be distinct');
  }
  return corners;
}

export async function analyzeCoverCorners(buffer: Buffer) {
  if (!config.visionEnabled || !config.openAiKey) throw new CoverStraighteningUnavailableError();
  try {
    const client = new OpenAI({ apiKey: config.openAiKey });
    const response = await client.responses.create({
      model: config.visionModel,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Find the four outer corners of the visible front cover. Return normalized image coordinates from 0 to 1 in clockwise order: top-left, top-right, bottom-right, bottom-left. Do not return a result if a front cover is not clearly visible.',
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
          name: 'cover_corners',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['corners'],
            properties: {
              corners: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['x', 'y'],
                  properties: { x: { type: 'number' }, y: { type: 'number' } },
                },
              },
            },
          },
        },
      },
    });
    return validateCoverCorners(JSON.parse(response.output_text));
  } catch (cause) {
    if (cause instanceof Error && /Cover corners/.test(cause.message)) throw cause;
    throw new CoverStraighteningUnavailableError();
  }
}

function solveLinearSystem(matrix: number[][]) {
  const size = matrix.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1)
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    if (Math.abs(matrix[pivot]![column]!) < 1e-10)
      throw new Error('Cover corners cannot be transformed');
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    const divisor = matrix[column]![column]!;
    for (let value = column; value <= size; value += 1)
      matrix[column]![value] = matrix[column]![value]! / divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = matrix[row]![column]!;
      for (let value = column; value <= size; value += 1)
        matrix[row]![value] = matrix[row]![value]! - factor * matrix[column]![value]!;
    }
  }
  return matrix.map((row) => row[size]!);
}

function homography(corners: Corner[]) {
  const targets: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const matrix: number[][] = [];
  targets.forEach(([x, y], index) => {
    const { x: u, y: v } = corners[index]!;
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  });
  return solveLinearSystem(matrix);
}

function distance(first: Corner, second: Corner) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export async function straightenCover(buffer: Buffer, input: unknown) {
  const corners = validateCoverCorners(Array.isArray(input) ? { corners: input } : input);
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sourceWidth = info.width;
  const sourceHeight = info.height;
  const outputWidth = Math.max(
    64,
    Math.min(
      3000,
      Math.round(
        ((distance(corners[0]!, corners[1]!) + distance(corners[3]!, corners[2]!)) / 2) *
          sourceWidth,
      ),
    ),
  );
  const outputHeight = Math.max(
    64,
    Math.min(
      3000,
      Math.round(
        ((distance(corners[0]!, corners[3]!) + distance(corners[1]!, corners[2]!)) / 2) *
          sourceHeight,
      ),
    ),
  );
  const transform = homography(corners);
  const a = transform[0]!;
  const b = transform[1]!;
  const c = transform[2]!;
  const d = transform[3]!;
  const e = transform[4]!;
  const f = transform[5]!;
  const g = transform[6]!;
  const h = transform[7]!;
  const output = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const targetX = (x + 0.5) / outputWidth;
      const targetY = (y + 0.5) / outputHeight;
      const divisor = g * targetX + h * targetY + 1;
      const sourceX = ((a * targetX + b * targetY + c) / divisor) * (sourceWidth - 1);
      const sourceY = ((d * targetX + e * targetY + f) / divisor) * (sourceHeight - 1);
      const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sourceX)));
      const top = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sourceY)));
      const right = Math.min(sourceWidth - 1, left + 1);
      const bottom = Math.min(sourceHeight - 1, top + 1);
      const horizontal = sourceX - left;
      const vertical = sourceY - top;
      const outputOffset = (y * outputWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const topValue =
          data[(top * sourceWidth + left) * 4 + channel]! * (1 - horizontal) +
          data[(top * sourceWidth + right) * 4 + channel]! * horizontal;
        const bottomValue =
          data[(bottom * sourceWidth + left) * 4 + channel]! * (1 - horizontal) +
          data[(bottom * sourceWidth + right) * 4 + channel]! * horizontal;
        output[outputOffset + channel] = Math.round(
          topValue * (1 - vertical) + bottomValue * vertical,
        );
      }
    }
  }
  return sharp(output, { raw: { width: outputWidth, height: outputHeight, channels: 4 } })
    .jpeg({ quality: 88 })
    .toBuffer();
}
