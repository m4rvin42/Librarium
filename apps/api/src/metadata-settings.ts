import crypto from 'node:crypto';
import { MetadataSettingsInput, metadataProviders } from '@librarium/shared';
import { config } from './config.js';
import { db, now } from './db.js';

type MetadataProvider = (typeof metadataProviders)[number];
const PROVIDERS_KEY = 'metadata_providers';
const GOOGLE_BOOKS_KEY = 'google_books_api_key';

export class SettingsEncryptionUnavailableError extends Error {
  statusCode = 503;
  code = 'SETTINGS_ENCRYPTION_UNAVAILABLE';

  constructor() {
    super('Set SETTINGS_ENCRYPTION_KEY before saving provider credentials in Settings');
  }
}

function encryptionKey() {
  if (!config.settingsEncryptionKey) throw new SettingsEncryptionUnavailableError();
  const key = Buffer.from(config.settingsEncryptionKey, 'base64');
  if (key.length !== 32) throw new SettingsEncryptionUnavailableError();
  return key;
}

function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decrypt(value: string) {
  const payload = Buffer.from(value, 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function setting(key: string) {
  return (db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined)
    ?.value;
}

function storedProviders(): MetadataProvider[] | null {
  const value = setting(PROVIDERS_KEY);
  if (!value) return null;
  try {
    const providers = JSON.parse(value);
    if (
      Array.isArray(providers) &&
      providers.length &&
      providers.every((provider) => (metadataProviders as readonly string[]).includes(provider))
    )
      return providers as MetadataProvider[];
  } catch {
    return null;
  }
  return null;
}

function storedGoogleBooksKey() {
  const value = setting(GOOGLE_BOOKS_KEY);
  return value ? decrypt(value) : null;
}

export function metadataConfiguration() {
  const providers = storedProviders() ?? config.metadataProviders;
  const storedKey = storedGoogleBooksKey();
  return {
    providers,
    googleBooksApiKey: storedKey ?? config.googleBooksApiKey,
    googleBooksKeyConfigured: Boolean(storedKey ?? config.googleBooksApiKey),
    openAiWebSearchConfigured: Boolean(config.openAiKey),
    openAiMetadataModel: config.metadataModel,
    editable: Boolean(config.settingsEncryptionKey),
  };
}

export function metadataSettingsStatus() {
  const configuration = metadataConfiguration();
  return {
    providers: configuration.providers,
    googleBooksKeyConfigured: configuration.googleBooksKeyConfigured,
    openAiWebSearchConfigured: configuration.openAiWebSearchConfigured,
    openAiMetadataModel: configuration.openAiMetadataModel,
    editable: configuration.editable,
    usingSavedProviders: Boolean(storedProviders()),
    usingSavedGoogleBooksKey: Boolean(setting(GOOGLE_BOOKS_KEY)),
  };
}

export function saveMetadataSettings(input: unknown) {
  const settings = MetadataSettingsInput.parse(input);
  if (settings.googleBooksApiKey) encryptionKey();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    ).run(PROVIDERS_KEY, JSON.stringify(settings.providers), now());
    if (settings.googleBooksApiKey)
      db.prepare(
        'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      ).run(GOOGLE_BOOKS_KEY, encrypt(settings.googleBooksApiKey), now());
    if (settings.clearGoogleBooksApiKey)
      db.prepare('DELETE FROM app_settings WHERE key=?').run(GOOGLE_BOOKS_KEY);
  })();
  return metadataSettingsStatus();
}
