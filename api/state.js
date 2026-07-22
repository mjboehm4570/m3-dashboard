// ═══════════════════════════════════════════════════════════════════════════
// api/state.js — Vercel serverless proxy for PM overrides, backed by Airtable.
//
//   GET  /api/state           → returns the overrides document in the exact
//                               shape index.html expects (keyed by phaseId).
//   POST /api/state {op, ...}  → applies a single mutation. Requires the
//                               x-edit-secret header to match EDIT_SECRET
//                               (when EDIT_SECRET is configured).
//
// Env vars (set in Vercel → Project Settings → Environment Variables):
//   AIRTABLE_TOKEN   — personal access token, scoped to the M3 base (data.records:read/write)
//   AIRTABLE_BASE_ID — the base id (starts with "app…")
//   EDIT_SECRET      — optional shared passphrase gating writes (recommended)
//
// If AIRTABLE_TOKEN / AIRTABLE_BASE_ID are missing this returns 503, and the
// client falls back to localStorage — so the dashboard keeps working until the
// base is wired up.
//
// Airtable tables (normalized so the nightly Action can read them later):
//   Milestones  { phaseId, milestoneId, name, type, targetDate, startDate,
//                 status, completionPct, notes, assigneeIds, lastUpdated }
//   StaffMeta   { phaseId, staffId, name, role, hoursAllocated }
//   PhaseConfig { phaseId, budgetHours, startDate, expectedEndDate, totalWeeks }
//   Changelog   { ts, phaseId, phaseName, note, changes }
// ═══════════════════════════════════════════════════════════════════════════

const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const EDIT_SECRET = process.env.EDIT_SECRET || '';

const T = {
  milestones: 'Milestones', staff: 'StaffMeta', config: 'PhaseConfig', changelog: 'Changelog',
  // DB DOS scope layer (added in the scope-certainty build). Absent-safe: reads are wrapped
  // so a base without these tables still serves the core tracker overrides.
  features: 'Features', contractScope: 'ContractScope', phaseGates: 'PhaseGates',
  changeOrders: 'ChangeOrders', audit: 'Audit',
};

