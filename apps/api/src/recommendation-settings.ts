import { RecommendationSettingsInput } from '@librarium/shared';
import { config } from './config.js';
import { db, now } from './db.js';

const ENABLED_KEY = 'openai_recommendation_reranking_enabled';

function storedEnabled() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(ENABLED_KEY) as
    { value: string } | undefined;
  return row ? row.value === 'true' : false;
}

export function recommendationConfiguration() {
  return {
    openAiRerankingEnabled: storedEnabled(),
    openAiConfigured: Boolean(config.openAiKey),
    model: config.recommendationModel,
    dataShared: [
      'title',
      'subtitle',
      'authors',
      'publisher',
      'publicationDate',
      'language',
      'pageCount',
      'description',
      'categories',
      'editionFormat',
      'rating',
    ],
    dataExcluded: ['notes', 'reading session notes', 'credentials', 'images', 'local paths'],
  };
}

export function saveRecommendationSettings(input: unknown) {
  const value = RecommendationSettingsInput.parse(input);
  db.prepare(
    'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
  ).run(ENABLED_KEY, String(value.openAiRerankingEnabled), now());
  return recommendationConfiguration();
}
