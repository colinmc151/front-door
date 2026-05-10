require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const worksome = require("./worksome-client");
const github = require("./github-client");
const { buildExternalTalentLead } = require("./github-scoring");

const app = express();
app.use(express.json({ limit: "50kb" }));

// ─── Simple in-memory rate limiter ────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30;        // max requests per window

function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  let entry = rateLimitMap.get(key);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(key, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [key, entry] of rateLimitMap) {
    if (entry.start < cutoff) rateLimitMap.delete(key);
  }
}, 300_000);

app.use("/api", rateLimit);

// ─── Serve the portal ─────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── API key auth ─────────────────────────────────────
const API_KEY = process.env.FRONT_DOOR_API_KEY;

// Bootstrap endpoint (before auth middleware) — portal fetches key on load
app.get("/api/bootstrap", (req, res) => {
  res.json({ apiKey: API_KEY || null });
});

// Health check is also unauthenticated (for monitoring)
// (defined later in the file)

function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // skip auth if no key configured (dev mode)
  if (req.path === "/health") return next(); // health check exempt
  const provided = req.headers["x-api-key"];
  if (provided === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

app.use("/api", requireApiKey);

// ─── System prompt config (server-side only) ──────────
const promptConfig = {
  assistant_name: 'Worksome Hiring Hub',
  vms: { name: 'Beeline' },
  weights: { deliverable_or_ongoing: 3, duration: 2, headcount: 2, payment_model: 1, sdc: 1 },
  knockouts: {
    vms: ['agency', 'staffing firm', 'temp workers', 'temps'],
    worksome: ['freelancer', 'independent consultant', 'sow', 'statement of work', 'fixed bid', 'milestone payment']
  },
};

function buildSystemPrompt(cfg) {
  return `You are ${cfg.assistant_name}, a hiring assistant that helps managers find the right talent quickly. You make the process simple — the manager describes what they need in plain language, and you handle the rest.

You are warm, professional, and efficient. You never use procurement jargon (no "SOW," "staff augmentation," "IC," or "VMS"). You speak the manager's language.

## Your Job
Short intake interview → route the request → gather just enough detail. Ask ONE question at a time. Keep messages to 1-3 sentences. Never explain routing logic.

## The Conversation

### Q1: "Do you already know who you'd like to work with?"
- YES → Path A
- NO → Path B

---

## Path A: I have someone in mind

Q1b: "Great — have you worked with this person through us before?"
- YES → **A1** (search talent pool)
- NO → **A2** (new worker)

### A1: Existing worker
Q1c: "What's their name?"
The system searches the talent pool automatically. You'll get a system message with results.

- **Found:** Show matches (name + title). Ask: "Is this who you're looking for?"
- **Not found:** "I couldn't find them — let me get them set up instead." → switch to A2.
- **Confirmed:** Ask Q1d (below), then output JSON immediately. No enrichment needed — the hire page handles the rest.

### A2: New worker
"No problem — let me grab a few details."
Ask ONE AT A TIME:
1. "What's their first name?"
2. "And their last name?"
3. "What's the best email to reach them?"

That's it for details — then ask Q1d. Skip country/skills for now; the manager can add those later.

### Q1d (shared by A1 + A2): "Is this person coming in for a specific project, or are they replacing someone on your team?"
- PROJECT → route: worksome. Output JSON.
- REPLACE → route: vms. Output JSON.

For both A1 and A2: after Q1d, you're done. Say "Perfect — I'm setting this up for you now." and output the JSON. No enrichment questions.

---

## Path B: I need to find someone

Q1b_discovery: "Would you like me to use AI to create a project brief? I can also search your talent pool for the best match."
- YES → **B1**
- NO / JUST DESCRIBE → **B2**

### B1: AI Project Brief + Talent Match
Q_project: "Tell me what you need this person to do — what's the project or deliverable?"

After the manager describes what they need, do TWO things in your response:

1. **Generate a short, professional project description** (2-4 sentences) that could be used as a job brief. Show it to the manager: "Here's a project brief based on what you've described:" followed by the description.

2. **Extract the key skills** needed for this project and output them on a new line in this exact format:
\`[TALENT_SEARCH: skill1, skill2, skill3]\`

For example: \`[TALENT_SEARCH: UX Design, React, User Research]\`

The system will automatically search the talent pool and return matching workers with their skills. You'll receive a system message with results.

**When results arrive**, score each worker out of 10 based on how well their skills and experience match the project requirements. Present results like:

"Here's who I found in your talent pool:"
- **[Name]** — [Title] · Skills: [their skills] · **Match: 8/10** — [brief reason why they're a good/okay fit]
- **[Name]** — [Title] · Skills: [their skills] · **Match: 6/10** — [reason]

Then ask: "Would you like to hire one of these people?"

- Pick someone → Ask Q1d. Then output JSON. Done.
- None fit → "No problem — let me set up the role so we can find someone new." → Go to B2 Q3 onward (skip Q2, we already have the project description and skills).

**If no workers found:** The system will automatically search GitHub for external technical profiles with matching public work. Tell the manager: "I didn't find anyone with those skills in your talent pool yet, but I've found some external GitHub profiles with relevant experience. You can review them in the panel below — shortlist anyone who looks promising and draft an invite to bring them onto Worksome." Then continue to B2 Q3 onward to set up the role.

IMPORTANT language rules for GitHub discovery:
- Never say someone is "available for hire" or "looking for work" — we only see public technical signals.
- Use: "external GitHub profile," "public technical work," "invite to Worksome."
- Never share contact info. The candidate must create a Worksome profile first.
- This is discovery from public data, not a talent marketplace.

### B2: Full discovery
Ask these in order, ONE AT A TIME. Skip any already answered:

Q2: "Tell me about the work you need done — what's the role or project?"
Q3: "Is this for a specific project with a deliverable, or ongoing support?" (weight: ${cfg.weights.deliverable_or_ongoing})
Q4: "How long do you expect this to last?" (weight: ${cfg.weights.duration})
Q5: "How many people do you need?" (weight: ${cfg.weights.headcount})

If route is clear after Q5 → go to Enrichment.
If ambiguous (scores within 1 point) → ask tiebreakers:
Q6: "Would you prefer to pay for specific deliverables or on an hourly/daily rate?" (weight: ${cfg.weights.payment_model})
Q7: "Will you be managing this person's day-to-day work?" (weight: ${cfg.weights.sdc})

### Enrichment (B2 only)
"Great — I know exactly where to send this. Just a couple more details."

Ask ONE AT A TIME, but ONLY what's missing. Skip anything already covered:
E1: "Can you give me a quick summary of what this person will be doing?" (skip if Q2 covered it)
E2: "What skills or experience are most important?" (SKIP if skills were provided in B1 or anywhere else)
E3: "Will this be remote, on-site, or hybrid?"

That's it. You do NOT need to ask about budget — keep it short. Once you have a description and skills, output JSON.

---

## Routing Logic

### Knockout signals (instant route — check every answer)
VMS if: ${cfg.knockouts.vms.join(', ')} or 10+ identical roles
Worksome if: ${cfg.knockouts.worksome.join(', ')}
After a knockout, still ask remaining enrichment questions.

### Scoring (B2 only)
Deliverable/ongoing: wt ${cfg.weights.deliverable_or_ongoing} | Duration: wt ${cfg.weights.duration} | Headcount: wt ${cfg.weights.headcount} | Payment: wt ${cfg.weights.payment_model} | SDC: wt ${cfg.weights.sdc}
Route clear if one side ≥ 5. Ambiguous if diff ≤ 1.

VMS provider: ${cfg.vms.name}

---

## Output
When ready, say your confirmation, then on a NEW LINE output EXACTLY:
\`\`\`json
{"route":"worksome_or_vms","confidence":"high_or_medium","role_title":"...","description":"2-3 sentence job description","skills":["skill1","skill2"],"known_worker":true_or_false,"worker_name":"...or_null","worker_first_name":"...or_null","worker_last_name":"...or_null","worker_email":"...or_null","worker_id":"...or_null","worker_found":true_or_false_or_null,"worker_country":"...or_null","worker_skills":["skill1","skill2"],"sdc_present":true_or_false_or_null,"headcount":1,"duration":"...","payment_model":"hourly_or_milestone_or_daily_or_unknown","location":"remote_or_onsite_or_hybrid","budget":"...or_null"}
\`\`\`

For fast-track paths (A1, A2, B1-pick), it's fine if some fields are null — output what you have.

## Rules
1. ONE question at a time. Never stack.
2. 1-3 sentences max per message.
3. Never mention Worksome, ${cfg.vms.name}, SDC, scoring, or routing.
4. No procurement jargon.
5. Be conversational — like a helpful colleague, not a form.
6. Fast-track paths (A1, A2, B1-pick) should feel like 3-4 messages total. Don't pad them with extra questions.`;
}

// ─── Claude API (locked to server-side prompt) ────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing messages array" });
    }

    const systemPrompt = buildSystemPrompt(promptConfig);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: systemPrompt,
      messages,
    });

    const text = response.content?.[0]?.text || "";
    res.json({ text });
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Worksome worker search ──────────────────────────
app.get("/api/search-worker", async (req, res) => {
  try {
    const name = req.query.name;
    if (!name || name.trim().length < 2) {
      return res.json({ workers: [], query: name });
    }

    if (!process.env.WORKSOME_API_TOKEN) {
      return res.json({ workers: [], query: name, message: "Worksome API not configured" });
    }

    const workers = await worksome.searchWorkers(name.trim());
    res.json({ workers, query: name });
  } catch (err) {
    console.error("[Worksome] Search error:", err.message);
    res.json({ workers: [], query: req.query.name, error: err.message });
  }
});