// ── Airtable REST helpers ──────────────────────────────────────────────────
function airUrl(table, qs) {
  return `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}${qs ? '?' + qs : ''}`;
}
function airHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function airList(table) {
  const out = [];
  let offset;
  do {
    const qs = 'pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
    const r = await fetch(airUrl(table, qs), { headers: airHeaders() });
    if (!r.ok) throw new Error(`Airtable list ${table} failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

// Upsert by merge key. Airtable caps records at 10/request, so chunk.
async function airUpsert(table, fieldsToMergeOn, records) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const r = await fetch(airUrl(table), {
      method: 'PATCH',
      headers: airHeaders(),
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn }, records: batch }),
    });
    if (!r.ok) throw new Error(`Airtable upsert ${table} failed: ${r.status} ${await r.text()}`);
  }
}

// Tolerant upsert: on "Unknown field name" (a column not yet added to the base), strip
// the named field and retry. Generalizes the Phase-6 subphaseId tolerance so DB DOS
// columns can be added to Airtable incrementally without breaking writes.
async function airUpsertSafe(table, fieldsToMergeOn, records) {
  let attempt = records;
  for (let tries = 0; tries < 12; tries++) {
    try { await airUpsert(table, fieldsToMergeOn, attempt); return; }
    catch (e) {
      const m = e.message.match(/Unknown field name:?\s*\\?"?([^"\\]+?)\\?"?[\s,}]/i) || e.message.match(/Unknown field name:?\s*"?([\w-]+)"?/i);
      if (m && !fieldsToMergeOn.includes(m[1])) {
        const bad = m[1];
        attempt = attempt.map(r => { const f = { ...r.fields }; delete f[bad]; return { ...r, fields: f }; });
        continue;
      }
      throw e;
    }
  }
}

// List a table, tolerating its absence (base not yet extended with DB DOS tables).
async function airListSafe(table) {
  try { return await airList(table); } catch (e) { return []; }
}

async function airCreate(table, fields) {
  const r = await fetch(airUrl(table), {
    method: 'POST',
    headers: airHeaders(),
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!r.ok) throw new Error(`Airtable create ${table} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function airDelete(table, recordIds) {
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const qs = batch.map(id => 'records[]=' + encodeURIComponent(id)).join('&');
    const r = await fetch(airUrl(table, qs), { method: 'DELETE', headers: airHeaders() });
    if (!r.ok) throw new Error(`Airtable delete ${table} failed: ${r.status} ${await r.text()}`);
  }
}

// ── small parsers ──────────────────────────────────────────────────────────
function num(v) { return typeof v === 'number' ? v : (parseInt(v, 10) || 0); }
function parseJSON(v, fallback) { try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function parseList(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  const j = parseJSON(v, null);
  if (Array.isArray(j)) return j;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// ── GET: assemble the overrides document index.html expects ──────────────────
async function buildOverrides() {
  const [ms, staff, cfg, cl] = await Promise.all([
    airList(T.milestones), airList(T.staff), airList(T.config), airList(T.changelog),
  ]);
  const o = {};

  // Guard against duplicate Airtable rows sharing a (phaseId, milestoneId) key
  // (e.g. a manual edit, a whitespace/casing mismatch that defeated the
  // upsert's fieldsToMergeOn, or a masked upsert failure) — keep only the
  // most-recently-updated row per key rather than surfacing every duplicate.
  const milestoneByKey = new Map();
  ms.forEach(rec => {
    const f = rec.fields;
    if (!f.phaseId || !f.milestoneId) return;
    const dedupeKey = f.phaseId + '::' + f.milestoneId;
    const existingRec = milestoneByKey.get(dedupeKey);
    if (existingRec && (existingRec.fields.lastUpdated || '') > (f.lastUpdated || '')) return;
    milestoneByKey.set(dedupeKey, rec);
  });
  milestoneByKey.forEach(rec => {
    const f = rec.fields;
    const key = f.phaseId + '.milestones';
    (o[key] = o[key] || []).push({
      id: f.milestoneId,
      name: f.name || '',
      type: f.type || 'milestone',
      targetDate: f.targetDate || '',
      startDate: f.startDate || '',
      status: f.status || 'not_started',
      completionPct: typeof f.completionPct === 'number' ? f.completionPct : 0,
      notes: f.notes || '',
      assigneeIds: parseList(f.assigneeIds),
      subphaseId: f.subphaseId || 'shared',
      lastUpdated: f.lastUpdated || '',
      airtableRecordId: rec.id,
    });
  });

  staff.forEach(rec => {
    const f = rec.fields;
    if (!f.phaseId || !f.staffId) return;
    const key = f.phaseId + '.staff';
    (o[key] = o[key] || {})[f.staffId] = {
      name: f.name || '',
      role: f.role || '',
      hoursAllocated: typeof f.hoursAllocated === 'number' ? f.hoursAllocated : 0,
    };
  });

  cfg.forEach(rec => {
    const f = rec.fields;
    if (!f.phaseId) return;
    o[f.phaseId + '.config'] = {
      budgetHours: num(f.budgetHours),
      startDate: f.startDate || '',
      expectedEndDate: f.expectedEndDate || '',
      totalWeeks: num(f.totalWeeks),
    };
  });

  const changelog = cl
    .map(rec => {
      const f = rec.fields;
      return {
        ts: f.ts || '',
        phaseId: f.phaseId || '',
        phaseName: f.phaseName || '',
        note: f.note || '',
        changes: parseJSON(f.changes, []),
      };
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : -1)); // newest first (matches unshift order in the UI)
  if (changelog.length) o.changelog = changelog;

  // ── DB DOS scope layer (absent-safe: missing tables just yield empty lists) ──
  const [feat, gates, cos, aud] = await Promise.all([
    airListSafe(T.features), airListSafe(T.phaseGates), airListSafe(T.changeOrders), airListSafe(T.audit),
  ]);

  feat.forEach(rec => {
    const f = rec.fields;
    if (!f.featureId) return;
    o['feature.' + f.featureId] = {
      lifecycleState: f.lifecycleState || 'draft',
      scopeCategory: f.scopeCategory || 'original',
      estimate: parseJSON(f.estimate, undefined),
      signoff: parseJSON(f.signoff, null),
      actualHours: typeof f.actualHours === 'number' ? f.actualHours : undefined,
    };
    // Drop undefined keys so Object.assign in the client doesn't clobber seed values.
    Object.keys(o['feature.' + f.featureId]).forEach(k => o['feature.' + f.featureId][k] === undefined && delete o['feature.' + f.featureId][k]);
  });

  gates.forEach(rec => {
    const f = rec.fields;
    if (!f.phaseId) return;
    o[f.phaseId + '.gate'] = {
      passed: !!f.passed,
      agreedBy: parseList(f.agreedBy),
      agreedAt: f.agreedAt || null,
    };
  });

  const changeOrders = cos.map(rec => parseJSON(rec.fields.doc, null) || rec.fields).filter(Boolean);
  if (changeOrders.length) o.changeOrders = changeOrders.sort((a, b) => ((a.raisedAt || '') < (b.raisedAt || '') ? 1 : -1));

  const audit = aud.map(rec => ({
    ts: rec.fields.ts || '', actor: rec.fields.actor || '', entity: rec.fields.entity || '',
    entityId: rec.fields.entityId || '', action: rec.fields.action || '',
  })).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  if (audit.length) o.audit = audit;

  return o;
}

// ── POST: apply one mutation ─────────────────────────────────────────────────
function milestoneFields(phaseId, m) {
  return {
    phaseId,
    milestoneId: m.id,
    name: m.name || '',
    type: m.type || 'milestone',
    targetDate: m.targetDate || '',
    startDate: m.startDate || '',
    status: m.status || 'not_started',
    completionPct: Number(m.completionPct) || 0,
    notes: m.notes || '',
    assigneeIds: JSON.stringify(m.assigneeIds || []),
    subphaseId: m.subphaseId || 'shared',
    lastUpdated: m.lastUpdated || new Date().toISOString(),
  };
}

// Flatten a Feature to Airtable columns (nested objects → JSON long-text, per the schema).
function featureFields(f) {
  return {
    featureId: f.id, buildId: f.buildId || '', name: f.name || '', description: f.description || '',
    lifecycleState: f.lifecycleState || 'draft', scopeCategory: f.scopeCategory || 'original',
    risk: f.risk || '', riskMultiplier: Number(f.riskMultiplier) || 0,
    estimate: JSON.stringify(f.estimate || {}), actualHours: Number(f.actualHours) || 0,
    designAssets: JSON.stringify(f.designAssets || []), mapping: JSON.stringify(f.mapping || {}),
    confidence: JSON.stringify(f.confidence || {}), contractScopeRefs: JSON.stringify(f.contractScopeRefs || []),
    alignment: f.alignment || '', phase: f.phase || '', priority: f.priority || '',
    signoff: JSON.stringify(f.signoff || null), sourceRef: f.sourceRef || '',
    lastUpdated: new Date().toISOString(),
  };
}

async function applyOp(body) {
  const { op } = body;

  // ── DB DOS scope-layer ops (all tolerant of missing tables/columns) ──
  if (op === 'upsertFeature' || op === 'lockBaseline') {
    await airUpsertSafe(T.features, ['featureId'], [{ fields: featureFields(body.feature) }]);
    return;
  }
  if (op === 'upsertPhaseGate') {
    const g = body.gate || {};
    await airUpsertSafe(T.phaseGates, ['phaseId'], [{ fields: {
      phaseId: body.phaseId, passed: !!g.passed,
      agreedBy: JSON.stringify(g.agreedBy || []), agreedAt: g.agreedAt || '',
      entryCriteria: JSON.stringify(g.entryCriteria || []),
    } }]);
    return;
  }
  if (op === 'upsertContractScope') {
    const s = body.item || {};
    await airUpsertSafe(T.contractScope, ['scopeId'], [{ fields: {
      scopeId: s.id, buildId: s.buildId || '', name: s.name || '',
      description: s.description || '', status: s.status || '', source: JSON.stringify(s.source || {}),
    } }]);
    return;
  }
  if (op === 'appendChangeOrder') {
    // Store the whole change order as JSON in a `doc` column (upsert by id) so its shape
    // can evolve without schema churn; falls back to flat columns if `doc` is absent.
    const co = body.changeOrder || {};
    await airUpsertSafe(T.changeOrders, ['coId'], [{ fields: {
      coId: co.id, decision: co.decision || 'pending', raisedAt: co.raisedAt || '',
      sizeEstimateHours: Number(co.sizeEstimateHours) || 0, notes: co.notes || '',
      doc: JSON.stringify(co),
    } }]);
    return;
  }
  if (op === 'appendAudit') {
    const e = body.entry || {};
    // Best-effort: the audit trail must never fail the primary edit it accompanies.
    try {
      await airCreate(T.audit, {
        ts: e.ts || new Date().toISOString(), actor: e.actor || '', entity: e.entity || '',
        entityId: e.entityId || '', action: e.action || '',
      });
    } catch (err) { /* Audit table not yet created — ignore */ }
    return;
  }

  // Replace a phase's full milestone set: upsert every row, delete any that vanished.
  // (Mirrors the client's "write the whole array" semantics — avoids losing seed rows.)
  if (op === 'savePhaseMilestones') {
    const { phaseId } = body;
    const milestones = body.milestones || [];
    const records = milestones.map(m => ({ fields: milestoneFields(phaseId, m) }));
    try {
      await airUpsert(T.milestones, ['phaseId', 'milestoneId'], records);
    } catch (e) {
      // Tolerate an Airtable base that doesn't have the newer subphaseId column yet:
      // strip it and retry so milestone saves never hard-fail on a missing field.
      // Matched narrowly to "unknown field" only — a bare 422 could also mean
      // "multiple records match fieldsToMergeOn" (duplicate rows already in the
      // base), which this retry would not fix and should instead propagate.
      if (/Unknown field name|UNKNOWN_FIELD_NAME/.test(e.message) && records.some(r => 'subphaseId' in r.fields)) {
        records.forEach(r => { delete r.fields.subphaseId; });
        await airUpsert(T.milestones, ['phaseId', 'milestoneId'], records);
      } else {
        throw e;
      }
    }
    const existing = await airList(T.milestones);
    const keep = new Set(milestones.map(m => m.id));
    const stale = existing.filter(r => r.fields.phaseId === phaseId && !keep.has(r.fields.milestoneId)).map(r => r.id);
    await airDelete(T.milestones, stale);
    return;
  }

  if (op === 'upsertStaff') {
    const { phaseId, staffId, patch } = body;
    await airUpsert(T.staff, ['phaseId', 'staffId'], [{ fields: {
      phaseId, staffId,
      name: patch.name || '',
      role: patch.role || '',
      hoursAllocated: Number(patch.hoursAllocated) || 0,
    } }]);
    return;
  }

  if (op === 'upsertConfig') {
    const { phaseId, config } = body;
    await airUpsert(T.config, ['phaseId'], [{ fields: {
      phaseId,
      budgetHours: Number(config.budgetHours) || 0,
      startDate: config.startDate || '',
      expectedEndDate: config.expectedEndDate || '',
      totalWeeks: Number(config.totalWeeks) || 0,
    } }]);
    return;
  }

  if (op === 'appendChangelog') {
    const { entry } = body;
    await airCreate(T.changelog, {
      ts: entry.ts || new Date().toISOString(),
      phaseId: entry.phaseId || '',
      phaseName: entry.phaseName || '',
      note: entry.note || '',
      changes: JSON.stringify(entry.changes || []),
    });
    return;
  }

  throw new Error('Unknown op: ' + op);
}

// ── handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-edit-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!BASE || !TOKEN) return res.status(503).json({ error: 'Airtable not configured' });

  try {
    if (req.method === 'GET') {
      const o = await buildOverrides();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(o);
    }
    if (req.method === 'POST') {
      if (EDIT_SECRET && req.headers['x-edit-secret'] !== EDIT_SECRET) {
        return res.status(401).json({ error: 'Invalid edit secret' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      await applyOp(body);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
