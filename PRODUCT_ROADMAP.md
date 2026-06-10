# Front Door — Gap Analysis & Product Roadmap

The honest framing: you have a strong vision document (architecture.md), a credible demo, and a gap between them. The roadmap below is ordered by leverage — what makes the product *true*, then what makes it *sticky*, then what makes it *sellable*.

---

## Phase 1 — Make the demo true (1–2 weeks of work)

These are places where the UI promises something the backend doesn't do. Demos survive scrutiny when every visible feature is real.

### 1.1 Config that actually configures ✅ DONE
The Settings page edits `sessionStorage` only — knockouts, weights, and branding never reach the server, while `promptConfig` in server.js is hardcoded. The core pitch is "configurable routing per client," and right now it isn't.
**Do:** persist config server-side (a JSON file or SQLite is fine to start), add `GET/PUT /api/config`, and build the system prompt from stored config on every chat call. The Settings page becomes a real admin surface and the demo moment — "watch me change a knockout word and re-route the same request" — becomes possible.

### 1.2 Real analytics from a real audit log ✅ DONE
The Analytics page and left-panel activity feed are hardcoded mock data, and architecture.md promises an immutable audit store — it's also your compliance story ("where are our requests going?").
**Do:** log every completed intake (timestamp, route, confidence, role, duration, signals, anonymized manager) to SQLite append-only. Drive the Analytics page and "Recent requests" from it. Suddenly every demo you run *generates* the dashboard.

### 1.3 Validate the model's routing JSON ✅ DONE
`JSON.parse` on Gemini's output is trusted blindly, and `maxOutputTokens: 800` can truncate the JSON mid-output — the route is silently lost and the user is stuck.
**Do:** validate with a schema (zod), retry once on parse failure with a "re-emit only the JSON" message, and raise the token cap. This is the single most common real-world failure mode of LLM-driven flows.

### 1.4 Streaming responses ✅ DONE
Gemini supports streaming; the chat currently waits for complete responses. Streaming makes the intake feel twice as fast at zero model cost — the highest perceived-quality-per-hour change available.

### 1.5 Persistence
Sessions, shortlists, and (after 1.1–1.2) config and audit currently live in process memory — a restart loses everything and you can't run two instances. SQLite solves all of it single-tenant; swap to Postgres + Redis when you go multi-instance (your architecture doc already specifies this).

---

## Phase 2 — Close the loop with the Worksome API (the differentiator)

Today Front Door routes and forgets. The Worksome platform exposes exactly the tools to follow the engagement to completion — this is where the product stops being an intake form and becomes an orchestrator.

### 2.1 Webhooks ✅ DONE (endpoint + Slack notify; register the URL + secret with Worksome to activate)
Worksome's webhooks are real and documented: signed payloads (`Signature` header + shared secret), exponential retry, and a `contractAccepted` event carrying the contract, a **stable `hireId`** (survives contract revisions — use it as your primary reference), `hireStatus` (`draft → offered → signed → active → ended/cancelled/terminated`), worker identity, and custom field values.
**Do:** add a `POST /api/webhooks/worksome` endpoint that verifies the signature, stores events keyed by `hireId`, and links them back to the originating intake session via the job ID.
**What it unlocks:**
- **Slack notification on signature** — "✅ Your contract with Maria was signed, starts Monday." The manager who used `/hire` gets closure in the same channel. This is the single best demo moment available to you.
- **A real funnel** — request → routed → job created → contract signed, with cycle times. That's the "<60s to route, 7 weeks industry baseline" claim on why.html backed by your own data.
- **Lifecycle flags** — `hire-terminated`/`cancelled` alerts for the compliance team, per your own architecture doc.

### 2.2 Worker identity stitching with `externalIdentifier` ✅ DONE (sent as `frontdoor:<intakeId>` on trusted-contact creation)
The webhook payload includes an optional `externalIdentifier` for workers. Set it to your Front Door lead/session ID when creating trusted contacts, and you can trace a GitHub-discovered candidate → invited → contracted, end to end. That's the GitHub Discovery ROI story, measurable.

### 2.3 Use the mutations you've already documented but don't call — ✅ `createTrustedContact` + `createDraftHire` built (opt-in via `FAST_TRACK_INVITE=1` / `FAST_TRACK_DRAFT_HIRE=1`; verify field shapes with `node scripts/introspect-worksome.js` before enabling). `createJobCandidate`/`createMilestones`/`createProject` still open pending schema confirmation.
Your output-schemas.md maps these out; the code only uses `createJob`/`updateJob`/`shareHire`. Respecting your (correct) design rule that compliance stays in the Worksome UI, these remove manual steps without bypassing anything:

