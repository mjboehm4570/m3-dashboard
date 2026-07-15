# M3 Phase Tracking Dashboard — Project Context for Claude

## What this is
A static dashboard deployed at https://m3-dashboard-tau.vercel.app/ for tracking the M3 client engagement.
Data lives in `data.json`, refreshed nightly by GitHub Actions pulling from ProjectX API.
The HTML/JS app reads `data.json` at page load — no backend, no database.

---

## Vercel Deployment Issue — RESOLVED (2026-07-08)

**Problem (historical):** All GitHub Actions commits were blocked by Vercel Hobby plan.

> "The deployment was blocked because the commit author did not have contributing access to the project on Vercel. The Hobby Plan does not support collaboration for private repositories."

**Root cause:** Vercel's GitHub integration checks the *GitHub API-level pusher identity*, not the git commit author metadata. GitHub Actions was always treated as a non-owner pusher — but per Vercel's own error message, this restriction only applies to **private** repos on the Hobby plan.

**Fix that landed: made the repo public.** `mjboehm4570/m3-dashboard` was switched from private to public on 2026-07-08. Confirmed via Vercel deployment history: the commit right before going public (`35158a1`, "revert: back to deploy hook approach") shows a single **Blocked** deployment; every commit from `de83d80` ("test: verify Vercel auto-deploy on public repo") onward shows deployments succeeding natively — no workaround needed.

**Deploy-hook workaround retired.** We'd previously built a `VERCEL_DEPLOY_HOOK`-based workaround (a dedicated `deploy.yml` workflow plus a curl step at the end of `refresh-data.yml`) to bypass the block. That's no longer needed now that native Git-push auto-deploy works, and was actively causing **double deployments** per push. As of this cleanup:
- `.github/workflows/deploy.yml` — deleted
- `.github/workflows/refresh-data.yml` — "Trigger Vercel deploy" step removed
- `VERCEL_DEPLOY_HOOK` GitHub secret — should be removed (Settings → Secrets)
- The deploy hook itself should be deleted in Vercel dashboard → Project Settings → Git → Deploy Hooks

**If deploys ever get blocked again:** don't recreate the deploy-hook workaround first — check whether the repo accidentally went private again, since that's the actual root cause.

---

## Architecture

| File | Purpose |
|------|---------|
| `index.html` | Full app — reads `data.json`, renders dashboard |
| `data.json` | Live data cache — committed by nightly GitHub Action |
| `data-refresh.js` | Node script run by GitHub Actions to pull ProjectX data |
| `.github/workflows/refresh-data.yml` | Nightly cron at 6 AM CT; also `workflow_dispatch` |
| `vercel.json` | Cache headers: `max-age=300, stale-while-revalidate=3600` |

---

## ProjectX API
- Base URL: `https://projectx.dualbootpartners.com/api/v1/public`
- Auth header: `X-Api-Key` (stored as GitHub secret `PROJECTX_API_KEY`)
- Durations in **minutes** — divide by 60 for hours
- Paginated at 50/page
- Response envelope: `{"report": {"tracked_time_entries": [...], "total_pages": N}}`
- M3 project_id: **338**
- Phase task IDs: 280 (1A VetLeo), 285 (1B Raivan), 281 (Ph2), 282 (Ph3), 283 (Ph4), 284 (Ph5)
- Entries with `task: null` → attributed to task 280 (Phase 1A) per client instruction

---

## Auth / Roles
Two passwords in `index.html` JS (not in version control history — keep them out):
- Team view: `m3-team-2026`
- Leadership view: `m3-lead-2026`

Leadership-only UI elements use class `full-only`; `body[data-role="full"]` shows them via CSS.

**Session persistence:** on successful login the role is stored in `localStorage['m3-session']` with a 7-day sliding expiry (`saveSession`/`readSession`); `loadData` restores it on reload so users aren't logged out on every refresh. `logout()` clears it. Client-side only — same trust level as the passwords.

---

## PM Overrides — Airtable-backed via serverless proxy (Phase 1, 2026-07-10)

PM/Leadership can edit data without touching code. Edits now persist to **Airtable through a serverless proxy** (`api/state.js`), with **localStorage as an offline cache/fallback**.

**Flow:** on load, the client `fetch`es `GET /api/state` for the overrides doc and mirrors it into `localStorage['m3-overrides']`. Each edit updates the in-memory cache, writes localStorage, and `POST`s a granular mutation to `/api/state`. If the API is unreachable or Airtable isn't configured yet, the client falls back to localStorage and the app keeps working (writes warn in console but are not lost).

The overrides document shape (returned by GET, cached in localStorage) is unchanged:

