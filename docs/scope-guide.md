# Managing Scope in DB DOS — A Guide Across the Project Journey

> **Who this is for:** anyone new to the dashboard's **Scope** capability, and PMs / delivery leads who want to run it well. It explains *what the Scope section is for* and *how to use it* at each stage of an engagement — Phase 0 (Presales), Phase 1 (Structured Discovery / design), and the build phases where development happens.

---

## 1. Why the Scope section exists

The tracker started as a **phase + hours tracker**. The Scope layer turns it into a tool for **scope certainty from sale to ship** — one connected object that tracks *what we agreed to build* and *what it costs* from the day the contract is signed to the day we ship, and keeps itself current so **scope creep can't hide**.

It answers the two questions that decide whether a fixed-scope engagement stays profitable:

- **Before kickoff — "Do we all agree on what we're building?"** A shared, signed-off understanding of scope across the client's stated needs and the team's plan, so accountability doesn't rest solely on the people incentivized to say yes.
- **During delivery — "Is the work still matching what we agreed?"** A living baseline of agreed scope, plus drift detection when real work (code, hours) starts diverging from it — so you can have the client tradeoff conversation *early* ("scope it and pay, or swap a like-sized feature") instead of absorbing the overrun.

This is the productized version of the **BET** (Budget Estimate Template) — the estimate spreadsheet that normally decays after kickoff. Here it stays alive because it pulls real signals from the tools already in flight (GitHub, ProjectX).

### The core ideas (read this once)

| Concept | What it means |
|---|---|
| **Contract scope** | What the *client* stated they want (from the contract + PRD/SOW). The "client layer." |
| **Feature** | What the *team* actually plans to design and build — the BET line item. The "team layer." Each has an estimate, risk, confidence, and open unknowns. |
| **Reconciliation** | The comparison of those two layers. The **gaps** are the whole point (see below). |
| **Product lens** | A filter (Combined / VetLeo / Raivan / ALF) that threads a single product's scope through every phase. Product is a *dimension*, not a separate project. |
| **Advisory gate** | A readiness checklist on each phase. It **surfaces** whether you're ready to advance — it never *blocks* you. The PM/PD can consciously advance anyway (it's recorded). |
| **Lifecycle** | A feature moves **Draft → Locked → Live**. Draft = a feasibility range (estimates blank). Locked = a client-signed baseline (Tollgate 2). Live = accruing real hours. |

### The three reconciliation gaps (your risk radar)

- 🔴 **Unplanned** — the client expects it, but the team has no feature for it. *This is missed scope* — the "we didn't know enough at sign-off" gap.
- 🔵 **Team-added** — the team planned a feature with no client mandate. *Margin risk* (proactive value, or gold-plating).
- ↺ **Reinterpreted** — the team's read of an item diverges from the client's words. *Surface it before kickoff*, not after.

> **Where to find it in the app:** the program-level **Scope** tab (top nav) shows the whole reconciliation + delivery signals + change orders. Each phase's detail has a **Scope & Features** tab with that phase's gate, features, and reconciliation. Click any feature to open its **drawer** (full BET detail + baseline lock).

---

## 2. Phase 0 — Presales · *establish the baseline before kickoff*

**Goal:** walk into kickoff with a shared, agreed understanding of scope — and a feasibility estimate everyone signed off on. Phase 0's job is to *prevent* the up-market "we underestimated because we didn't know enough" failure.

**What to do in the Scope section:**

1. **Capture the feasibility / Draft BET.** The sales-process estimate becomes the per-product budget envelope (VetLeo / Raivan / ALF). Features start as **Draft** — estimates are intentionally blank; you have *scope*, not the feature-by-feature hour breakdown yet.
2. **Assemble the project brief.** Pull from the Knowledge Base, HubSpot deal, and sales Drive. Prefer *linking* to the source docs over copying them.
3. **Run the first reconciliation.** Open the Scope tab and review, per product, where the team's plan and the client's stated scope disagree. Resolve or consciously accept each **unplanned / team-added / reinterpreted** gap. On M3, for example, Raivan's DSO/multi-location item is *unplanned* (deferred), and Leo Power + social bill-splitting are *team-added*.
4. **Confirm provisioning.** ProjectX project, GitHub repos, Slack channels, staffing at kickoff.
5. **Pass Tollgate 1 (the Phase 0 gate).** This is the delivery-side feasibility thumbs-up. Use **Mark gate passed** on the gate panel; it records who signed off and when, into the audit/changelog.

**Definition of done for Phase 0:** brief written, scope reconciled (no *unresolved* surprises), provisioned, T1 signed. Remember the gate is **advisory** — if something's open, you can still advance, but do it as a conscious call.

