#!/usr/bin/env node
/**
 * data-refresh.js
 * Pulls live time tracking data from ProjectX for the M3 engagement (project 338)
 * and writes an updated data.json for the Phase Tracking Dashboard.
 *
 * Usage:
 *   PROJECTX_API_KEY=... node data-refresh.js              # normal run
 *   PROJECTX_API_KEY=... node data-refresh.js --dry-run    # preview without writing
 *   PROJECTX_API_KEY=... node data-refresh.js --diagnose   # log raw API payloads
 *
 * Required env var:
 *   PROJECTX_API_KEY  — set as a GitHub Actions secret named PROJECTX_API_KEY
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

const API_KEY    = process.env.PROJECTX_API_KEY;
const BASE_URL   = 'https://projectx.dualbootpartners.com/api/v1/public';
const PROJECT_ID = 338;
const DRY_RUN    = process.argv.includes('--dry-run');
const DIAGNOSE   = process.argv.includes('--diagnose');
const DATA_PATH  = path.join(__dirname, 'data.json');

// Engagement start — used as the earliest after_date for all-time totals
const ENGAGEMENT_START = '2026-06-09';

// Phase → ProjectX task ID(s)
const PHASE_TASK_IDS = {
  phase1: [280, 285],
  phase2: [281],
  phase3: [282],
  phase4: [283],
  phase5: [284],
};

// ProjectX task ID → subphase ID (for subphase hour attribution)
const TASK_TO_SUBPHASE = {
  280: '1a',
  285: '1b',
};

/**
 * STAFF NAME MAP — maps ProjectX user full names to data.json staff IDs.
 * Run once with --diagnose to see the names ProjectX returns, then update here.
 * Format: 'Exact ProjectX Name': 'data.json staff id'
 */
const STAFF_NAME_TO_ID = {
  'Mike Boehm':    'mikeb',
  'Billy Reuben':  'billyr',   // update if name differs in ProjectX
  'Kevin M':       'kevinm',   // update if name differs in ProjectX
  'Tere G':        'tereg',    // update if name differs in ProjectX
  'Rodri L':       'rodril',   // update if name differs in ProjectX
  'Sarah K':       'sarak',    // update if name differs in ProjectX
};

