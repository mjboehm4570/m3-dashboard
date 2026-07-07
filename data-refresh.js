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

// Entries with task: null are attributed to this task ID (Phase 1A VetLeo Discovery)
const NULL_TASK_DEFAULT = 280;

/**
 * STAFF NAME MAP — maps ProjectX full_name values to data.json staff IDs.
 * The grouped_by_users endpoint returns full_name (e.g. "Teresita Ambrosio").
 * After running --diagnose, verify each name below matches exactly.
 * Format: 'Exact ProjectX full_name': 'data.json staff id'
 */
const STAFF_NAME_TO_ID = {
  'Mike Boehm':        'mikeb',
  // Billy Reuben omitted — does not log hours in ProjectX
  'Kevin Moran':       'kevinm',    // ← confirm exact name once he logs
  'Teresita Ambrosio': 'tereg',     // confirmed
  'Rodrigo Pisani':    'rodril',    // confirmed
  'Sarah Kovacs':      'sarak',     // ← confirm exact name once she logs
  'Ignacio Dominguez': 'ignaciod',  // confirmed — designer
  'Lucia Counago':     'luciac',    // confirmed — designer
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
// ProjectX wraps responses in {"report": {"tracked_time_entries": [...], "total_pages": N}}
// or {"report": {"users": [...], "total_pages": N}} for grouped endpoints.
async function fetchAllPages(baseEndpoint) {
  const all = [];
  let page  = 1;

  while (true) {
    const sep  = baseEndpoint.includes('?') ? '&' : '?';
    const data = await apiGet(`${baseEndpoint}${sep}page=${page}`);

    // Unwrap the {report: {...}} envelope
    const report = (data && typeof data === 'object' && data.report) ? data.report : data;

    const entries = Array.isArray(report)
      ? report
      : (report.tracked_time_entries || report.users || report.entries || report.data || []);

    all.push(...entries);

    const totalPages =
      report.total_pages ||
      data.total_pages   ||
      report.pagination?.total_pages ||
      1;

    if (DIAGNOSE) console.log(`  page ${page}/${totalPages}, got ${entries.length} entries`);

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
  // duration field is in MINUTES — divide by 60 to get hours.
  // Entries with task: null are attributed to NULL_TASK_DEFAULT (Phase 1A VetLeo).
  function hoursFromEntries(entries) {
    const byTask = {};
    for (const e of entries) {
      const taskId = e.task?.id ?? e.task_id ?? e.task?.task_id ?? NULL_TASK_DEFAULT;
      byTask[taskId] = (byTask[taskId] || 0) + (e.duration || 0) / 60;
    }
    return byTask;
  }

  const taskHoursAll  = hoursFromEntries(allEntries);
  const taskHoursWeek = hoursFromEntries(weekEntries);

  if (DIAGNOSE) {
    console.log('\n=== DIAGNOSE: Task hour totals (all-time) ===');
    console.log(taskHoursAll);
    if (allEntries.length > 0) {
      console.log('\n=== DIAGNOSE: Full first entry (task field check) ===');
      console.log(JSON.stringify(allEntries[0], null, 2));
    }
  }

  // ── 6. Aggregate: hours by task ID + user (for subphase staff breakdown) ──
  // Shape: { 'Full Name': { taskId: hours, ... } }
  // User name from flat entries: user.full_name or "first_name last_name"
  function fullNameFromEntry(e) {
    return e.user?.full_name
      || (e.user?.first_name ? `${e.user.first_name} ${e.user.last_name || ''}`.trim() : null)
      || e.user_name
      || null;
  }

  function staffTaskHoursFromEntries(entries) {
    const byUserTask = {};
    for (const e of entries) {
      const name   = fullNameFromEntry(e);
      const taskId = e.task?.id ?? e.task_id ?? e.task?.task_id ?? NULL_TASK_DEFAULT;
      if (!name) continue;
      if (!byUserTask[name]) byUserTask[name] = {};
      byUserTask[name][taskId] = (byUserTask[name][taskId] || 0) + (e.duration || 0) / 60;
    }
    return byUserTask;
  }

  const staffTaskAll  = staffTaskHoursFromEntries(allEntries);
  const staffTaskWeek = staffTaskHoursFromEntries(weekEntries);

  // ── 7. Aggregate: total hours by user from grouped endpoint ───────────────
  // The grouped_by_users endpoint returns {full_name, time_entries: [...]} per user.
  // Sum the nested time_entries durations for each user.
  function staffTotalHours(groupedUsers) {
    const byName = {};
    for (const u of groupedUsers) {
      // full_name is the primary field on the grouped endpoint
      const name = u.full_name || u.user?.full_name || u.user?.name || u.user_name || u.name;
      if (!name) continue;
      // Sum nested time_entries if present, otherwise use a top-level duration/total_duration
      const hours = u.time_entries
        ? u.time_entries.reduce((s, e) => s + (e.duration || 0), 0) / 60
        : (u.total_duration ?? u.duration ?? 0) / 60;
      byName[name] = (byName[name] || 0) + hours;
    }
    return byName;
  }

  const staffTotalsAll  = staffTotalHours(staffAllTime);
  const staffTotalsWeek = staffTotalHours(staffThisWeek);

  const foundUsers = Object.keys(staffTotalsAll);
  console.log(`[data-refresh] ProjectX users found (${foundUsers.length}):`, foundUsers.join(', ') || '(none)');
  if (foundUsers.length > 0) {
    const unmapped = foundUsers.filter(n => !STAFF_NAME_TO_ID[n]);
    if (unmapped.length) console.log('  ⚠ Not in STAFF_NAME_TO_ID map:', unmapped.join(', '));
  }

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
