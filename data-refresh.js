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
  'Rafael Torre':      'rafael.torre',   // ← confirm exact name — was falling through to auto-discovery every night, creating dupes (cleaned up 2026-07-16)
  'Nicolas Crocco':    'nicolas.crocco', // ← confirm exact name — same issue
};

// Case/whitespace/accent-insensitive key for matching ProjectX full_name values —
// a name that only differs by case, stray whitespace, or diacritics (e.g. "José"
// vs "Jose") should resolve to the same person instead of silently minting a
// second staffId via auto-discovery.
function normalizeName(fullName) {
  return fullName
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().replace(/\s+/g, ' ').toLowerCase();
}

const NORMALIZED_STAFF_NAME_TO_ID = Object.fromEntries(
  Object.entries(STAFF_NAME_TO_ID).map(([name, id]) => [normalizeName(name), id])
);

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

  // ── 5c. Surface hours logged against task IDs no phase claims ─────────────
  // usedHours below only sums each phase's own PHASE_TASK_IDS entry, so any
  // task ID not listed there (e.g. an internal/admin task never mapped) is
  // silently counted in zero phase totals. Make that gap visible instead of
  // silent, so a project-total vs. dashboard-total mismatch is diagnosable
  // from data.json without re-running --diagnose against ProjectX by hand.
  const ALL_MAPPED_TASK_IDS = new Set(Object.values(PHASE_TASK_IDS).flat());
  const unmappedTaskIds = Object.keys(taskHoursAll)
    .map(Number)
    .filter(tid => !ALL_MAPPED_TASK_IDS.has(tid));
  const unmappedHours = Math.round(
    unmappedTaskIds.reduce((s, tid) => s + (taskHoursAll[tid] || 0), 0) * 10
  ) / 10;

  if (unmappedTaskIds.length) {
    console.warn(
      `[data-refresh] ⚠ ${unmappedHours} hours logged against task ID(s) [${unmappedTaskIds.join(', ')}] ` +
      `are not mapped to any phase in PHASE_TASK_IDS — these hours are NOT included in any phase total. ` +
      `Add them to PHASE_TASK_IDS if they belong to a phase, or confirm they're expected non-phase overhead.`
    );
  } else {
    console.log('[data-refresh] All logged task IDs are mapped to a phase — no hours are being dropped.');
  }

  // ── 5b. Daily burn history (backfill for the Burn & Pace chart) ───────────
  // The exact per-entry date field hasn't been confirmed against production,
  // so try the plausible candidates in order rather than hard-coding one.
  function entryDateField(e) {
    return e.date || e.tracked_on || e.tracked_date || e.performed_at || e.day || null;
  }

  if (DIAGNOSE && allEntries.length > 0) {
    const dated = allEntries.filter(e => entryDateField(e));
    console.log(`\n=== DIAGNOSE: Entry date field check — ${dated.length}/${allEntries.length} entries have a usable date ===`);
  }

  // Buckets this phase's entries into cumulative-to-date hours per calendar
  // day from startDateStr through todayStr. If no entry carries a recognized
  // date field, falls back to a single today-only point (chart then just
  // accumulates forward one point per night instead of showing real history).
  function buildDailyHistory(entries, taskIds, startDateStr, todayStr) {
    const relevant = entries.filter(e => {
      const taskId = e.task?.id ?? e.task_id ?? e.task?.task_id ?? NULL_TASK_DEFAULT;
      return taskIds.includes(taskId);
    });

    const hoursByDay = {};
    let anyDated = false;
    for (const e of relevant) {
      const raw = entryDateField(e);
      if (!raw) continue;
      anyDated = true;
      const d = String(raw).slice(0, 10);
      hoursByDay[d] = (hoursByDay[d] || 0) + (e.duration || 0) / 60;
    }

    if (!anyDated) {
      const totalUsed = Math.round(relevant.reduce((s, e) => s + (e.duration || 0) / 60, 0) * 10) / 10;
      return [{ date: todayStr, usedHours: totalUsed }];
    }

    const points = [];
    let running = 0;
    for (let d = new Date(startDateStr + 'T00:00:00Z'); toDateStr(d) <= todayStr; d.setUTCDate(d.getUTCDate() + 1)) {
      const ds = toDateStr(d);
      running += hoursByDay[ds] || 0;
      points.push({ date: ds, usedHours: Math.round(running * 10) / 10 });
    }
    return points;
  }

  // Upserts by date so a same-day re-run overwrites rather than duplicates,
  // and back-logged ProjectX edits self-correct on the next nightly run
  // (buildDailyHistory recomputes the whole series from allEntries every time).
  function mergeHistory(existingHistory, newPoints) {
    const byDate = new Map((existingHistory || []).map(p => [p.date, p]));
    for (const p of newPoints) byDate.set(p.date, p);
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
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

  // Maps a normalized name back to the first raw spelling seen, so name-spelling
  // variants of the same person (case/whitespace/accent differences) aggregate
  // into one bucket instead of silently splitting a person's hours in two —
  // this must key aggregation the same way STAFF_NAME_TO_ID resolution does,
  // or a shared staffId still only picks up one variant's hours.
  const displayNameByNormalized = {};
  function trackDisplayName(rawName) {
    const key = normalizeName(rawName);
    if (!displayNameByNormalized[key]) displayNameByNormalized[key] = rawName;
    return key;
  }

  function staffTaskHoursFromEntries(entries) {
    const byUserTask = {};
    for (const e of entries) {
      const name   = fullNameFromEntry(e);
      const taskId = e.task?.id ?? e.task_id ?? e.task?.task_id ?? NULL_TASK_DEFAULT;
      if (!name) continue;
      const key = trackDisplayName(name);
      if (!byUserTask[key]) byUserTask[key] = {};
      byUserTask[key][taskId] = (byUserTask[key][taskId] || 0) + (e.duration || 0) / 60;
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
      const key = trackDisplayName(name);
      byName[key] = (byName[key] || 0) + hours;
    }
    return byName;
  }

  const staffTotalsAll  = staffTotalHours(staffAllTime);
  const staffTotalsWeek = staffTotalHours(staffThisWeek);

  const foundUsers = Object.keys(staffTotalsAll);
  console.log(
    `[data-refresh] ProjectX users found (${foundUsers.length}):`,
    foundUsers.map(k => displayNameByNormalized[k] || k).join(', ') || '(none)'
  );

  // ── 7b. Auto-discover new staff members ───────────────────────────────────
  // Any ProjectX user not yet in STAFF_NAME_TO_ID or data.json is auto-added
  // to the appropriate phase with default values (role: "Team Member", allocated: 0).
  // The PM updates role and allocation in the dashboard — no code change needed.

  // Deterministic full-name slug — always the same for a given pxName string,
  // so re-running on a later night resolves to the same id and existingStaffIds
  // reliably blocks a duplicate push. (Previously this tried a short 6+1-char
  // id first and only fell back to the slug on collision, which meant the same
  // person could get a different id on different runs and each variant produced
  // its own duplicate staff row — see 2026-07-16 dupe cleanup for Rafael/Nicolas.)
  function generateStaffId(fullName) {
    return normalizeName(fullName).replace(/\s+/g, '.').replace(/[^a-z.]/g, '');
  }

  function formatDisplayName(fullName) {
    const parts = fullName.trim().split(' ');
    return `${parts[0]} ${(parts[1] || '').charAt(0)}.`.trim();
  }

  // Build set of staff IDs already in data.json (across all phases)
  const existingStaffIds = new Set(
    existing.phases.flatMap(p => (p.staff || []).map(s => s.id))
  );

  for (const pxName of foundUsers) {
    // pxName here is already normalizeName()'d (it's a key of staffTotalsAll).
    // Skip if already mapped, case/whitespace/accent-insensitively.
    if (NORMALIZED_STAFF_NAME_TO_ID[pxName]) continue;

    const rawName = displayNameByNormalized[pxName] || pxName;
    const candidateId = generateStaffId(rawName);
    if (existingStaffIds.has(candidateId)) {
      // Already added (this run or a prior one) — treat as the same person,
      // don't push a duplicate staff record.
      NORMALIZED_STAFF_NAME_TO_ID[pxName] = candidateId;
      continue;
    }
    NORMALIZED_STAFF_NAME_TO_ID[pxName] = candidateId;
    existingStaffIds.add(candidateId);

    // Find which phase this person logged against
    const userTaskIds = Object.keys(staffTaskAll[pxName] || {}).map(Number);
    const targetPhaseId = Object.entries(PHASE_TASK_IDS).find(([, tids]) =>
      tids.some(tid => userTaskIds.includes(tid))
    )?.[0] || 'phase1';

    const targetPhase = existing.phases.find(p => p.id === targetPhaseId);
    if (!targetPhase) continue;
    if (!targetPhase.staff) targetPhase.staff = [];

    const subphaseHoursDefaults = Object.fromEntries(
      Object.values(TASK_TO_SUBPHASE).map(spId => [spId, 0])
    );

    targetPhase.staff.push({
      id:   NORMALIZED_STAFF_NAME_TO_ID[pxName],
      name: formatDisplayName(rawName),
      role: 'Team Member',   // PM: update role in dashboard
      hoursThisWeek:    0,
      hoursTotal:       0,
      hoursAllocated:   0,   // PM: set allocation in dashboard
      subphaseHours:     { ...subphaseHoursDefaults },
      subphaseWeekHours: { ...subphaseHoursDefaults },
    });

    console.log(`[data-refresh] ✨ Auto-added new staff: ${rawName} → id "${NORMALIZED_STAFF_NAME_TO_ID[pxName]}" on ${targetPhaseId}`);
  }

  // ── 8. Patch each phase ───────────────────────────────────────────────────
  const updated = {
    ...existing,
    lastUpdated: new Date().toISOString(),
    unmappedHours,
    unmappedTaskIds,
  };

  updated.phases = existing.phases.map(phase => {
    const taskIds   = PHASE_TASK_IDS[phase.id] || [];
    const usedHours = Math.round(taskIds.reduce((s, tid) => s + (taskHoursAll[tid] || 0), 0));

    const patchedPhase = {
      ...phase,
      usedHours,
      elapsedWeeks: phase.startDate ? elapsedWeeks(phase.startDate) : phase.elapsedWeeks,
      history: phase.startDate
        ? mergeHistory(phase.history || [], buildDailyHistory(allEntries, taskIds, phase.startDate, TODAY))
        : (phase.history || []),
    };

    // Subphase hours
    if (phase.subphases?.length) {
      patchedPhase.subphases = phase.subphases.map(sp => ({
        ...sp,
        usedHours: Math.round(taskHoursAll[sp.taskId]  || 0),
        weekHours: Math.round(taskHoursWeek[sp.taskId] || 0),
      }));
    }

    // Staff hours — match by name using NORMALIZED_STAFF_NAME_TO_ID. All the
    // name-keyed aggregation maps (staffTaskAll/Week, staffTotalsAll/Week) are
    // keyed by normalizeName() output, so pxName below is a normalized key too.
    if (phase.staff?.length) {
      patchedPhase.staff = phase.staff.map(s => {
        // Find the ProjectX name that maps to this staff ID
        const pxName = Object.entries(NORMALIZED_STAFF_NAME_TO_ID).find(([, id]) => id === s.id)?.[0];

        // Fall back to fuzzy first-name match if exact mapping not found —
        // OR if the exact mapping's name has zero data anywhere in this pull,
        // which usually means STAFF_NAME_TO_ID's spelling doesn't exactly match
        // what ProjectX reports for this person (e.g. a middle name/initial),
        // not that they've genuinely never logged an hour.
        const findByFirstName = (nameMap) =>
          Object.entries(nameMap).find(([name]) =>
            name.startsWith(normalizeName(s.name).split(' ')[0])
          );

        const hasAnyData = (name) =>
          !!name && (
            (staffTaskAll[name]  && Object.keys(staffTaskAll[name]).length  > 0) ||
            (staffTaskWeek[name] && Object.keys(staffTaskWeek[name]).length > 0) ||
            staffTotalsAll[name]  != null ||
            staffTotalsWeek[name] != null
          );

        // grouped_by_users has no task filter, so its hour totals span every
        // phase of the project — it's only used here (and via staffTaskAll/Week
        // below, which are task-level) to resolve which ProjectX full_name this
        // person is, never as the hoursTotal/hoursThisWeek value directly.
        const pxNameResolved =
          (hasAnyData(pxName) && pxName) ||
          findByFirstName(staffTaskAll)?.[0]   ||
          findByFirstName(staffTaskWeek)?.[0]  ||
          findByFirstName(staffTotalsAll)?.[0] ||
          findByFirstName(staffTotalsWeek)?.[0] ||
          null;

        const userTaskAll  = pxNameResolved ? (staffTaskAll[pxNameResolved]  || {}) : {};
        const userTaskWeek = pxNameResolved ? (staffTaskWeek[pxNameResolved] || {}) : {};

        // Phase-scoped totals: sum only the hours tagged to this phase's task IDs
        // (taskIds, defined above), so hours logged against other phases' tasks
        // don't inflate this phase's staff table.
        const phaseTotal = taskIds.reduce((sum, tid) => sum + (userTaskAll[tid]  || 0), 0);
        const phaseWeek  = taskIds.reduce((sum, tid) => sum + (userTaskWeek[tid] || 0), 0);

        const hoursTotal    = pxNameResolved ? Math.round(phaseTotal) : s.hoursTotal;
        const hoursThisWeek = pxNameResolved ? Math.round(phaseWeek)  : s.hoursThisWeek;

        // Subphase hours per staff member (from flat entries)
        const subphaseHours     = { ...s.subphaseHours };
        const subphaseWeekHours = { ...s.subphaseWeekHours };

        if (pxNameResolved) {
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
    const hist   = (p.history && p.history.length)
      ? `history: ${p.history.length} pt${p.history.length === 1 ? '' : 's'} (${p.history[0].date} → ${p.history[p.history.length - 1].date})`
      : 'history: none';
    console.log(`  Phase ${p.number} (${p.state}): ${p.usedHours} / ${budget} hrs ${pct} — ${hist}`);
  }
  if (unmappedTaskIds.length) {
    console.log(`  ⚠ Unmapped: ${unmappedHours} hrs across task ID(s) [${unmappedTaskIds.join(', ')}] — not in any phase total above.`);
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