---

## 3. Phase 1 — Structured Discovery (design) · *shape the scope and lock the baseline*

**Goal:** turn Draft features into a **Locked baseline the client signs** (Tollgate 2). Discovery is where the scope gains fidelity.

**How milestones relate to features here:** in discovery, milestones are **broad exercises that shape *many* features** (a many-to-many relationship). A discovery milestone doesn't deliver one feature — it refines several: adding detail, splitting them, re-estimating, and raising or lowering confidence. In the phase's **Scope & Features** tab you'll see each milestone's "shaped by" links.

**What to do in the Scope section:**

1. **Work the features up the confidence curve.** Open each feature drawer and drive down its **open unknowns**. Low-confidence features are **flagged** (an advisory "not ready to lock" warning) — that's your worklist, not a blocker.
2. **Re-reconcile as understanding changes.** New client needs surface as *unplanned*; team ideas surface as *team-added*. Resolve them here, while it's cheap — before code exists.
3. **Set the estimate and lock the baseline (Tollgate 2).** When a feature is ready, use **Lock baseline** in the drawer: set its point-hours, record the client sign-off, and freeze it. A locked feature can't change except through a change order. Low confidence *warns* but never prevents locking — locking is a deliberate PM/PD decision.
4. **Advance to build.** A build phase's entry gate reads "Locked BET baseline + client sign-off." Ideally features are Locked before development starts; if some aren't, advancing is a conscious, recorded call.

**Definition of done for Discovery:** the features that development will build are **Locked**, with a recorded client sign-off — that frozen set is the "Original" baseline everything downstream measures against.

---

## 4. Build phases (Platform Fabric / VetLeo MVP / Raivan MVP) · *watch work burn against the baseline*

**Goal:** keep delivery matching the signed baseline, and catch drift the moment it appears.

**How milestones relate to features here:** in build phases the relationship tightens to **1:1** — a milestone delivers a feature, and the work mapped to it (GitHub epics, ProjectX hours) rolls up to that feature's actuals. The Scope & Features tab shows this mapping.

**What to do in the Scope section:**

1. **Pull delivery signals.** On the Scope tab, **Pull GitHub + ProjectX signals** maps GitHub epics to features and attributes ProjectX hours (via the ticket-number convention: *ProjectX entry → ticket # → GitHub issue → feature*). Each feature's **actual hours** populate and it moves to **Live**.
   > *Today this ships with mock data* — M3 development hasn't started. It becomes live once a build repo is connected and the two mapping spikes pass. The workflow you use is the same either way.
2. **Watch per-feature drift.** For features with a locked baseline, the panel shows **actual vs. baseline hours**. Over-baseline features are your early warning.
3. **Triage unmapped work as new scope.** Any GitHub epic that maps to *no* feature is surfaced as a candidate for **new scope** — never silently absorbed. Use **Raise as new scope** to turn it into a change order.
4. **Run the tradeoff (change orders).** A change order moves **pending → scope-and-pay / swap / reject**. How you route it depends on the contract type:
   - **Fixed-bid:** *any* new scope re-opens the conversation with the client.
   - **Project-based** (M3): alert when effort **trends past the contracted range**; smaller reprioritizations inside the range don't need a change order.
   - **Scope-and-pay** amends the baseline (more budget); **swap** trades the new item for a like-sized one already in scope; **reject** declines it.

**Definition of done, ongoing:** every hour of real work maps to a feature, drift is visible per feature, and no unmapped work is silently tracked — so the scope conversation happens on your terms.

---

## 5. Quick reference

**Feature lifecycle:** `Draft` (feasibility range, estimates blank) → `Locked` (Tollgate 2, client-signed baseline, point-hours frozen) → `Live` (accruing actuals from delivery).

**Tollgates:** **T1** = feasibility sign-off (delivery-owned, in Phase 0). **T2** = baseline lock (client sign-off, freezes the "Original" baseline, audited).

**Gates are advisory** — everywhere. They tell you whether you're ready; they never stop you. Advancing with an open gate is a legitimate, recorded decision.

**Where things live in the app:**
- **Scope tab** (top nav) — program-wide reconciliation, delivery signals, change orders. Filter with the product lens.
- **A phase → Scope & Features tab** — that phase's gate, its features, and its reconciliation.
- **Feature drawer** (click any feature) — full BET detail, open unknowns, contract-scope coverage, design assets, and the baseline-lock action.

**Roles:** the Leadership view can pass gates, lock baselines, and resolve change orders. The Team view sees the same scope picture read-only. Everything one person changes is recorded in the change log / audit trail.
