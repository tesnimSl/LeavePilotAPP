import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function runMigrations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Empêche deux instances de lancer les migrations simultanément.
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [721042026]);
    const dir = path.join(rootDir, 'migrations');
    const files = (await fs.readdir(dir)).filter(f => /^\d+.*\.sql$/i.test(f)).sort();
    for (const filename of files) {
      const existing = await lock.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
      if (existing.rowCount) continue;
      const sql = await fs.readFile(path.join(dir, filename), 'utf8');
      await lock.query('BEGIN');
      try {
        await lock.query(sql);
        await lock.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
        await lock.query('COMMIT');
        console.log(`Migration appliquée : ${filename}`);
      } catch (error) {
        await lock.query('ROLLBACK');
        throw new Error(`Échec de la migration ${filename}: ${error.message}`);
      }
    }
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock($1)', [721042026]); } catch {}
    lock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error('Définissez DATABASE_URL avant de lancer les migrations.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' || (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'false')
      ? { rejectUnauthorized: false }
      : false
  });
  try { await runMigrations(pool); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { await pool.end(); }
}
