// ═══════════════════════════════════════════════════════════════════════════
// api/github.js — serverless proxy for GitHub epics (the auto-passthrough source).
//
//   GET /api/github → returns normalized "epics" the dashboard maps to BET Features.
//
// DB DOS auto-passthrough: GitHub epics ↔ Features (hybrid mapping); ProjectX hours
// attribute via the ticket-number convention (entry → ticket# → issue → feature).
// M3 development hasn't started, so this ships as PLUMBING + MOCK: until a repo + token
// are configured it returns a representative mock payload (flagged mock:true) so the
// rollup + reconciliation UI can be demoed. Blocked on SPIKE-1 (mapping reliability)
// and SPIKE-2 (ProjectX ticket-number field) before pointing at a live repo.
//
// Env vars (Vercel → Project Settings → Environment Variables):
//   GITHUB_TOKEN — PAT with read (contents/issues) on the build repo (enables live mode)
//   GITHUB_REPO  — 'owner/name' of the build repo (required for live mode)
//   EDIT_SECRET  — shared passphrase; GET requires x-edit-secret to match (when set)
//
// Never 503s: absent config → mock mode (deliberate, so the passthrough is demoable).
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || '';
const EDIT_SECRET = process.env.EDIT_SECRET || '';

// Mock epics: a few mapped to seeded VetLeo/Raivan features (with rolled-up hours from
// the ProjectX ticket join), plus one UNMAPPED epic that should surface as candidate new scope.
const MOCK = {
  mock: true,
  repo: REPO || 'dualboot-partners/m3-vetleo (mock)',
  epics: [
    { repo: 'm3-vetleo', number: 12, type: 'epic', title: 'Onboarding + pet profile', url: '#', state: 'open', featureId: 'vetleo-getting-started', hours: 180, tickets: ['VL-101', 'VL-102'] },
    { repo: 'm3-vetleo', number: 15, type: 'epic', title: 'Pet history & document uploads', url: '#', state: 'open', featureId: 'vetleo-pet-history', hours: 240, tickets: ['VL-110'] },
    { repo: 'm3-vetleo', number: 21, type: 'epic', title: 'Triage conversation + escalation', url: '#', state: 'open', featureId: 'vetleo-triage', hours: 95, tickets: ['VL-130', 'VL-131'] },
    { repo: 'm3-vetleo', number: 33, type: 'epic', title: 'Push notifications & reminders engine', url: '#', state: 'open', featureId: null, hours: 60, tickets: ['VL-150'] },
  ],
};

function gh(path) {
  return fetch('https://api.github.com' + path, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'm3-dashboard-github' },
  });
}

// Live mode: pull issues labeled "epic" and normalize. Feature mapping / hours are left
// null here — the client's hybrid mapping (UI + AI suggestions) + ProjectX join fill them.
async function listEpics() {
  const r = await gh(`/repos/${REPO}/issues?state=all&labels=epic&per_page=100`);
  if (!r.ok) throw new Error(`issues ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j || []).filter(i => !i.pull_request).map(i => ({
    repo: REPO.split('/').pop(), number: i.number, type: 'epic', title: i.title,
    url: i.html_url, state: i.state, featureId: null, hours: null, tickets: [],
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-edit-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (EDIT_SECRET && req.headers['x-edit-secret'] !== EDIT_SECRET) return res.status(401).json({ error: 'Invalid secret' });

  res.setHeader('Cache-Control', 'no-store');
  // Mock mode when not fully configured — deliberate, keeps the passthrough demoable.
  if (!TOKEN || !REPO) return res.status(200).json(MOCK);
  try {
    return res.status(200).json({ mock: false, repo: REPO, epics: await listEpics() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
