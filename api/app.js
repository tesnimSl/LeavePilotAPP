import express from 'express';
import { calculateYear } from '../lib/leave.js';

const TYPES = new Set(['paid', 'sick']);
const STATUSES = new Set(['planned', 'validated', 'cancelled']);
const router = express.Router();

function validYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error('Année invalide.');
  return year;
}
function finiteNumber(value, label, { min = -100000, max = 100000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} invalide.`);
  return n;
}
function normalizeConfig(b) {
  const year = validYear(b.year);
  const startMonth = Number(b.start_month ?? 1);
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error('Mois de début invalide.');
  return {
    year,
    annual_paid: finiteNumber(b.annual_paid ?? 22, 'Crédit annuel CP', { min: 0, max: 366 }),
    monthly_paid: finiteNumber(b.monthly_paid ?? 1.8333, 'Crédit mensuel CP', { min: 0, max: 31 }),
    annual_sick: finiteNumber(b.annual_sick ?? 5, 'Crédit annuel maladie', { min: 0, max: 366 }),
    initial_paid: finiteNumber(b.initial_paid ?? 0, 'Solde initial CP'),
    initial_sick: finiteNumber(b.initial_sick ?? 5, 'Solde initial maladie'),
    sick_carry: b.sick_carry === true,
    planned_forecast: b.planned_forecast === true,
    day_mode: b.day_mode === 'calendaires' ? 'calendaires' : 'ouvrés',
    start_month: startMonth
  };
}
async function audit(client, action, entity, id, details) {
  await client.query(
    'INSERT INTO leave_audit_log (action, entity, entity_id, details) VALUES ($1,$2,$3,$4::jsonb)',
    [action, entity, id == null ? null : String(id), JSON.stringify(details ?? {})]
  );
}
async function ensureYear(pool, year) {
  const found = await pool.query('SELECT id FROM leave_years WHERE year=$1', [year]);
  if (found.rowCount) return;
  let carry = 0;
  const previous = await pool.query('SELECT * FROM leave_years WHERE year=$1', [year - 1]);
  if (previous.rowCount) {
    const [ops, adjustments] = await Promise.all([
      pool.query('SELECT * FROM leave_operations WHERE year=$1', [year - 1]),
      pool.query('SELECT * FROM leave_adjustments WHERE year=$1', [year - 1])
    ]);
    carry = calculateYear(previous.rows[0], ops.rows, adjustments.rows).closingPaid;
  }
  await pool.query(
    `INSERT INTO leave_years (year,annual_paid,monthly_paid,annual_sick,initial_paid,initial_sick,sick_carry,planned_forecast,day_mode,start_month)
     VALUES ($1,22,1.8333,5,$2,5,FALSE,FALSE,'ouvrés',1) ON CONFLICT (year) DO NOTHING`,
    [year, carry]
  );
}

router.get('/', async (req, res, next) => {
  try {
    const year = validYear(req.query.year || new Date().getFullYear());
    const pool = req.app.locals.pool;
    await ensureYear(pool, year);
    const [ys, os, ads, logs] = await Promise.all([
      pool.query('SELECT * FROM leave_years ORDER BY year DESC'),
      pool.query('SELECT * FROM leave_operations ORDER BY start_date DESC,id DESC'),
      pool.query('SELECT * FROM leave_adjustments ORDER BY adjustment_date DESC,id DESC'),
      pool.query('SELECT * FROM leave_audit_log ORDER BY created_at DESC LIMIT 200')
    ]);
    const config = ys.rows.find(y => Number(y.year) === year);
    const operations = os.rows.filter(o => Number(o.year) === year);
    const adjustments = ads.rows.filter(a => Number(a.year) === year);
    res.json({ years: ys.rows, operations: os.rows, adjustments: ads.rows, audit: logs.rows,
      selectedYear: year, config, calculation: calculateYear(config, operations, adjustments) });
  } catch (error) { next(error); }
});

router.post('/', async (req, res) => {
  const pool = req.app.locals.pool;
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (b.action === 'save_year') {
      const c = normalizeConfig(b.config || {});
      const result = await client.query(
        `INSERT INTO leave_years (year,annual_paid,monthly_paid,annual_sick,initial_paid,initial_sick,sick_carry,planned_forecast,day_mode,start_month,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT (year) DO UPDATE SET annual_paid=EXCLUDED.annual_paid,monthly_paid=EXCLUDED.monthly_paid,
         annual_sick=EXCLUDED.annual_sick,initial_paid=EXCLUDED.initial_paid,initial_sick=EXCLUDED.initial_sick,
         sick_carry=EXCLUDED.sick_carry,planned_forecast=EXCLUDED.planned_forecast,day_mode=EXCLUDED.day_mode,
         start_month=EXCLUDED.start_month,updated_at=now() RETURNING *`,
        [c.year,c.annual_paid,c.monthly_paid,c.annual_sick,c.initial_paid,c.initial_sick,c.sick_carry,c.planned_forecast,c.day_mode,c.start_month]
      );
      await audit(client, 'Modification', 'Paramètres annuels', c.year, c);
      await client.query('COMMIT');
      return res.json({ ok: true, config: result.rows[0] });
    }

    if (['create_operation', 'update_operation'].includes(b.action)) {
      const o = b.operation || {};
      const start = String(o.start_date || '');
      const end = String(o.end_date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) throw new Error('Vérifiez les dates.');
      const year = validYear(start.slice(0, 4));
      if (!TYPES.has(o.leave_type) || !STATUSES.has(o.status || 'validated')) throw new Error('Type ou statut invalide.');
      const days = finiteNumber(o.days, 'Nombre de jours', { min: 0.01, max: 366 });
      const values = [year,start,end,o.leave_type,days,String(o.comment || '').slice(0,1000),o.status || 'validated'];
      let result;
      if (b.action === 'create_operation') {
        result = await client.query('INSERT INTO leave_operations (year,start_date,end_date,leave_type,days,comment,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', values);
        await audit(client, 'Création', 'Opération', result.rows[0].id, result.rows[0]);
      } else {
        const id = finiteNumber(o.id, 'Identifiant', { min: 1, max: Number.MAX_SAFE_INTEGER });
        result = await client.query('UPDATE leave_operations SET year=$1,start_date=$2,end_date=$3,leave_type=$4,days=$5,comment=$6,status=$7,updated_at=now() WHERE id=$8 RETURNING *', [...values, id]);
        if (!result.rowCount) throw new Error('Opération introuvable.');
        await audit(client, 'Modification', 'Opération', id, result.rows[0]);
      }
      await client.query('COMMIT');
      return res.json({ ok: true, operation: result.rows[0] });
    }

    if (b.action === 'delete_operation') {
      const id = finiteNumber(b.id, 'Identifiant', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const prior = await client.query('SELECT * FROM leave_operations WHERE id=$1', [id]);
      if (!prior.rowCount) throw new Error('Opération introuvable.');
      await client.query('DELETE FROM leave_operations WHERE id=$1', [id]);
      await audit(client, 'Suppression', 'Opération', id, prior.rows[0]);
      await client.query('COMMIT');
      return res.json({ ok: true });
    }

    if (b.action === 'create_adjustment') {
      const a = b.adjustment || {};
      if (!TYPES.has(a.leave_type) || !String(a.reason || '').trim()) throw new Error('Type et motif obligatoires.');
      const year = validYear(a.year);
      const month = a.month === '' || a.month == null ? null : Number(a.month);
      if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) throw new Error('Mois invalide.');
      const oldValue = finiteNumber(a.old_value ?? 0, 'Ancienne valeur');
      const newValue = finiteNumber(a.new_value ?? 0, 'Nouvelle valeur');
      const date = a.adjustment_date || new Date().toISOString().slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date de correction invalide.');
      const result = await client.query(
        'INSERT INTO leave_adjustments (year,leave_type,month,old_value,new_value,adjustment_date,reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [year,a.leave_type,month,oldValue,newValue,date,String(a.reason).trim().slice(0,500)]
      );
      await audit(client, 'Correction', 'Solde', result.rows[0].id, result.rows[0]);
      await client.query('COMMIT');
      return res.json({ ok: true, adjustment: result.rows[0] });
    }

    if (b.action === 'delete_adjustment') {
      const id = finiteNumber(b.id, 'Identifiant', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const prior = await client.query('SELECT * FROM leave_adjustments WHERE id=$1', [id]);
      if (!prior.rowCount) throw new Error('Correction introuvable.');
      await client.query('DELETE FROM leave_adjustments WHERE id=$1', [id]);
      await audit(client, 'Suppression', 'Correction', id, prior.rows[0]);
      await client.query('COMMIT');
      return res.json({ ok: true });
    }

    throw new Error('Action non prise en charge.');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    const message = error.message || 'Erreur serveur.';
    const status = /introuvable/.test(message) ? 404 : 400;
    return res.status(status).json({ error: message });
  } finally {
    client.release();
  }
});

export function createApiRouter({ pool }) {
  const api = express.Router();
  api.use((req, _res, next) => { req.app.locals.pool = pool; next(); });
  api.use(express.json({ limit: '100kb' }));
  api.use(router);
  return api;
}