| Mutation | Where it plugs in |
|---|---|
| `createTrustedContact` | Path A2 (new worker): you collect first name, last name, email — then just link to `/contacts`. Actually pre-invite them; the manager lands with the worker already in their pool. |
| `createDraftHire` | Known-worker fast track: pre-create the draft hire so the manager lands one click from compliance, instead of re-finding the worker. |
| `createJobCandidate` | When the manager picks talent-pool matches, propose them on the job formally rather than only `shareHire`. |
| `createMilestones` | When `payment_model: milestone`, pre-create milestone scaffolding from the intake (duration → due dates). |
| `createProject` | Multi-headcount requests: group the jobs. |

### 2.4 Approval gates that fire ✅ DONE (held handoff + approve button on web, hold notice on Slack, approver ping via SLACK_NOTIFY_CHANNEL; full approver RBAC still open)
The config UI lets you define gates (`spend > 100000 → procurement_review`); nothing evaluates them. Wire a simple evaluator into the dispatch path: gate triggered → hold the handoff, Slack-DM the approver with approve/reject buttons, resume on approve. Procurement buyers ask for exactly this, and it's a small build on top of the Slack bot you already have.

### 2.5 Taxonomy mapping hardening
`resolveSkillIds` takes the first fuzzy match and silently drops misses — bad matches quietly degrade talent search. Cache resolutions, log unmatched skills (they're your mapping-table backlog), and add the per-client lookup table from output-schemas.md Option B.

---

## Phase 3 — Make it sellable (before client #2)

### 3.1 Multi-tenancy + real login
Everything is single-tenant via `.env`. Your architecture doc already specifies the target: per-client config records, encrypted per-client API credentials, SSO via the client's IdP. The session cookie I added is a stopgap — the portal is still public. Minimum next step: a login in front of the portal (magic-link email is a weekend's work; SSO when an enterprise client demands it). This is the prerequisite for everything per-client.

### 3.2 The Beeline half ✅ DONE (mapped requisition preview on the VMS route card via /api/beeline/preview; real POST slots in behind it)
The VMS route is currently just a link. Even before a real Beeline integration, render the *mapped requisition payload* (you've fully specified it in output-schemas.md) as a preview card — "here's the requisition we'd create." It makes the dual-channel story concrete in demos, and the real `POST /requisitions` integration slots in behind it when a client materializes.

### 3.3 Slack/web parity ✅ DONE (scored talent cards with Choose buttons, GitHub discovery cards with draft-invite, DM-only nudges; multi-select job invite remains web-only)
The web portal has GitHub Discovery, talent panels, and multi-select invite; the Slack bot has none of them. Given your own architecture doc calls Slack the *primary channel*, port the talent results (Block Kit cards with score + skills + select buttons) before adding more web-only features. Also: the bot currently replies "Type /hire" to *every* message in any channel it's in — filter to DMs/mentions.

### 3.4 Data minimization (GDPR) ✅ DONE (emails + totalPaid stripped at the API boundary; `previouslyEngaged` boolean replaces the raw amount; emails removed from LLM context in web + Slack. Still open: confirm Gemini DPA coverage for the conversation itself)
Worker emails and `totalPaid` are sent to the browser and embedded into LLM prompts (and thus to Google via Gemini). Strip `email` and `totalPaid` from client-facing payloads unless the flow needs them, keep IDs server-side, and confirm your Gemini data-processing terms cover candidate PII — or route the chat through a provider you have a DPA with. Architecture.md commits to GDPR; this is the current gap.

### 3.5 Engineering hygiene
- **Tests:** only a manual `test-github.js` exists. Priority order: routing-JSON parse/validation, auth middleware, scoring functions (pure, trivially testable). GitHub Actions on push.
- **Crash handling:** `uncaughtException` keeps a possibly-corrupt process alive; log + exit and let the host restart (you already have `/api/health` for monitoring).
- **Structured logging** (pino) with request IDs — you'll want it the first time a client asks "what happened to my request."
- ✅ **One prompt, one source:** unified into prompt.js (channel param handles Slack vs web formatting); server.js and bot-handler.js both import it. system-prompt.md is now reference-only.
- ✅ **CI:** GitHub Actions workflow runs syntax checks, the 31-test suite, and the portal build on every push/PR (`npm test` locally).

---

## Product ideas the API makes cheap (once Phase 2 lands)

- **Renewal radar** — your own education content warns about 12-month engagement drift. Query hires with approaching `endDate`, nudge the manager in Slack: "Maria's contract ends in 3 weeks — extend, convert, or end?" Recurring value = retention.
- **Spend pulse** — payment-request data per department/manager, in the analytics page. Turns Front Door from intake tool into the workforce-spend dashboard procurement opens weekly.
- **Talent pool hygiene** — surface trusted contacts with no skills/rate/recent activity; prompt enrichment. Better data → better matches → better routing, a flywheel you own.
- **Intake-to-signed leaderboard** — cycle-time per route/department from audit + webhooks. This is the slide that sells the next client.

## Suggested order
1.1 config → 1.3 JSON validation → 1.2 audit/analytics → 1.4 streaming → 2.1 webhooks + Slack notify → 2.3 fast-track mutations → 2.4 approval gates → 3.x as client #2 approaches.
