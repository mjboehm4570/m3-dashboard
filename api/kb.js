// ═══════════════════════════════════════════════════════════════════════════
// api/kb.js — serverless read-only proxy for the private knowledge-base repo.
//
//   GET /api/kb            → curated (final/) KB docs grouped by layer, with
//                            title / owner / status / last-updated / summary / GitHub link.
//   GET /api/kb?path=<p>    → a single doc (same fields) PLUS its full markdown
//                            `body` (frontmatter stripped), for in-app reading.
//                            `p` is validated against the final/*.md allowlist,
//                            so the proxy can never read arbitrary repo files.
//
// The KB repo is PRIVATE and confidential; m3-dashboard is a PUBLIC repo, so we
// never commit KB content. This reads it live with a server-side token and
// gates access behind EDIT_SECRET (same secret the Leadership view already uses).
//
// Env vars (Vercel → Project Settings → Environment Variables):
//   KB_REPO_TOKEN — GitHub PAT with read (contents) access to the KB repo
//   EDIT_SECRET   — shared passphrase; GET requires the x-edit-secret header to match
//   KB_REPO       — optional, default 'dualboot-partners/m3-knowledge-base'
//   KB_BRANCH     — optional, default 'main'
//
// Returns 503 if KB_REPO_TOKEN is unset (client then shows a "not configured" note).
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN = process.env.KB_REPO_TOKEN;
const EDIT_SECRET = process.env.EDIT_SECRET || '';
const REPO = process.env.KB_REPO || 'dualboot-partners/m3-knowledge-base';
const BRANCH = process.env.KB_BRANCH || 'main';

function gh(path) {
  return fetch('https://api.github.com' + path, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'm3-dashboard-kb',
    },
  });
}

async function listFinalDocs() {
  const r = await gh(`/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  if (!r.ok) throw new Error(`tree ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.tree || [])
    .filter(n => n.type === 'blob')
    .map(n => n.path)
    .filter(p => /^layers\/layer-\d+-[^/]+\/final\/.+\.md$/.test(p))
    .filter(p => !/_example/i.test(p));
}

async function fetchDoc(path, includeBody) {
  const r = await gh(`/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${BRANCH}`);
  if (!r.ok) return null;
  const j = await r.json();
  const text = Buffer.from(j.content || '', 'base64').toString('utf8');
  return parseDoc(text, path, includeBody);
}

function layerKeyOf(path) {
  const m = path.match(/^layers\/(layer-\d+-[^/]+)\//);
  return m ? m[1] : 'other';
}
function layerLabel(key) {
  const w = key.replace(/^layer-\d+-/, '');
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : key;
}
function layerNum(key) {
  const m = key.match(/^layer-(\d+)-/);
  return m ? parseInt(m[1], 10) : 99;
}

function parseDoc(text, path, includeBody) {
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, 25);
  const grab = key => {
    for (const l of head) {
      const m = l.match(new RegExp('^\\s*#*\\s*' + key + '\\s*:\\s*(.*)$', 'i'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
    return '';
  };
  const firstHeadingIdx = lines.findIndex(l => /^#\s+/.test(l));
  let title = grab('title');
  if (!title && firstHeadingIdx >= 0) title = lines[firstHeadingIdx].replace(/^#\s+/, '').trim();
  if (!title) title = path.split('/').pop().replace(/\.md$/, '');

  let summary = '';
  if (firstHeadingIdx >= 0) {
    for (let i = firstHeadingIdx + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t === '---' || t.startsWith('#') || t.startsWith('>') || /^[a-z_]+:\s/i.test(t) || t.startsWith('- ')) continue;
      summary = t;
      break;
    }
  }
  summary = summary.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '');
  if (summary.length > 240) summary = summary.slice(0, 237) + '…';

  const doc = {
    title,
    path,
    relPath: path.replace(/^layers\/layer-\d+-[^/]+\/final\//, ''),
    owner: grab('owner'),
    lastUpdated: grab('last_updated'),
    status: grab('status'),
    summary,
    url: `https://github.com/${REPO}/blob/${BRANCH}/${path}`,
  };
  if (includeBody) {
    // Body = everything from the first `# ` heading onward (skips the irregular
    // frontmatter block the finals carry). No heading → strip a leading ---…---
    // fence if present, else keep the whole file.
    let start = firstHeadingIdx;
    if (start < 0) {
      start = 0;
      if ((lines[0] || '').trim() === '---') {
        const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        if (close > 0) start = close + 1;
      }
    }
    doc.body = lines.slice(start).join('\n').trim();
  }
  return doc;
}

// Only final/*.md docs are readable through the proxy (never arbitrary repo files).
const DOC_PATH_RE = /^layers\/layer-\d+-[^/]+\/final\/.+\.md$/;

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-edit-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!TOKEN) return res.status(503).json({ error: 'KB not configured' });
  if (EDIT_SECRET && req.headers['x-edit-secret'] !== EDIT_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  try {
    // Single-doc mode: return one doc with its full markdown body for in-app reading.
    const wantPath = (req.query && (req.query.path || req.query.doc)) || '';
    if (wantPath) {
      if (!DOC_PATH_RE.test(wantPath) || /_example/i.test(wantPath)) {
        return res.status(400).json({ error: 'Invalid doc path' });
      }
      const doc = await fetchDoc(wantPath, true);
      if (!doc) return res.status(404).json({ error: 'Doc not found' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(doc);
    }

    const paths = await listFinalDocs();
    const docs = (await pool(paths, 8, fetchDoc)).filter(Boolean);
    const byKey = {};
    docs.forEach(d => {
      const key = layerKeyOf(d.path);
      (byKey[key] = byKey[key] || []).push(d);
    });
    const layers = Object.keys(byKey)
      .sort((a, b) => layerNum(a) - layerNum(b))
      .map(key => ({
        key,
        label: layerLabel(key),
        docs: byKey[key].sort((a, b) => a.relPath.localeCompare(b.relPath)),
      }));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ repo: REPO, branch: BRANCH, count: docs.length, layers });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
