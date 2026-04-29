# Front Door — Output Schemas

## 1. Routing Decision (Claude Output)

This is the JSON that Claude produces at the end of every intake conversation. The middleware consumes it to decide which API to call.

```json
{
  "route": "worksome",
  "confidence": "high",
  "approval_required": null,
  "intake_summary": {
    "role_title": "Brand Designer",
    "description": "Redesign of the company brand identity including logo, colour palette, typography, and brand guidelines document.",
    "skills": ["Brand Design", "Visual Identity", "Adobe Creative Suite", "Typography"],
    "deliverables_or_ongoing": "deliverable",
    "duration": "3 weeks",
    "headcount": 1,
    "payment_model": "milestone",
    "sdc_present": false,
    "location": "Remote",
    "known_worker": true,
    "replacement": false
  },
  "routing_signals": {
    "knockout_triggered": null,
    "score_worksome": 7,
    "score_beeline": 0,
    "decisive_signal": "known_worker + project-based deliverable"
  },
  "client_fields": {}
}
```

---

## 2. Worksome API Payload

When the route is `worksome`, the middleware transforms the routing decision into a `createJobPost` GraphQL mutation payload.

### GraphQL Mutation

The Worksome route is a multi-step API sequence, not a single call. The middleware orchestrates these mutations in order.

### Step 1: Create the Job

```graphql
mutation CreateJob($input: CreateJobInput!) {
  createJob(input: $input) {
    id
    title
    status
  }
}
```

```json
{
  "input": {
    "title": "{{intake_summary.role_title}}",
    "skills": ["{{intake_summary.skills — mapped to Worksome skill IDs}}"],
    "owner": "{{session_user_id}}"
  }
}
```

`createJob` creates the job in DRAFT status with minimal fields. Then `updateJob` sets the full details and publishes.

### Step 2: Update & Publish the Job

```graphql
mutation UpdateJob($input: UpdateJobInput!) {
  updateJob(input: $input) {
    id
    title
    status
    url
  }
}
```

```json
{
  "input": {
    "id": "{{job_id from Step 1}}",
    "description": "{{intake_summary.description}}",
    "startDate": "{{calculated or null}}",
    "endDate": "{{calculated from duration or null}}",
    "location": {
      "type": "{{REMOTE | ONSITE | HYBRID}}",
      "city": "{{if provided}}",
      "country": "{{if provided}}"
    },
    "budget": {
      "type": "{{FIXED | HOURLY | DAILY}}",
      "amount": null,
      "currency": "{{client_default_currency}}"
    },
    "visibility": "PRIVATE",
    "status": "PUBLISHED"
  }
}
```

### Step 3a: Known Worker — Invite & Draft Hire

If the worker is not already a trusted contact:

```graphql
mutation CreateTrustedContact($input: CreateTrustedContactInput!) {
  createTrustedContact(input: $input) {
    id
    status
  }
}
```

Then create the draft hire:

```graphql
mutation CreateDraftHire($input: HireInput!) {
  createDraftHire(input: $input) {
    id
    status
    latestContract {
      id
      status
    }
  }
}
```

**Important:** `createDraftHire` places the hire in DRAFT status. The Worksome docs state: *"Draft hires must be completed in the Worksome UI before they become active, such as applicable compliance checks."* The manager must finish compliance and contract generation inside Worksome.

### Step 3b: Talent Search — Publish & Match

For talent search, the job is published to the marketplace (Step 2 with `status: PUBLISHED`). Candidates bid on the job, or the middleware can propose candidates:

```graphql
mutation CreateJobCandidate($input: CreateJobCandidateInput!) {
  createJobCandidate(input: $input) {
    id
    status
  }
}
```

When the manager selects a worker, use `acceptBid` to create the hire:

```graphql
mutation AcceptBid($input: AcceptBidInput!) {
  acceptBid(input: $input) {
    id
    status
    latestContract {
      id
      status
    }
  }
}
```

### Step 4: Milestones (if applicable)

For milestone/deliverable-based engagements:

```graphql
mutation CreateMilestones($input: CreateMilestonesInput!) {
  createMilestones(input: $input) {
    id
    title
    amount
    dueDate
  }
}
```

### Field Mapping Rules

| Routing Decision Field | Worksome Mutation | Worksome Field | Mapping Logic |
|---|---|---|---|
| `role_title` | `createJob` | `title` | Direct map |
| `skills` | `createJob` | `skills` | Map to Worksome skill IDs (taxonomy lookup or Claude) |
| `description` | `updateJob` | `description` | Direct map |
| `payment_model: milestone` | `updateJob` | `budget.type: FIXED` | Milestone/fixed bid → Fixed |
| `payment_model: hourly` | `updateJob` | `budget.type: HOURLY` | Hourly → Hourly rate |
| `duration` | `updateJob` | `startDate` / `endDate` | Calculate dates from duration string |
| `location` | `updateJob` | `location` | Parse into structured location object |
| `known_worker: true` | `createDraftHire` | — | Triggers the known worker flow |
| `known_worker: false` | — | `status: PUBLISHED` | Job goes to marketplace |

### Webhook Listeners

Register these webhooks to track lifecycle after handoff:

