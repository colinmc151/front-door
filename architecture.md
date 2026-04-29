# Front Door — Technical Architecture

## Overview

The Front Door is a middleware orchestrator that sits between a chat interface (where the hiring manager talks) and two destination systems (Worksome and Beeline). Claude acts as the decision engine — it conducts the intake conversation and produces a structured routing decision. The middleware handles everything else: authentication, config loading, prompt assembly, API dispatch, approvals, taxonomy mapping, and audit logging.

---

## Components

### 1. Chat Interface (Frontend)

The hiring manager's entry point. This can be deployed as any of:

- **Web app** — Custom-branded React/Next.js chat UI embedded in the client's portal.
- **Slack bot** — Conversational intake via Slack DM or channel command. **Primary channel for most clients.**
- **Teams bot** — Same pattern for Microsoft Teams environments.
- **Email** — For async intake (lower priority, requires polling or webhook parsing).

The frontend is stateless — it sends messages to the middleware via WebSocket (for real-time) or REST (for async), and displays responses. All routing logic lives server-side.

**Tech:** React + Next.js (web), Bolt SDK (Slack), Bot Framework (Teams).

---

#### Slack Integration (Detailed)

Slack is the recommended primary channel. Hiring managers are already there, so the Front Door meets them where they work with zero context-switching.

##### Entry Points

Three ways a manager can start an intake in Slack:

1. **DM the bot** — Message `@Worksome Hiring Hub` directly. The bot replies in a DM thread with Q1.
2. **Slash command** — Type `/hire` in any channel. This opens a DM thread with the bot (keeps the conversation private).
3. **Channel shortcut** — A "New hire request" shortcut pinned to a #hiring channel. Clicking it starts a DM thread with the bot.

##### Conversation in Slack

The intake conversation maps to Slack Block Kit components:

| Intake Element | Slack Block Kit Component |
|---|---|
| Question text | `section` block with `mrkdwn` text |
| Option buttons (Q1, Q1b, Q1c, Q3–Q7) | `actions` block with `button` elements |
| Free text input (Q2 — describe the role) | Manager types a normal message in the thread |
| Routing result card | `section` block with `mrkdwn` + coloured sidebar via `attachment` |
| Deep link to Worksome/VMS | `button` element with `url` (external link) |
| Knockout signals | Detected in the free-text response, no UI change |

##### Conversation Flow in Slack

```
Manager DMs @Worksome Hiring Hub (or types /hire)
  │
  ├─ Bot: "Do you already know who you'd like to work with?"
  │        [Yes, I have someone in mind]  [No, I need to find someone]
  │
  ├─ Manager clicks a button → bot receives action payload
  │
  ├─ Bot: next question with buttons (or free text prompt)
  │        ... 2-7 messages in the thread ...
  │
  ├─ Bot: Routing result card with attachment
  │        "Perfect — I've got everything I need."
  │        ┌──────────────────────────────────────┐
  │        │ ROUTED → WORKSOME                     │
  │        │ Known worker — Project engagement      │
  │        │ [Continue in Worksome →]               │
  │        └──────────────────────────────────────┘
  │
  └─ (Optional) Bot posts a summary to #hiring channel
     for visibility / audit
```

##### Technical Implementation

**Framework:** Slack Bolt SDK (Node.js or Python) — handles events, actions, and slash commands.

**Event flow:**
1. Slack sends an event (message or action) to the middleware's `/slack/events` endpoint.
2. Middleware identifies the user → loads client config → retrieves session state.
3. Middleware sends the conversation to Claude with the assembled system prompt.
4. Claude returns the next question or the routing decision.
5. Middleware formats the response as Block Kit JSON and posts it back to the Slack thread.

**Interactivity:**
- Button clicks arrive as `block_actions` payloads with the action ID (e.g., `q1_yes`, `q1b_project`).
- The middleware updates the original message to grey out the buttons (showing which was selected) and posts the next question.
- Free-text responses (Q2) arrive as `message` events in the DM thread.