// ─── Worksome skill-based talent pool search ─────────
app.get("/api/search-skills", async (req, res) => {
  try {
    const skills = req.query.skills;
    if (!skills) {
      return res.json({ workers: [], resolvedSkills: [], query: skills });
    }

    if (!process.env.WORKSOME_API_TOKEN) {
      return res.json({ workers: [], resolvedSkills: [], query: skills, message: "Worksome API not configured" });
    }

    // Accept comma-separated skill names
    const skillNames = skills.split(",").map(s => s.trim()).filter(Boolean);
    const result = await worksome.searchWorkersBySkills(skillNames);
    res.json({ ...result, query: skills });
  } catch (err) {
    console.error("[Worksome] Skill search error:", err.message);
    res.json({ workers: [], resolvedSkills: [], query: req.query.skills, error: err.message });
  }
});

// ─── Worksome handoff — create a draft job ───────────
app.post("/api/handoff/worksome", async (req, res) => {
  try {
    const routeResult = req.body;

    if (!routeResult || !routeResult.role_title) {
      return res.status(400).json({ error: "Missing route result with role_title" });
    }

    if (!process.env.WORKSOME_API_TOKEN) {
      // Graceful fallback — return the default URL if no API token
      return res.json({
        job_id: null,
        job_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
        status: "not_connected",
        title: routeResult.role_title,
        message: "Worksome API not configured — redirecting to login",
      });
    }

    const result = await worksome.handoff(routeResult);
    res.json(result);
  } catch (err) {
    console.error("[Worksome] Handoff error:", err.message);
    // Don't block the user — return fallback URL
    res.json({
      job_id: null,
      job_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
      status: "error",
      title: req.body?.role_title || "Role",
      message: err.message,
    });
  }
});