| Key pattern | What it stores |
|-------------|---------------|
| `phaseId + '.milestones'` | Full milestones array for that phase |
| `phaseId + '.staff'` | Object of `{ staffId: { name, role, hoursAllocated } }` patches |
| `phaseId + '.config'` | Phase config overrides: `{ budgetHours, startDate, expectedEndDate, totalWeeks }` |
| `changelog` | Array of `{ ts, phaseId, phaseName, note, changes[] }` — phase edit history |

**POST ops:** `savePhaseMilestones` (upserts the phase's whole milestone set + deletes vanished rows), `upsertStaff`, `upsertConfig`, `appendChangelog`.

### Airtable setup (required for cross-device persistence)
1. Create an Airtable base with 4 tables (field names must match exactly):
   - **Milestones**: `phaseId`, `milestoneId`, `name`, `type`, `targetDate`, `startDate`, `status`, `notes`, `assigneeIds` (long text), `completionPct` (number), `lastUpdated`
   - **StaffMeta**: `phaseId`, `staffId`, `name`, `role`, `hoursAllocated` (number)
   - **PhaseConfig**: `phaseId`, `startDate`, `expectedEndDate`, `budgetHours` (number), `totalWeeks` (number)
   - **Changelog**: `ts`, `phaseId`, `phaseName`, `note`, `changes` (long text / JSON string)
2. In Vercel → Project Settings → Environment Variables, set: `AIRTABLE_TOKEN` (PAT scoped to the base, `data.records:read`+`write`), `AIRTABLE_BASE_ID` (`app…`), and `EDIT_SECRET` (a passphrase gating writes).
3. Seed the base once: `AIRTABLE_TOKEN=… AIRTABLE_BASE_ID=… node scripts/seed-airtable.js` (supports `--dry-run`).
4. On first save in the Leadership view, the client prompts for the `EDIT_SECRET` and caches it in `localStorage['m3-edit-secret']`.

**Security note:** roles are client-side only and `EDIT_SECRET` is the sole write gate — adequate for an internal tool, not strong auth. `startDate` (milestone) and `assigneeIds` columns exist for Phase 2 and are unused today.

**Local dev:** without the Vercel functions runtime (`/api/state` returns 404), the app runs entirely on localStorage — no setup needed to work on the UI.

---

## Staff Name Mapping
`STAFF_NAME_TO_ID` in `data-refresh.js` maps ProjectX `full_name` → dashboard staff IDs.
Auto-discovery: any new ProjectX user not in the map is added automatically with `role: 'Team Member'`, `hoursAllocated: 0`. PM can update role/allocation via the staff edit modal in the Leadership view.

Known pending confirmations:
- Kevin Moran (`kevinm`) — confirm exact ProjectX full_name once he logs time
- Sarah Kovacs (`sarak`) — confirm exact ProjectX full_name once she logs time

---

## Git / Deploy Workflow
- Repo: `https://github.com/mjboehm4570/m3-dashboard` (public, since 2026-07-08 — see deployment fix above)
- Branch: `main` → auto-deploys to Vercel natively on push (no deploy hook needed)
- If push is rejected with "fetch first", run `git pull --rebase && git push`

---

## Pending / Future Work
- [ ] Remove `VERCEL_DEPLOY_HOOK` GitHub secret and delete the hook in Vercel dashboard (leftover from the retired workaround)
- [x] Replace localStorage overrides with Airtable for cross-device persistence — **code shipped (Phase 1); requires Airtable base + Vercel env vars + seed to activate (see "PM Overrides" above)**
- [ ] Confirm Kevin M. and Sarah K. exact ProjectX full names
- [ ] Update PRD sections 2 and 5.2 to reflect Phase 1A/1B split

### Roadmap (planning & intelligence build-out)
Phases 1–2 done. Next per the approved roadmap:
- [x] Phase 2 — enriched milestone model + assignment rollups + date-based deadline alerts. Milestones now carry `startDate` + `assigneeIds`; edit modal has a Start Date field and an owner multi-select (from the phase's `staff[]`). Milestone table shows a start→target Timeline column, owner avatars, and overdue/due-soon pills. New `renderDeadlinesStrip` (overdue + due-within-`dueSoonDays` panel, default 7, override via `phase.alertThresholds.dueSoonDays`) and `renderAssignmentRollup` (per-owner assigned/complete/overdue + hours) panels in the active-phase detail. `phaseHealthState` escalates to at-risk on any overdue milestone; overview banner shows an Overdue count + alert. Date helpers: `daysUntil`, `milestoneDateStatus`. `goToOverview` now re-renders so the banner reflects latest edits. All client-side; Airtable columns already existed from Phase 1.
- [x] Phase 3 — Gantt (frappe-gantt 0.6.1 via cdnjs — the app's **first external dependency**, loaded in `<head>`). Dedicated **Timeline** tab (`#page-timeline`, `goToTimeline`/`renderTimeline`/`initProgramGantt`) shows all *scheduled* phases as bars with a Completion% ⇄ Hours-burned fill toggle + Week/Month/Year scale; unscheduled phases (no `startDate`/`expectedEndDate`) are listed with a hint to set dates via Edit Phase; clicking a phase bar drills in, dragging (Leadership) writes dates via `upsertConfig`. Per-phase **Milestone Timeline** panel in active detail (`renderPhaseGanttPanel`/`initPhaseGantt`) shows milestone bars colored by status/deadline, Day/Week/Month scale; dragging (Leadership) persists via `savePhaseMilestones` and clicking opens the edit modal. Milestones without a `startDate` get a display-only 2-week lead-in (`ganttStart`). Note: frappe wraps the svg in its own `.gantt-container` (the scroll element) — `scrollGanttToStart` (rAF-deferred) scrolls it to the first bar. Bar colors via `custom_class` (`g-complete`/`g-inprogress`/`g-soon`/`g-overdue`/`g-notstarted`/`g-phase-ok`/`g-phase-risk`).
- [x] Phase 4 — Knowledge-base integration (MVP). KB repo is **`dualboot-partners/m3-knowledge-base`** (private), organized by *layer* (0-business … 4-implementation), not by phase, with irregular YAML frontmatter. Because m3-dashboard is a **public** repo we do NOT bake KB content into `data.json`; instead `api/kb.js` (serverless) reads the private repo **live** with a server-side token and returns the curated `final/` docs grouped by layer (title/owner/status/last-updated/summary/GitHub link). New Leadership-only **Knowledge Base** tab (`#page-kb`, `goToKB`/`renderKB`/`kbFetch`) renders them. Gated by `EDIT_SECRET` (reused as the access secret). **Setup to activate:** create a GitHub PAT with read (contents) access to the KB repo → set `KB_REPO_TOKEN` in Vercel env (optionally `KB_REPO`/`KB_BRANCH`). Until set, `/api/kb` returns 503 and the tab shows a "not configured" note. Not phase-mapped (KB has no phase tags) — future: add a `phases:` frontmatter field or a curated mapping.
- [x] Phase 5 — in-app chatbot (MVP). `api/chat.js` (serverless) proxies the Anthropic Messages API (`claude-opus-4-8`, no thinking, `max_tokens` 1024) with the key server-side; gated by `EDIT_SECRET`. Leadership-only floating "💬 Ask" launcher + slide-over panel (`#chat-panel`, `toggleChat`/`sendChat`/`chatFetch`/`buildChatContext`). Grounding: the **client** sends a compact summary of the live dashboard state (phases, hours, milestones w/ owners + overdue/due-soon flags, staff) as `context` each turn — always in sync with what the user sees; multi-turn history is sent (last 12 turns). **Setup to activate:** set `ANTHROPIC_API_KEY` in Vercel env. Until then `/api/chat` returns 503 and the panel shows a "not configured" note. Not yet grounded in the KB (future: have `api/chat` also pull KB summaries). **Data-protection caveat (open):** chat sends client data to Anthropic; broader exposure (public repo + committed `data.json` + client-side passwords) is unresolved — see the earlier discussion.
- [x] Phase 6 — split-phase milestone tracks + phase-detail section tabs. **Tracks:** milestones carry `subphaseId` (a `phase.subphases[].id` like `'1a'`/`'1b'`, or `'shared'` default; migrated in `applyOverrides`). The edit modal has a Track select (split phases only). The Combined/1A/1B toggle is now a **whole-phase lens**: `setSubphase` just sets `subphase` + re-renders, and `milestonesForView(phase)` (shared items show in every track) feeds the milestone table, Gantt, deadlines, assignment rollup, staff-hours, and Deliverable-Completion %. A track badge (`trackBadge`) shows on rows only in Combined view of a split phase. Burn/time gauge stays phase-wide (no per-subphase budget). **Section tabs:** `renderActiveDetail` now renders header + metrics + track toggle, then a `.detail-tabs` strip (`setDetailTab`/`detailTab`) with **Health** (gauge + alerts + deadlines), **Timeline & Milestones** (Gantt + table), **Team** (staff + assignments, full-only), **Log** (changelog, full-only) — team role sees only Health + Timeline. **Persistence:** `subphaseId` added to `api/state.js` (read + `milestoneFields` write) and `scripts/seed-airtable.js`; the write **tolerates a missing `subphaseId` column** (catches Airtable's 422, strips it, retries) so deploys are safe before the column exists. **Setup for cross-device track persistence:** add a `subphaseId` (Single line text) column to the Airtable **Milestones** table — until then track tags save to localStorage only.