// ─── HTTP helper ────────────────────────────────────────────────────────────

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${endpoint}`;
    if (DIAGNOSE) console.log('  → GET', url);

    https.get(url, { headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} on ${endpoint}: ${body.slice(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(body);
          if (DIAGNOSE) console.log('  ← Sample:', JSON.stringify(parsed).slice(0, 400));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Fetches all pages of a paginated endpoint, returning a flat array of entries.
// Handles both array responses and {time_entries: [], total_pages: N} shapes.
async function fetchAllPages(baseEndpoint) {
  const all = [];
  let page  = 1;

  while (true) {
    const sep  = baseEndpoint.includes('?') ? '&' : '?';
    const data = await apiGet(`${baseEndpoint}${sep}page=${page}`);

    // Normalise: API may return a raw array or a wrapper object
    const entries = Array.isArray(data)
      ? data
      : (data.time_entries || data.entries || data.data || []);

    all.push(...entries);

    const totalPages =
      data.total_pages ||
      data.pagination?.total_pages ||
      data.meta?.total_pages ||
      1;

    if (page >= totalPages || entries.length === 0) break;
    page++;
  }

  return all;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function todayStr() {
  return toDateStr(new Date());
}

// Monday of the current week
function weekStartStr() {
  const d   = new Date();
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return toDateStr(d);
}

function elapsedWeeks(startDateStr) {
  if (!startDateStr) return 0;
  const ms = Date.now() - new Date(startDateStr).getTime();
  return Math.max(0, Math.floor(ms / (7 * 24 * 60 * 60 * 1000)));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('ERROR: PROJECTX_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const TODAY      = todayStr();
  const WEEK_START = weekStartStr();
  console.log(`[data-refresh] Starting${DRY_RUN ? ' (DRY RUN)' : ''} — today: ${TODAY}, week starts: ${WEEK_START}`);

  // Load existing data.json (we patch it in-place, preserving milestones etc.)
  const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  // ── 1. All-time flat time entries ─────────────────────────────────────────
  console.log('[data-refresh] Fetching all-time entries...');
  const allEntries = await fetchAllPages(
    `/reports/tracked_time_entries?project_ids_in[]=${PROJECT_ID}&after_date=${ENGAGEMENT_START}&before_date=${TODAY}`
  );
  console.log(`  ${allEntries.length} entries`);

  if (DIAGNOSE && allEntries.length > 0) {
    console.log('\n=== DIAGNOSE: Sample all-time entry ===');
    console.log(JSON.stringify(allEntries[0], null, 2));
  }

  // ── 2. This-week flat time entries ────────────────────────────────────────
  console.log('[data-refresh] Fetching this-week entries...');
  const weekEntries = await fetchAllPages(
    `/reports/tracked_time_entries?project_ids_in[]=${PROJECT_ID}&after_date=${WEEK_START}&before_date=${TODAY}`
  );
  console.log(`  ${weekEntries.length} entries`);

  // ── 3. Staff grouped (all-time) ───────────────────────────────────────────
  console.log('[data-refresh] Fetching staff breakdown (all-time)...');
  const staffAllTime = await fetchAllPages(
    `/reports/tracked_time_entries/grouped_by_users?project_ids_in[]=${PROJECT_ID}&after_date=${ENGAGEMENT_START}&before_date=${TODAY}`
  );

  if (DIAGNOSE && staffAllTime.length > 0) {
    console.log('\n=== DIAGNOSE: Sample staff entry ===');
    console.log(JSON.stringify(staffAllTime[0], null, 2));
  }

  // ── 4. Staff grouped (this week) ──────────────────────────────────────────
  console.log('[data-refresh] Fetching staff breakdown (this week)...');
  const staffThisWeek = await fetchAllPages(
    `/reports/tracked_time_entries/grouped_by_users?project_ids_in[]=${PROJECT_ID}&after_date=${WEEK_START}&before_date=${TODAY}`
  );

  // ── 5. Aggregate: hours by task ID ────────────────────────────────────────
  // duration field is in MINUTES — divide by 60 to get hours
  function hoursFromEntries(entries) {
    const byTask = {};
    for (const e of entries) {
      const taskId = e.task?.id ?? e.task_id;
      if (taskId == null) continue;
      byTask[taskId] = (byTask[taskId] || 0) + (e.duration || 0) / 60;
    }
    return byTask;
  }

  const taskHoursAll  = hoursFromEntries(allEntries);
  const taskHoursWeek = hoursFromEntries(weekEntries);

  // ── 6. Aggregate: hours by task ID + user (for subphase staff breakdown) ──
  // Shape: { 'UserName': { taskId: hours, taskId: hours } }
  function staffTaskHoursFromEntries(entries) {
    const byUserTask = {};
    for (const e of entries) {
      const name   = e.user?.name ?? e.user_name ?? e.name;
      const taskId = e.task?.id   ?? e.task_id;
      if (!name || taskId == null) continue;
      if (!byUserTask[name]) byUserTask[name] = {};
      byUserTask[name][taskId] = (byUserTask[name][taskId] || 0) + (e.duration || 0) / 60;
    }
    return byUserTask;
  }

  const staffTaskAll  = staffTaskHoursFromEntries(allEntries);
  const staffTaskWeek = staffTaskHoursFromEntries(weekEntries);

  // ── 7. Aggregate: total hours by user from grouped endpoint ───────────────
  // The grouped endpoint returns one record per user with a totalled duration.
  // Handles both {user: {name}, duration} and {user_name, total_duration} shapes.
  function staffTotalHours(groupedEntries) {
    const byName = {};
    for (const e of groupedEntries) {
      const name  = e.user?.name ?? e.user_name ?? e.name;
      const hours = (e.duration ?? e.total_duration ?? 0) / 60;
      if (name) byName[name] = (byName[name] || 0) + hours;
    }
    return byName;
  }

  const staffTotalsAll  = staffTotalHours(staffAllTime);
  const staffTotalsWeek = staffTotalHours(staffThisWeek);

  console.log('[data-refresh] ProjectX users found:', Object.keys(staffTotalsAll).join(', ') || '(none — check STAFF_NAME_TO_ID map)');

  // ── 8. Patch each phase ───────────────────────────────────────────────────
  const updated = {
    ...existing,
    lastUpdated: new Date().toISOString(),
  };

  updated.phases = existing.phases.map(phase => {
    const taskIds   = PHASE_TASK_IDS[phase.id] || [];
    const usedHours = Math.round(taskIds.reduce((s, tid) => s + (taskHoursAll[tid] || 0), 0));

    const patchedPhase = {
      ...phase,
      usedHours,
      elapsedWeeks: phase.startDate ? elapsedWeeks(phase.startDate) : phase.elapsedWeeks,
    };

    // Subphase hours
    if (phase.subphases?.length) {
      patchedPhase.subphases = phase.subphases.map(sp => ({
        ...sp,
        usedHours: Math.round(taskHoursAll[sp.taskId]  || 0),
        weekHours: Math.round(taskHoursWeek[sp.taskId] || 0),
      }));
    }

    // Staff hours — match by name using STAFF_NAME_TO_ID
    if (phase.staff?.length) {
      patchedPhase.staff = phase.staff.map(s => {
        // Find the ProjectX name that maps to this staff ID
        const pxName = Object.entries(STAFF_NAME_TO_ID).find(([, id]) => id === s.id)?.[0];

        // Fall back to fuzzy first-name match if exact mapping not found
        const findByFirstName = (nameMap) =>
          Object.entries(nameMap).find(([name]) =>
            name.toLowerCase().startsWith(s.name.toLowerCase().split(' ')[0].toLowerCase())
          );

        const totalEntry = pxName
          ? [pxName, staffTotalsAll[pxName] ?? 0]
          : findByFirstName(staffTotalsAll);
        const weekEntry  = pxName
          ? [pxName, staffTotalsWeek[pxName] ?? 0]
          : findByFirstName(staffTotalsWeek);

        const hoursTotal    = totalEntry ? Math.round(totalEntry[1]) : s.hoursTotal;
        const hoursThisWeek = weekEntry  ? Math.round(weekEntry[1])  : s.hoursThisWeek;

        // Subphase hours per staff member (from flat entries)
        const pxNameResolved = totalEntry?.[0];
        const subphaseHours     = { ...s.subphaseHours };
        const subphaseWeekHours = { ...s.subphaseWeekHours };

        if (pxNameResolved) {
          const userTaskAll  = staffTaskAll[pxNameResolved]  || {};
          const userTaskWeek = staffTaskWeek[pxNameResolved] || {};
          for (const [taskId, spId] of Object.entries(TASK_TO_SUBPHASE)) {
            if (userTaskAll[taskId]  != null) subphaseHours[spId]     = Math.round(userTaskAll[taskId]);
            if (userTaskWeek[taskId] != null) subphaseWeekHours[spId] = Math.round(userTaskWeek[taskId]);
          }
        }

        return { ...s, hoursTotal, hoursThisWeek, subphaseHours, subphaseWeekHours };
      });
    }

    return patchedPhase;
  });

  // ── 9. Print summary ──────────────────────────────────────────────────────
  console.log('\n[data-refresh] Phase summary:');
  for (const p of updated.phases) {
    const budget = p.budgetHours || p.monthlyCapHours || '?';
    const pct    = p.budgetHours ? `${Math.round(p.usedHours / p.budgetHours * 100)}%` : '';
    console.log(`  Phase ${p.number} (${p.state}): ${p.usedHours} / ${budget} hrs ${pct}`);
  }

  // ── 10. Write or preview ──────────────────────────────────────────────────
  const output = JSON.stringify(updated, null, 2);

  if (DRY_RUN) {
    console.log('\n[data-refresh] DRY RUN — data.json not written. Preview:\n');
    console.log(output.slice(0, 800) + '\n...');
  } else {
    fs.writeFileSync(DATA_PATH, output, 'utf8');
    console.log(`\n[data-refresh] ✓ data.json updated (${output.length} bytes)`);
  }
}

main().catch(err => {
  console.error('[data-refresh] FATAL:', err.message);
  process.exit(1);
});