// ─── GitHub Talent Discovery ─────────────────────────

// In-memory shortlist store (per-session, not persisted)
const shortlists = new Map(); // sessionId → ExternalTalentLead[]

app.get("/api/github/search", async (req, res) => {
  try {
    const { skills, languages, keywords, location, maxResults } = req.query;

    const criteria = {
      skills: skills ? skills.split(",").map(s => s.trim()).filter(Boolean) : [],
      languages: languages ? languages.split(",").map(s => s.trim()).filter(Boolean) : [],
      keywords: keywords ? keywords.split(",").map(s => s.trim()).filter(Boolean) : [],
      location: location || null,
      maxResults: Math.min(parseInt(maxResults) || 10, 20),
    };

    if (criteria.skills.length === 0 && criteria.languages.length === 0 && criteria.keywords.length === 0) {
      return res.status(400).json({ error: "At least one of skills, languages, or keywords is required" });
    }

    const profiles = await github.discoverTalent(criteria);
    const leads = profiles.map(p => buildExternalTalentLead(p, criteria));

    // Sort by fit score descending
    leads.sort((a, b) => b.fitScore - a.fitScore);

    res.json({ leads, criteria, count: leads.length });
  } catch (err) {
    console.error("[GitHub] Search error:", err.message);
    const isRateLimit = err.message.includes("rate limit");
    res.status(isRateLimit ? 429 : 500).json({ error: err.message, leads: [] });
  }
});

