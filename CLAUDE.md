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

---

## localStorage Overrides (`m3-overrides` key)
PM/Leadership can edit data without touching code. All edits persist in localStorage:

| Key pattern | What it stores |
|-------------|---------------|
| `phaseId + '.milestones'` | Full milestones array for that phase |
| `phaseId + '.staff'` | Object of `{ staffId: { name, role, hoursAllocated } }` patches |
| `phaseId + '.config'` | Phase config overrides: `{ budgetHours, startDate, expectedEndDate, totalWeeks }` |
| `changelog` | Array of `{ ts, phaseId, phaseName, note, changes[] }` — phase edit history |

**Limitation:** localStorage is per-browser, per-device. A PM's edits on their laptop won't show on another device. Future fix: replace with Airtable API calls.

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
- [ ] Replace localStorage overrides with Airtable for cross-device persistence
- [ ] Confirm Kevin M. and Sarah K. exact ProjectX full names
- [ ] Update PRD sections 2 and 5.2 to reflect Phase 1A/1B split
