import path from 'node:path';
export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIRECTORY || path.resolve('data'),
  dbPath: process.env.DATABASE_PATH || path.resolve('data/librarium.sqlite'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  apiToken: process.env.API_TOKEN || '',
  openAiKey: process.env.OPENAI_API_KEY || '',
  visionModel: process.env.OPENAI_VISION_MODEL || 'gpt-5-mini',
  visionEnabled: process.env.OPENAI_IMAGE_ANALYSIS_ENABLED !== 'false',
  contact: process.env.OPENLIBRARY_CONTACT_EMAIL || '',
  maxImageMb: Number(process.env.MAX_IMAGE_SIZE_MB || 15),
  nodeEnv: process.env.NODE_ENV || 'development',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};
