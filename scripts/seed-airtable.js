// ═══════════════════════════════════════════════════════════════════════════
// scripts/seed-airtable.js — one-time seed of the Airtable base from data.json.
//
// Pushes each phase's baseline milestones (and phase config) into Airtable so
// the shared database matches what the dashboard shows before any PM edits.
// Safe to re-run: it upserts on (phaseId, milestoneId) / (phaseId).
//
// Usage:
//   AIRTABLE_TOKEN=pat… AIRTABLE_BASE_ID=app… node scripts/seed-airtable.js
//   add --dry-run to print what would be sent without writing.
//
// Requires Node 18+ (global fetch).
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const BASE = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;
const DRY = process.argv.includes('--dry-run');

if (!DRY && (!BASE || !TOKEN)) {
  console.error('Set AIRTABLE_TOKEN and AIRTABLE_BASE_ID env vars first (or pass --dry-run to preview).');
  process.exit(1);
}

const T = { milestones: 'Milestones', config: 'PhaseConfig' };
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const url = table => `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`;

async function upsert(table, fieldsToMergeOn, records) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    if (DRY) { console.log(`[dry-run] upsert ${table} (${batch.length})`, JSON.stringify(batch)); continue; }
    const r = await fetch(url(table), {
      method: 'PATCH', headers,
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn }, records: batch }),
    });
    if (!r.ok) throw new Error(`${table} upsert failed: ${r.status} ${await r.text()}`);
  }
}

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  let mCount = 0, cCount = 0;

  for (const phase of data.phases) {
    const milestones = (phase.milestones || []).map(m => ({ fields: {
      phaseId: phase.id,
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
      lastUpdated: m.lastUpdated || '',
    } }));
    if (milestones.length) { await upsert(T.milestones, ['phaseId', 'milestoneId'], milestones); mCount += milestones.length; }

    await upsert(T.config, ['phaseId'], [{ fields: {
      phaseId: phase.id,
      budgetHours: Number(phase.budgetHours) || 0,
      startDate: phase.startDate || '',
      expectedEndDate: phase.expectedEndDate || '',
      totalWeeks: Number(phase.totalWeeks) || 0,
    } }]);
    cCount++;
  }

  console.log(`${DRY ? '[dry-run] ' : ''}Seeded ${mCount} milestones and ${cCount} phase configs.`);
})().catch(e => { console.error(e.message); process.exit(1); });
