# M3 Phase Tracking Dashboard — Project Context for Claude

## What this is
A static dashboard deployed at https://m3-dashboard-tau.vercel.app/ for tracking the M3 client engagement.
Data lives in `data.json`, refreshed nightly by GitHub Actions pulling from ProjectX API.
The HTML/JS app reads `data.json` at page load — no backend, no database.

---

## Known Vercel Deployment Issue ⚠️

**Problem:** All GitHub Actions commits are blocked by Vercel Hobby plan.

> "The deployment was blocked because the commit author did not have contributing access to the project on Vercel. The Hobby Plan does not support collaboration for private repositories."

**Root cause:** Vercel's GitHub integration checks the *GitHub API-level pusher identity*, not the git commit author metadata. Even setting `git config user.name "mjboehm4570"` in the workflow does not help — GitHub Actions is always treated as a non-owner pusher on a private repo under the Hobby plan.

**What does NOT work:**
- Changing `git config user.name` / `git config user.email` in the workflow
- Upgrading `actions/checkout` version

**Real fix — Vercel Deploy Hook:**
Replace Vercel's GitHub integration auto-deploy with a deploy hook URL that the workflow calls explicitly. Deploy hooks are not subject to collaborator restrictions.

Steps to implement:
1. In Vercel dashboard → Project Settings → Git → Deploy Hooks → create a hook named "nightly-refresh" on branch `main`
2. Copy the generated URL (looks like `https://api.vercel.com/v1/integrations/deploy/prj_.../...`)
3. Add it as a GitHub Actions secret named `VERCEL_DEPLOY_HOOK`
4. Add this step to `.github/workflows/refresh-data.yml` after the push step:
   ```yaml
   - name: Trigger Vercel deploy
     run: curl -X POST "${{ secrets.VERCEL_DEPLOY_HOOK }}"
   ```
5. Optionally disconnect the GitHub ↔ Vercel automatic integration in Vercel Project Settings → Git, so only explicit hook calls trigger deploys (prevents double deploys on manual pushes).

**Workaround until deploy hook is set up:**
After any git push from this repo, manually trigger a redeploy from the Vercel dashboard (Deployments → Redeploy on the latest commit).

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
- Repo: `https://github.com/mjboehm4570/m3-dashboard` (private)
- Branch: `main` → auto-deploys to Vercel (when Hobby plan block is resolved via deploy hook)
- Claude cannot run git commands directly in the sandbox on a Mac-mounted filesystem — use `mcp__Control_your_Mac__osascript` to run git in the user's Terminal
- If push is rejected with "fetch first", run `git pull --rebase && git push`

---

## Pending / Future Work
- [ ] Wire up Vercel deploy hook (see above) to fix nightly deployment
- [ ] Replace localStorage overrides with Airtable for cross-device persistence
- [ ] Confirm Kevin M. and Sarah K. exact ProjectX full names
- [ ] Update PRD sections 2 and 5.2 to reflect Phase 1A/1B split