**Channel posting (optional):**
- After routing, the bot can post a summary to a shared channel (e.g., #hiring or #talent-requests) for visibility.
- This gives procurement/talent teams a real-time feed of all incoming requests and their routing decisions.

**Auth:**
- Slack users are mapped to client accounts via their Slack workspace ID.
- The bot is installed per-workspace (one workspace = one client config).
- Bot token stored securely per client in the Config DB.

##### Block Kit Example: Q1

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "Hi! I'm here to help you find the right talent. Let's get started.\n\nDo you already know who you'd like to work with?"
      }
    },
    {
      "type": "actions",
      "block_id": "q1_actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Yes, I have someone in mind" },
          "action_id": "q1_yes",
          "style": "primary"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "No, I need to find someone" },
          "action_id": "q1_no"
        }
      ]
    }
  ]
}
```

##### Block Kit Example: Routing Result

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "Perfect — I've got everything I need. You're all set to get started."
      }
    }
  ],
  "attachments": [
    {
      "color": "#1a6b50",
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*ROUTED → WORKSOME*\n*Known worker — Project engagement*\nSelect your worker, create the job, complete the compliance check, and generate the contract."
          }
        },
        {
          "type": "actions",
          "elements": [
            {
              "type": "button",
              "text": { "type": "plain_text", "text": "Continue in Worksome →" },
              "url": "https://sandbox.worksome.com/login",
              "style": "primary"
            }
          ]
        }
      ]
    }
  ]
}
```

---

### 2. Middleware Orchestrator (Backend)

The core backend service. Responsible for:

