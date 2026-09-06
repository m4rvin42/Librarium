import path from 'node:path';
import { metadataProviders } from '@librarium/shared';

type MetadataProvider = (typeof metadataProviders)[number];

function configuredProviders(value: string | undefined): MetadataProvider[] {
  const providers = (value || 'openlibrary')
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider): provider is MetadataProvider =>
      (metadataProviders as readonly string[]).includes(provider),
    );
  return [...new Set(providers)].length ? [...new Set(providers)] : ['openlibrary'];
}

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIRECTORY || path.resolve('data'),
  dbPath: process.env.DATABASE_PATH || path.resolve('data/librarium.sqlite'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  apiToken: process.env.API_TOKEN || '',
  openAiKey: process.env.OPENAI_API_KEY || '',
  visionModel: process.env.OPENAI_VISION_MODEL || 'gpt-5-mini',
  metadataModel: process.env.OPENAI_METADATA_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-5-mini',
  visionEnabled: process.env.OPENAI_IMAGE_ANALYSIS_ENABLED !== 'false',
  openLibraryContact: process.env.OPENLIBRARY_CONTACT_EMAIL || '',
  metadataProviders: configuredProviders(process.env.METADATA_PROVIDERS || process.env.METADATA_PROVIDER),
  googleBooksApiKey: process.env.GOOGLE_BOOKS_API_KEY || '',
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || '',
  maxImageMb: Number(process.env.MAX_IMAGE_SIZE_MB || 15),
  nodeEnv: process.env.NODE_ENV || 'development',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};
