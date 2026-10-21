import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { runMigrations } from './scripts/migrate.js';
import { createApiRouter } from './api/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.DATABASE_URL) {
  console.error('ERREUR : la variable DATABASE_URL est obligatoire.');
  process.exit(1);
}
if (!process.env.APP_USER || !process.env.APP_PASSWORD) {
  console.error('ERREUR : définissez APP_USER et APP_PASSWORD pour protéger les données personnelles.');
  process.exit(1);
}
if (process.env.APP_PASSWORD.length < 14) {
  console.error('ERREUR : APP_PASSWORD doit contenir au moins 14 caractères.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres accepte TLS. En local, laissez DATABASE_SSL=false.
  ssl: process.env.DATABASE_SSL === 'true' || (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'false')
    ? { rejectUnauthorized: false }
    : false,
  max: Number(process.env.PGPOOL_MAX || 5),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && aa.length > 0 && (awaitlessTimingSafeEqual(aa, bb));
}
function awaitlessTimingSafeEqual(a, b) {
  // crypto.timingSafeEqual évite une comparaison naïve des secrets.
  return timingSafeEqual(a, b);
}

function requireBasicAuth(req, res, next) {
  if (req.path === '/health') return next();
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Suivi des congés", charset="UTF-8"');
    return res.status(401).send('Authentification requise.');
  }
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch {}
  const separator = decoded.indexOf(':');
  const user = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';
  if (!safeEqual(user, process.env.APP_USER) || !safeEqual(password, process.env.APP_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="Suivi des congés", charset="UTF-8"');
    return res.status(401).send('Identifiants incorrects.');
  }
  return next();
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(requireBasicAuth);
app.use(express.json({ limit: '100kb' }));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});
app.use('/api/app', createApiRouter({ pool }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('Erreur HTTP :', err);
  res.status(500).json({ error: 'Une erreur serveur est survenue.' });
});

try {
  await runMigrations(pool);
  app.listen(port, '0.0.0.0', () => console.log(`Suivi des congés démarré sur le port ${port}`));
} catch (error) {
  console.error('Impossible de démarrer l’application :', error);
  await pool.end();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await pool.end();
    process.exit(0);
  });
}
