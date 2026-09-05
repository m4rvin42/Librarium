# Backup and restore

JSON is portable; SQLite is a complete consistent snapshot. SQLite export uses the online backup API and is safe during WAL writes.

Start JSON restore with dryRun true. Resolve errors/conflicts, choose skip, merge, or replace, then submit with dryRun false. Writes are transactional.

SQLite restore is API-only. Send multipart data to /api/v1/import/sqlite with bearer auth and X-Librarium-Confirm: RESTORE. Librarium checks schema and integrity, creates /data/backups/pre-restore-*.sqlite, then imports core tables transactionally. Keep that backup until verified.

Before upgrades download both formats. A volume copy is safe after stopping the container; never copy only an active SQLite main file because WAL data may be missing.