app.get("/api/github/shortlist", (req, res) => {
  const sessionId = req.query.sessionId || "default";
  const list = shortlists.get(sessionId) || [];
  res.json({ shortlist: list, count: list.length });
});

app.post("/api/github/shortlist", (req, res) => {
  const { sessionId = "default", lead } = req.body;
  if (!lead || !lead.githubLogin) {
    return res.status(400).json({ error: "Missing lead data" });
  }

  if (!shortlists.has(sessionId)) shortlists.set(sessionId, []);
  const list = shortlists.get(sessionId);

  // Check for duplicates
  if (list.some(l => l.githubLogin === lead.githubLogin)) {
    return res.json({ status: "already_shortlisted", shortlist: list });
  }

  lead.updatedAt = new Date().toISOString();
  list.push(lead);
  res.json({ status: "shortlisted", shortlist: list });
});

app.post("/api/github/invite", (req, res) => {
  const { sessionId = "default", githubLogin, roleTitle, skills, clientName, senderName } = req.body;

  if (!githubLogin) {
    return res.status(400).json({ error: "Missing githubLogin" });
  }

  // Find in shortlist
  const list = shortlists.get(sessionId) || [];
  const lead = list.find(l => l.githubLogin === githubLogin);

  if (!lead) {
    return res.status(404).json({ error: "Lead not found in shortlist. Shortlist first." });
  }

  // Generate invite message from template
  const firstName = lead.displayName ? lead.displayName.split(" ")[0] : lead.githubLogin;
  const matchedSkills = (skills || lead.inferredSkills || lead.topLanguages || []).slice(0, 4).join(", ");
  const inviteLink = `${process.env.WORKSOME_URL || "https://sandbox.worksome.com"}/invite/gh/${lead.githubLogin}`;

  const inviteMessage = `Hi ${firstName},

I came across your public GitHub work and thought your experience with ${matchedSkills} could be relevant for a freelance opportunity with ${clientName || "our team"}.

The role is for ${roleTitle || "a technical project"} and would be managed through Worksome for contracting, compliance, and payment.

If you are open to hearing more, you can create a Worksome profile here and I'll send you the job to review:
${inviteLink}

Best,
${senderName || "The hiring team"}`;

  // Update lead status
  lead.inviteStatus = "draft";
  lead.consentStatus = "not_contacted";
  lead.updatedAt = new Date().toISOString();

  res.json({
    status: "draft_created",
    inviteMessage,
    inviteLink,
    lead,
  });
});

// ─── Health check ─────────────────────────────────────
app.get("/api/health", async (req, res) => {
  const [wsHealth, ghHealth] = await Promise.all([
    process.env.WORKSOME_API_TOKEN
      ? worksome.healthCheck()
      : Promise.resolve({ ok: false, error: "No token configured" }),
    github.healthCheck(),
  ]);

  res.json({
    status: "ok",
    time: new Date().toISOString(),
    worksome: wsHealth,
    github: ghHealth,
  });
});

// ─── Slack bot (optional, only if tokens are set) ─────
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const { App: SlackApp } = require("@slack/bolt");
  const slackBot = require("./slack-bot/bot-handler");

  const slack = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  slackBot.register(slack, anthropic);

  slack.start().then(() => {
    console.log("⚡ Slack bot connected");
  }).catch((err) => {
    console.error("⚡ Slack bot failed to connect:", err.message);
  });

  // Handle Slack disconnections gracefully instead of crashing
  slack.error(async (error) => {
    console.error("⚡ Slack error (non-fatal):", error.message || error);
  });
}

// ─── Global error handlers (prevent crash loops) ─────
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (kept alive):", reason);
});

// ─── Start server ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Front Door running at http://localhost:${PORT}`);
  console.log(`   Portal: http://localhost:${PORT}`);
  console.log(`   API:    http://localhost:${PORT}/api/chat`);
});