| Event | Action |
|---|---|
| `contract-accepted` | Log engagement start in audit store. Notify manager. |
| `hire-updated` | Sync hire status changes. |
| `hire-cancelled` | Flag in audit store. Alert if unexpected. |
| `hire-ended` | Log normal completion. |
| `hire-terminated` | Log early termination. Alert compliance team. |

### Integration Approach: MCP Server vs. Direct GraphQL

For the Front Door MVP, we recommend using **Worksome's MCP Server** as the primary integration method. It provides 11 structured tools purpose-built for AI agents — covering hires, contracts, invoices, workers, and compliance. This means the middleware can operate as an MCP client, calling Worksome tools directly rather than constructing raw GraphQL mutations.

For operations not covered by the MCP Server's 11 tools, fall back to the **CLI with `--output json`** (197+ operations) or **direct GraphQL**.

Additionally, loading **`llms-full.txt`** into the Claude decision engine's context gives it awareness of the full Worksome API — useful for intelligent taxonomy mapping and understanding edge cases in the workflow.

---

## 3. Beeline API Payload

When the route is `beeline`, the middleware transforms the routing decision into a `Create Requisition` REST API call.

### REST Endpoint

```
POST /api/v2/requisitions
Authorization: Bearer {{oauth2_access_token}}
Content-Type: application/json
```

### Mapped Payload

```json
{
  "requisition": {
    "title": "{{intake_summary.role_title}}",
    "description": "{{intake_summary.description}}",
    "jobCategory": "{{mapped from skills/role_title to Beeline taxonomy}}",
    "requisitionType": "{{STAFF_AUG | TEMP | SOW}}",
    "numberOfPositions": "{{intake_summary.headcount}}",
    "startDate": "{{calculated or null}}",
    "endDate": "{{calculated from duration or null}}",
    "estimatedDuration": "{{intake_summary.duration}}",
    "rateType": "{{HOURLY | DAILY}}",
    "maxBillRate": null,
    "currency": "{{client_default_currency}}",
    "location": {
      "site": "{{if provided}}",
      "city": "{{if provided}}",
      "state": "{{if provided}}",
      "country": "{{if provided}}",
      "remoteAllowed": true
    },
    "hiringManager": {
      "name": "{{from session context}}",
      "email": "{{from session context}}",
      "department": "{{from client_fields or null}}"
    },
    "costCenter": "{{from client_fields or null}}",
    "approvalStatus": "{{if approval_required: PENDING_APPROVAL, else: APPROVED}}",
    "metadata": {
      "source": "front-door",
      "routing_confidence": "{{confidence}}",
      "client_id": "{{client_id}}",
      "intake_session_id": "{{session_id}}"
    }
  }
}
```

### Field Mapping Rules

| Routing Decision Field | Beeline API Field | Mapping Logic |
|---|---|---|
| `role_title` | `title` | Direct map |
| `description` | `description` | Direct map |
| `skills` + `role_title` | `jobCategory` | Map to Beeline job category taxonomy |
| `deliverables_or_ongoing` | `requisitionType` | ongoing → STAFF_AUG, deliverable → SOW |
| `headcount` | `numberOfPositions` | Direct map |
| `payment_model` | `rateType` | hourly → HOURLY, daily → DAILY |
| `duration` | `estimatedDuration` | Direct map as string |
| `location` | `location` | Parse into structured location object |
| `approval_required` | `approvalStatus` | If gate triggered → PENDING_APPROVAL |

---

## 4. Taxonomy Mapping

The middleware needs to translate free-text role titles and skills into the taxonomies used by each platform. Two approaches:

### Option A: Claude-Powered Mapping (Recommended for MVP)
Include a mapping instruction in the system prompt:
> "When generating the output, map the role title to the closest match in the target platform's taxonomy. For Worksome, use their skills list. For Beeline, use their job category codes."

Provide the taxonomy lists as context or via API lookup.

### Option B: Lookup Table (Recommended for Production)
Maintain a mapping table per client:

```json
{
  "taxonomy_maps": {
    "worksome_skills": {
      "Brand Designer": ["Brand Design", "Visual Identity", "Graphic Design"],
      "Java Developer": ["Java", "Spring Boot", "Backend Development"]
    },
    "beeline_categories": {
      "Brand Designer": "MKT-004-DESIGN",
      "Java Developer": "IT-001-SOFTWARE-DEV"
    }
  }
}
```

---

## 5. Client Custom Fields

Clients can define additional fields that get captured during intake and passed through in the `client_fields` object. These are configured per client:

```json
{
  "client_custom_fields": [
    {
      "key": "cost_center",
      "label": "Cost Centre",
      "type": "string",
      "required": true,
      "source": "question | session_context | lookup"
    },
    {
      "key": "department",
      "label": "Department",
      "type": "enum",
      "options": ["Engineering", "Marketing", "Finance", "Operations"],
      "required": true,
      "source": "question"
    },
    {
      "key": "project_code",
      "label": "Project Code",
      "type": "string",
      "required": false,
      "source": "question"
    }
  ]
}
```

These fields appear in the JSON output under `client_fields` and are forwarded to whichever API the request is routed to.
