#!/usr/bin/env node
/**
 * seed-dbdos.js — produce the static `dbdos.json` the dashboard loads alongside
 * `data.json`, from the DB DOS BET seed (`scripts/m3-bet-seed.json`).
 *
 * Why a separate file: `data.json` is regenerated nightly by `data-refresh.js`
 * from ProjectX, so hand-authored scope data (features, contract scope, gates)
 * must NOT live there or it would be clobbered. `dbdos.json` is committed and
 * merged in memory at page load (see `applyDbDos` in index.html). PM edits still
 * persist through the Airtable/localStorage override layer (`api/state.js`).
 *
 * The seed's phase ids (`p0-presales`, `p1-discovery`, …) are remapped onto the
 * tracker's phase ids (`phase1`..`phase5`, plus a new `phase0`) so gates and
 * product tags attach to the real phases without touching `data.json`.
 *
 * Usage: node scripts/seed-dbdos.js [path-to-seed]   (default scripts/m3-bet-seed.json)
 *        writes ./dbdos.json (repo root)
 */
const fs = require('fs');
const path = require('path');

// Seed phase id → tracker phase id (data.json). p0 is new; the rest already exist.
const PHASE_ID_MAP = {
  'p0-presales': 'phase0',
  'p1-discovery': 'phase1',
  'p2-alf': 'phase2',
  'p3-vetleo': 'phase3',
  'p4-raivan': 'phase4',
  'p5-ongoing': 'phase5',
};

// Which tracker phase delivers which product (build phases). Discovery/retainer have none.
const PHASE_PRODUCTS = { phase2: 'alf', phase3: 'vetleo', phase4: 'raivan' };

// Hand-authored milestone → feature links. Discovery (phase1) milestones SHAPE many
// features (n:n); build-phase milestones would carry a single featureId (1:1) but the
// tracker has none seeded yet. Keyed by the tracker milestone id.
const MILESTONE_LINKS = {
  'm1a-1': { shapesFeatureIds: ['vetleo-getting-started', 'vetleo-pet-history', 'vetleo-leo-power'] },
  'm1a-2': { shapesFeatureIds: ['vetleo-getting-started', 'vetleo-pet-history'] },
  'm1a-3': { shapesFeatureIds: ['vetleo-everyday-care'] },
  'm1a-4': { shapesFeatureIds: ['vetleo-triage'] },
  'm1a-5': { shapesFeatureIds: ['vetleo-vet-visit-capture', 'vetleo-post-visit'] },
  'm1a-6': { shapesFeatureIds: ['vetleo-leo-power', 'vetleo-everyday-care'] },
};

function build() {
  const seedPath = process.argv[2] || path.join(__dirname, 'm3-bet-seed.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  // Gates keyed by tracker phase id.
  const phaseGates = {};
  seed.phases.forEach(p => {
    const id = PHASE_ID_MAP[p.id] || p.id;
    if (p.gate) phaseGates[id] = p.gate;
  });

  // A tracker-shaped Phase 0 object so renderPhaseCard/renderDetail can handle it
  // like any other phase (it renders as a completed phase in the spine).
  const p0 = seed.phases.find(p => p.id === 'p0-presales');
  const phase0 = {
    id: 'phase0',
    number: 0,
    name: 'Phase 0 — Presales',
    subtitle: 'Feasibility, project brief, scope reconciliation & Tollgate-1',
    state: 'complete',
    type: 'presales',
    startDate: null,
    expectedEndDate: (p0 && p0.gate && p0.gate.agreedAt) || null,
    totalWeeks: null,
    milestones: [],
    subphases: [],
    staff: [],
    history: [],
    gate: p0 ? p0.gate : null,
  };

  const dbdos = {
    _meta: {
      generatedBy: 'scripts/seed-dbdos.js',
      source: path.basename(seedPath),
      note: 'Static DB DOS scope layer merged onto data.json at load (applyDbDos). PM edits persist via api/state.js overrides. Do NOT add these fields to data.json — data-refresh.js would overwrite them.',
    },
    client: seed.client,
    contract: seed.contract,
    // Non-sensitive Project Brief scaffolding (section structure + KB doc index + open
    // questions). Narrative stays in the private KB — see the seed's _briefNote.
    brief: seed.brief || null,
    // builds[] in the schema become the product registry (product = dimension, not a top unit).
    products: (seed.builds || []).map(b => ({ ...b })),
    contractScope: seed.contractScope || [],
    features: seed.features || [],
    phaseGates,
    phaseProducts: PHASE_PRODUCTS,
    phase0,
    milestoneLinks: MILESTONE_LINKS,
    changeOrders: seed.changeOrders || [],
    audit: [],
  };

  const outPath = path.join(__dirname, '..', 'dbdos.json');
  fs.writeFileSync(outPath, JSON.stringify(dbdos, null, 2) + '\n');
  console.log(`Wrote ${outPath}`);
  console.log(`  products: ${dbdos.products.length} · contractScope: ${dbdos.contractScope.length} · features: ${dbdos.features.length} · gates: ${Object.keys(phaseGates).length} · milestoneLinks: ${Object.keys(MILESTONE_LINKS).length}`);
}

build();