#### Session Manager
- Authenticates the hiring manager (SSO / OAuth2 via client's IdP).
- Creates and maintains conversation sessions.
- Stores conversation history for the current session.
- Identifies the client from the authenticated user → loads the right config.

#### Config Loader
- Reads the client config (JSON) from the Client Config DB.
- Merges client rules with the base routing engine.
- Injects client-specific questions, knockouts, weights, gates, geo rules, routes, and branding into the prompt template.

#### Prompt Builder
- Takes the base system prompt template.
- Applies the client config via template rendering (Handlebars / Mustache).
- Appends conversation history.
- Sends the assembled prompt + messages to the Claude API.

#### Route Dispatcher
- Parses the structured JSON from Claude's response.
- Validates the routing decision against the config (sanity check).
- Checks for approval gates — if triggered, pauses and notifies the approver.
- If clear, dispatches to the appropriate API client.

#### Taxonomy Mapper
- Maps free-text role titles and skills to platform-specific taxonomies.
- For MVP: Claude handles this in-prompt with taxonomy context provided.
- For production: lookup table per client, stored in the Config DB.

#### Approval Engine
- Evaluates approval gates from the client config.
- If a gate is triggered (e.g., spend > $100k), pauses the dispatch.
- Sends a notification to the approver (email, Slack, or in-app).
- Resumes dispatch once approved.

#### Audit Log
- Logs every intake session: questions asked, answers given, routing decision, confidence, signals, and final API call.
- Stored in the Audit Store for compliance and analytics.
- Enables reporting: "Where are our talent requests going? What's the split?"

#### Retry / Error Handler
- If an API call to Worksome or Beeline fails, retries with exponential backoff.
- After max retries, flags the session as "failed" and notifies the admin.
- Stores the payload for manual retry.

**Tech:** Node.js (Express or Fastify) or Python (FastAPI). Stateless — session state lives in Redis or the Session Store DB.

---

### 3. Claude API (Decision Engine)

Claude receives the assembled system prompt (base + client config) and the conversation history. It:

1. Asks the next question in the flow.
2. Processes the manager's answer.
3. Applies routing logic (knockouts, scoring, tiebreakers).
4. When the route is determined, outputs the structured JSON.

The middleware calls the Claude Messages API with:
- `system`: The assembled system prompt.
- `messages`: The conversation history.
- `max_tokens`: Capped to keep responses concise.

Claude's JSON output is extracted from the response and parsed by the Route Dispatcher.

**Auth:** Anthropic API key, stored as environment secret.

---

### 4. Worksome API Client

Handles all communication with Worksome's GraphQL API.

- **Auth:** Bearer token (API key). Stored per-client in encrypted config.
- **Endpoint:** `https://api.worksome.com/graphql`
- **Integration options:** GraphQL API (direct), MCP Server (11 tools for AI agents), CLI with `--output json` (197+ operations).

#### AI Agent Integration

Worksome provides three purpose-built integration paths for AI agents:

1. **MCP Server** — Implements the Model Context Protocol with 11 structured tools for querying hires, contracts, invoices, workers, compliance, and performing actions like creating draft hires and approving payments. Best fit for the Front Door since it's already an AI agent architecture.

2. **CLI with JSON output** — Full API coverage (197+ operations) with `--output json` flag. Useful for automation pipelines or when the middleware needs to execute operations not covered by the MCP Server.

3. **`llms-full.txt` context loading** — Complete API documentation (6,000+ lines) loadable directly into Claude's context window. Can be used to make the decision engine aware of Worksome's full capabilities for taxonomy mapping and workflow understanding. URL: `https://docs.worksome.com/llms-full.txt`

#### Key Mutations

| Mutation | Purpose | When Used |
|---|---|---|
| `createTrustedContact` | Invite a new worker into the client's talent pool | Known worker not yet in the pool |
| `createJob` | Create a job in DRAFT status (title, skills, owner) | All Worksome routes |
| `updateJob` | Set full details (description, rates, dates, location) and publish | After createJob |
| `createDraftHire` | Create a draft hire linking a trusted contact to a job | Known worker fast track |
| `createJobCandidate` | Make workers eligible/proposed for a job | Talent search — matching candidates |
| `acceptBid` | Hire a worker by accepting their bid on a job | After talent search selection |
| `createMilestones` | Create milestones for a fixed-price engagement | Milestone-based projects |
| `createProject` | Create a project to group related jobs | Multi-job engagements |

#### Known Worker Flow (Fast Track)

```
Front Door Intake → Routing Decision → Hand Off to Worksome

1. Front Door captures intake data (role, duration, payment model, SDC check)
2. Routing decision: → Worksome (known worker)
3. → Deep link to Worksome
4. Manager completes the full workflow inside Worksome:
   └─ Select worker from talent pool — or invite by email if not there yet
   └─ Create the job with role details
   └─ Answer compliance / classification questions
   └─ Generate the contract
5. Webhook: contract-accepted
   └─ Front Door logs completion in audit store
```

**Important:** The Front Door does NOT create jobs, hires, or trusted contacts via API for the known worker path. The entire worker selection, job creation, compliance, and contract workflow happens inside Worksome's UI. This is by design — Worksome's classification engine, indemnification, and compliance checks live in the UI workflow and should not be bypassed. The Front Door's job is to route the manager there quickly with the right context.

#### Talent Search Flow (Discovery)

```
Front Door Intake → Routing Decision → Hand Off to Worksome

1. Front Door captures intake data (role, skills, duration, headcount, payment model)
2. Routing decision: → Worksome (talent search)
3. → Deep link to Worksome
4. Manager completes the workflow inside Worksome:
   └─ Create the job with role details
   └─ Publish to marketplace or invite specific candidates
   └─ Review and shortlist candidates as they come in
   └─ Select worker → compliance → contract
5. Webhook: contract-accepted
```

#### Future: API-Assisted Flows

As the integration matures, the Front Door could optionally use Worksome's API (or MCP Server) to pre-create jobs or trusted contacts, reducing manual steps for the manager. The relevant mutations for this are:

| Mutation | Purpose |
|---|---|
| `createJob` + `updateJob` | Pre-create and publish a job from intake data |
| `createTrustedContact` | Pre-invite a known worker into the talent pool |
| `createDraftHire` | Create a draft hire (must be completed in UI for compliance) |
| `createJobCandidate` | Propose candidates for a published job |
| `acceptBid` | Hire a worker who has bid on a job |
| `createMilestones` | Set up milestones for fixed-price engagements |

This would be a Phase 2 enhancement — the MVP hands off to Worksome and lets the manager drive.

#### Webhooks for Lifecycle Tracking

The Front Door should register webhooks to track the full lifecycle after handoff:

| Webhook Event | Use |
|---|---|
| `contract-accepted` | Contract signed — engagement is live. Update audit log. |
| `hire-updated` | Hire details changed. Sync status. |
| `hire-cancelled` | Hire was cancelled before starting. Flag in audit. |
| `hire-ended` | Engagement completed normally. |
| `hire-terminated` | Engagement terminated early. |
| `trusted-contact-updated` | Worker profile updated. |

---

### 5. Beeline API Client

Handles all communication with Beeline's REST API.

- **Auth:** OAuth2 client credentials flow. Token refresh handled automatically.
  - Client ID + Client Secret stored per-client in encrypted config.
  - Token endpoint: `POST /oauth/token`
  - Access tokens cached with TTL.
- **Endpoint:** `https://api.beeline.com/v2/requisitions`
- **Primary method:** `POST /requisitions`
- **Flow:**
  1. Receive the mapped payload from Route Dispatcher.
  2. Exchange credentials for access token (if expired).
  3. Execute the POST request.
  4. Return the created requisition ID and dashboard URL.
  5. Middleware sends the manager a confirmation with a link to the requisition.

---

### 6. Data Stores

#### Client Config DB
- Stores per-client configuration: routing rules, custom questions, knockouts, weights, approval gates, geo rules, taxonomy maps, branding, API credentials (encrypted).
- **Tech:** PostgreSQL or a managed JSON document store (e.g., DynamoDB, Firestore).
- One record per client, versioned for audit trail.

#### Session Store
- Stores active conversation sessions: session ID, client ID, user ID, conversation history, current state, routing decision.
- **Tech:** Redis (for active sessions) + PostgreSQL (for completed sessions).
- TTL on active sessions (e.g., 24 hours).

#### Audit Store
- Immutable log of every routing decision: session ID, client ID, questions/answers, signals, scores, route, confidence, API response, timestamp.
- **Tech:** PostgreSQL with append-only table, or a dedicated audit service.
- Feeds into analytics dashboards.

---

## Authentication Flows

### Hiring Manager → Frontend
- SSO via client's identity provider (Okta, Azure AD, Google Workspace).
- The frontend receives a JWT; the middleware validates it and extracts the client ID + user identity.

### Middleware → Worksome
- Bearer token authentication.
- API key stored per-client in the Config DB (encrypted at rest).
- Passed in the `Authorization: Bearer <token>` header on every GraphQL request.

### Middleware → Beeline
- OAuth2 Client Credentials flow.
- Client ID + Client Secret stored per-client in the Config DB (encrypted at rest).
- Token refresh handled by the Beeline API client module.
- Access token cached in memory with TTL matching the token's `expires_in`.

### Middleware → Claude API
- Anthropic API key.
- Single key for the platform (not per-client).
- Stored as an environment secret, never in the DB.

---

## Sequence: End-to-End Flow

```
Manager          Frontend         Middleware        Claude API       Worksome/Beeline
  |                 |                 |                 |                 |
  |-- "I need..." ->|                 |                 |                 |
  |                 |-- POST msg ---->|                 |                 |
  |                 |                 |-- load config -->|                |
  |                 |                 |-- build prompt ->|                |
  |                 |                 |-- send msgs ---->|                |
  |                 |                 |<-- next question-|                |
  |                 |<-- response ----|                 |                 |
  |<-- question ----|                 |                 |                 |
  |                 |                 |                 |                 |
  |   ... conversation continues (2-7 rounds) ...      |                 |
  |                 |                 |                 |                 |
  |                 |                 |<-- JSON output --|                |
  |                 |                 |                 |                 |
  |                 |                 |-- check gates -->|                |
  |                 |                 |-- map taxonomy ->|                |
  |                 |                 |-- dispatch ----->|                |
  |                 |                 |<-- job/req ID ---|                |
  |                 |                 |-- log audit ---->|                |
  |                 |<-- "All set!" --|                 |                 |
  |<-- link to job -|                 |                 |                 |
```

---

## Deployment

### Recommended Stack
- **Runtime:** Node.js 20+ or Python 3.11+
- **Framework:** Fastify (Node) or FastAPI (Python)
- **Database:** PostgreSQL (config, sessions, audit) + Redis (active sessions, token cache)
- **Hosting:** AWS (ECS/Fargate), GCP (Cloud Run), or Azure (Container Apps)
- **Secrets:** AWS Secrets Manager / GCP Secret Manager / Azure Key Vault
- **Monitoring:** Datadog, New Relic, or CloudWatch
- **CI/CD:** GitHub Actions → container registry → deploy

### Environment Variables
```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgres://...
REDIS_URL=redis://...
ENCRYPTION_KEY=...  (for client API credentials at rest)
LOG_LEVEL=info
```

### Scaling
- The middleware is stateless (session state in Redis), so it scales horizontally.
- Claude API calls are the bottleneck — consider request queuing for high-volume clients.
- Worksome and Beeline API rate limits should be respected — the Retry/Error Handler manages this.

---

## Security Considerations

- All client API credentials encrypted at rest (AES-256) and in transit (TLS 1.3).
- Conversation data may contain PII — encrypt the Session Store and Audit Store.
- RBAC on the Config DB: only admins can modify client configs.
- Audit log is immutable — no deletes, only appends.
- Regular rotation of API keys and OAuth secrets.
- SOC 2 / GDPR compliance: data retention policies per client, right-to-erasure support.
