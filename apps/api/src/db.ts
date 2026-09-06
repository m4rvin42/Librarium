import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from './config.js';
import * as schema from './schema.js';
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'images'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'imports'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
export const orm = drizzle(db, { schema });
const migrationPath = new URL('./schema.sql', import.meta.url);
const fallback = path.resolve('apps/api/src/schema.sql');
db.exec(fs.readFileSync(fs.existsSync(migrationPath) ? migrationPath : fallback, 'utf8'));

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = [
  path.resolve(moduleDirectory, 'migrations'),
  path.resolve(moduleDirectory, '../migrations'),
  path.resolve('apps/api/migrations'),
].find((directory) => fs.existsSync(directory));
if (!migrationDirectory) throw new Error('Database migrations directory is missing');
for (const file of fs.readdirSync(migrationDirectory).sort()) {
  const match = /^(\d+)_.*\.sql$/.exec(file);
  if (!match) continue;
  const version = Number(match[1]);
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version);
  if (applied) continue;
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(migrationDirectory, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(
      version,
      new Date().toISOString(),
    );
  })();
}
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
