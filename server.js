require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const worksome = require("./worksome-client");
const github = require("./github-client");
const { buildExternalTalentLead } = require("./github-scoring");
const { scoreWorker } = require("./worksome-scoring");
const configStore = require("./config-store");
const routing = require("./routing");
const eventLog = require("./event-log");
const { computeAnalytics } = require("./analytics");
const approval = require("./approval");
const { buildSystemPrompt } = require("./prompt");
const beeline = require("./beeline-mapper");

// Strip PII / sensitive figures before worker data leaves the server.
// `previouslyEngaged` replaces the raw totalPaid amount; emails stay
// server-side (they're not needed for matching or display).
function sanitizeWorker(w) {
  const { email, totalPaid, ...rest } = w;
  return { ...rest, previouslyEngaged: (totalPaid || 0) > 0 };
}

const auditLog = eventLog.open("audit");       // routed intakes + handoffs (append-only)
const webhookLog = eventLog.open("webhooks");  // inbound Worksome lifecycle events

const app = express();
// Trust the first proxy hop (load balancer) so req.ip is the real client
// IP for rate limiting, and req.secure reflects x-forwarded-proto.
app.set("trust proxy", 1);
app.use(express.json({
  limit: "50kb",
  verify: (req, res, buf) => { req.rawBody = buf; }, // raw body kept for webhook signature checks
}));

// ─── Security headers ─────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // inline <style> blocks + React style attributes
    "img-src 'self' https: data:",      // worker/GitHub avatars, configurable logo/hero URLs
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

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

// ─── Auth: API key (programmatic) + signed session cookie (portal) ──
// The API key is never sent to the browser. Portal visitors get a
// short-lived signed HttpOnly cookie when the page is served.
const API_KEY = process.env.FRONT_DOOR_API_KEY;
const SESSION_SECRET = crypto.randomBytes(32); // rotates on restart; cookie is reissued on page load
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SESSION_COOKIE = "fd_session";

function signSession(exp) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(String(exp)).digest("hex");
}

function issueSessionToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${signSession(exp)}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = signSession(exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function timingSafeKeyMatch(provided) {
  if (!provided || !API_KEY) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Issue/refresh the session cookie when serving portal pages
app.use((req, res, next) => {
  const isPortalPage = req.method === "GET" && (req.path === "/" || req.path.endsWith(".html"));
  if (isPortalPage && !verifySessionToken(parseCookies(req)[SESSION_COOKIE])) {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=${issueSessionToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`);
  }
  next();
});

// ─── Serve the portal ─────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (!API_KEY) return next(); // skip auth if no key configured (dev mode)
  if (req.path === "/health") return next(); // health check exempt
  if (req.path === "/webhooks/worksome") return next(); // authenticated by signature instead
  if (timingSafeKeyMatch(req.headers["x-api-key"])) return next(); // programmatic clients
  if (verifySessionToken(parseCookies(req)[SESSION_COOKIE])) return next(); // portal session
  return res.status(401).json({ error: "Unauthorized" });
}

app.use("/api", requireAuth);

// ─── Config API (persisted server-side, drives the prompt) ──
app.get("/api/config", (req, res) => {
  res.json(configStore.get());
});

app.put("/api/config", (req, res) => {
  try {
    const saved = configStore.update(req.body);
    console.log("[Config] Updated by", req.ip);
    res.json(saved);
  } catch (err) {
    console.error("[Config] Save failed:", err.message);
    res.status(500).json({ error: "Could not save settings" });
  }
});


// ─── Gemini API (locked to server-side prompt) ────────
const gemini = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Convert chat messages [{role:'user'|'assistant', text:'...'}]
// to Gemini format [{role:'user'|'model', parts:[{text:'...'}]}]
function toGeminiMessages(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text || m.content || '' }],
  }));
}

const CHAT_MODEL = "gemini-2.5-flash";
const CHAT_MAX_TOKENS = 1500; // headroom so the routing JSON never truncates

// Shared post-processing for both chat endpoints: validate/repair the
// routing JSON (one corrective retry), record the audit entry, and
// evaluate approval gates against the routing decision.
async function finalizeChatReply(geminiMessages, rawText, genConfig, body) {
  let text = rawText;
  let check = routing.checkReply(text);

  if (check.needsRetry) {
    console.warn(`[Routing] Invalid JSON from model (${check.reason}) — retrying once`);
    try {
      const retryResponse = await gemini.models.generateContent({
        model: CHAT_MODEL,
        contents: [
          ...geminiMessages,
          { role: "model", parts: [{ text }] },
          { role: "user", parts: [{ text: routing.retryInstruction(check.reason) }] },
        ],
        config: genConfig,
      });
      const retryCheck = routing.checkReply(retryResponse.text || "");
      if (retryCheck.hasRoute) {
        text = (check.prose ? check.prose + "\n\n" : "") +
          "```json\n" + JSON.stringify(retryCheck.route) + "\n```";
        check = retryCheck;
      } else {
        console.warn("[Routing] Retry did not produce valid JSON — returning prose only");
        text = check.prose || text;
      }
    } catch (retryErr) {
      console.warn("[Routing] Retry call failed:", retryErr.message);
      text = check.prose || text;
    }
  } else if (check.hasRoute) {
    text = check.text; // prose + normalized JSON block
  }

  // Audit + approval gates on every completed routing decision
  let intakeId = null;
  let gate = null;
  if (check.hasRoute) {
    const r = check.route;
    gate = approval.evaluateGates(configStore.get().approval_gates, r);
    const startedAt = Number(body.started_at);
    const record = auditLog.append({
      type: "intake_routed",
      channel: "web",
      route: r.route,
      confidence: r.confidence,
      role_title: r.role_title,
      known_worker: r.known_worker,
      headcount: r.headcount,
      payment_model: r.payment_model,
      location: r.location,
      skills: r.skills,
      turns: geminiMessages.length,
      approval_required: gate ? gate.action : null,
      duration_seconds: Number.isFinite(startedAt) && startedAt > 0
        ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        : null,
    });
    intakeId = record.id;
    console.log(`[Audit] Intake routed → ${r.route} (${r.role_title}) [${intakeId}]`);

    if (gate) {
      console.log(`[Approval] Gate triggered: ${gate.condition} → ${gate.action}`);
      if (slackNotify && process.env.SLACK_NOTIFY_CHANNEL) {
        slackNotify(`⏸ Hiring request *${r.role_title}* requires approval: *${gate.action}* (rule: ${gate.condition})`)
          .catch(err => console.warn("[Approval] Slack notify failed:", err.message));
      }
    }
  }

  return { text, intakeId, approval: gate ? { required: true, ...gate } : null };
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing messages array" });
    }

    const systemPrompt = buildSystemPrompt(configStore.get());
    const geminiMessages = toGeminiMessages(messages);
    const genConfig = { systemInstruction: systemPrompt, maxOutputTokens: CHAT_MAX_TOKENS };

    const response = await gemini.models.generateContent({
      model: CHAT_MODEL,
      contents: geminiMessages,
      config: genConfig,
    });

    const result = await finalizeChatReply(geminiMessages, response.text || "", genConfig, req.body);
    res.json({
      text: result.text,
      ...(result.intakeId ? { intakeId: result.intakeId } : {}),
      ...(result.approval ? { approval: result.approval } : {}),
    });
  } catch (err) {
    console.error("Gemini API error:", err.message);
    res.status(500).json({ error: "The assistant is temporarily unavailable. Please try again." });
  }
});

// ─── Streaming chat (SSE) — same pipeline, progressive output ──
app.post("/api/chat/stream", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing messages array" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const systemPrompt = buildSystemPrompt(configStore.get());
    const geminiMessages = toGeminiMessages(messages);
    const genConfig = { systemInstruction: systemPrompt, maxOutputTokens: CHAT_MAX_TOKENS };

    const stream = await gemini.models.generateContentStream({
      model: CHAT_MODEL,
      contents: geminiMessages,
      config: genConfig,
    });

    let full = "";
    for await (const chunk of stream) {
      const t = chunk.text || "";
      if (t) {
        full += t;
        send({ delta: t });
      }
    }

    const result = await finalizeChatReply(geminiMessages, full, genConfig, req.body);
    send({ done: true, text: result.text, intakeId: result.intakeId, approval: result.approval });
  } catch (err) {
    console.error("Gemini stream error:", err.message);
    send({ error: "The assistant is temporarily unavailable. Please try again." });
  }
  res.end();
});

// ─── Analytics (computed from the audit log) ──────────
app.get("/api/analytics", (req, res) => {
  const records = auditLog.all();
  res.json(computeAnalytics(
    records.filter(r => r.type === "intake_routed"),
    records.filter(r => r.type === "handoff")
  ));
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
    res.json({ workers: workers.map(sanitizeWorker), query: name });
  } catch (err) {
    console.error("[Worksome] Search error:", err.message);
    res.json({ workers: [], query: req.query.name, error: "Talent pool search failed" });
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

    // Score each worker against the search criteria
    const criteria = { skills: skillNames, keywords: skillNames };
    const scoredWorkers = (result.workers || [])
      .map(w => scoreWorker(w, criteria))
      .sort((a, b) => b.fitScore - a.fitScore);

    res.json({ ...result, workers: scoredWorkers.map(sanitizeWorker), query: skills });
  } catch (err) {
    console.error("[Worksome] Skill search error:", err.message);
    res.json({ workers: [], resolvedSkills: [], query: req.query.skills, error: "Talent pool search failed" });
  }
});

// ─── Beeline requisition preview ──────────────────────
// Shows the exact requisition Front Door would create in the VMS.
// Becomes a real POST /requisitions call when an API connection exists.
app.post("/api/beeline/preview", (req, res) => {
  const routeResult = req.body || {};
  if (!routeResult.role_title) {
    return res.status(400).json({ error: "Missing route result with role_title" });
  }
  res.json(beeline.buildRequisition(routeResult, {
    approvalRequired: !!routeResult._approvalRequired,
  }));
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
    auditLog.append({
      type: "handoff",
      intakeId: routeResult._intakeId || null,
      job_id: result.job_id || null,
      title: result.title || null,
    });
    res.json(result);
  } catch (err) {
    console.error("[Worksome] Handoff error:", err.message);
    // Don't block the user — return fallback URL
    res.json({
      job_id: null,
      job_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
      status: "error",
      title: req.body?.role_title || "Role",
      message: "Could not create the draft job — continue in Worksome directly",
    });
  }
});

// ─── Create job and invite selected workers ───────────
app.post("/api/worksome/invite", async (req, res) => {
  try {
    const { jobDetails, workerIds, workerNames } = req.body;

    if (!jobDetails || !jobDetails.role_title) {
      return res.status(400).json({ error: "Missing jobDetails with role_title" });
    }
    if (!workerIds || !Array.isArray(workerIds) || workerIds.length === 0) {
      return res.status(400).json({ error: "Missing workerIds array" });
    }

    if (!process.env.WORKSOME_API_TOKEN) {
      return res.json({
        job_id: null,
        job_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
        status: "not_connected",
        message: "Worksome API not configured",
      });
    }

    const result = await worksome.createJobAndInvite(jobDetails, workerIds, workerNames || {});
    res.json(result);
  } catch (err) {
    console.error("[Worksome] Invite error:", err.message);
    res.status(500).json({ error: "Could not create the job or send invites. Please try again." });
  }
});

// ─── GitHub Talent Discovery ─────────────────────────

// In-memory shortlist store (per-session, not persisted)
const shortlists = new Map();          // sessionId → ExternalTalentLead[]
const shortlistTimestamps = new Map(); // sessionId → last active timestamp
const SHORTLIST_TTL = 2 * 60 * 60 * 1000; // 2 hours

function touchShortlist(sessionId) {
  shortlistTimestamps.set(sessionId, Date.now());
}

// Evict stale shortlists every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - SHORTLIST_TTL;
  for (const [sessionId, ts] of shortlistTimestamps) {
    if (ts < cutoff) {
      shortlists.delete(sessionId);
      shortlistTimestamps.delete(sessionId);
    }
  }
}, 600_000);

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
    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit ? "GitHub rate limit reached — try again in a few minutes" : "GitHub search failed",
      leads: [],
    });
  }
});

app.get("/api/github/shortlist", (req, res) => {
  const sessionId = req.query.sessionId || "default";
  touchShortlist(sessionId);
  const list = shortlists.get(sessionId) || [];
  res.json({ shortlist: list, count: list.length });
});

app.post("/api/github/shortlist", (req, res) => {
  const { sessionId = "default", lead } = req.body;
  if (!lead || !lead.githubLogin) {
    return res.status(400).json({ error: "Missing lead data" });
  }

  touchShortlist(sessionId);
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
  touchShortlist(sessionId);
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

// ─── Worksome webhooks (lifecycle tracking) ───────────
// Worksome signs each request with a shared secret; the signature arrives
// in the `Signature` header. We verify HMAC-SHA256 over the raw body —
// confirm the exact scheme with Worksome when registering the endpoint.
let slackNotify = null; // set when the Slack bot connects (see below)

function verifyWorksomeSignature(req) {
  const secret = process.env.WORKSOME_WEBHOOK_SECRET;
  if (!secret) return false;
  const provided = String(req.headers["signature"] || "");
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.alloc(0)).digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/api/webhooks/worksome", (req, res) => {
  if (!process.env.WORKSOME_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Webhooks not configured" });
  }
  if (!verifyWorksomeSignature(req)) {
    console.warn("[Webhook] Rejected request with bad/missing signature from", req.ip);
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { event, data } = req.body || {};
  if (!event) return res.status(400).json({ error: "Missing event" });

  // hireId is the stable engagement reference (survives contract revisions)
  const record = webhookLog.append({
    type: "worksome_webhook",
    event,
    hireId: data?.contract?.hireId || null,
    hireStatus: data?.contract?.hireStatus || null,
    contractId: data?.contract?.id || null,
    workerName: data?.worker?.name || null,
    workerExternalId: data?.worker?.externalIdentifier || null,
    startDate: data?.contract?.startDate || null,
    endDate: data?.contract?.endDate || null,
  });
  console.log(`[Webhook] ${event} (hire: ${record.hireId || "?"}, status: ${record.hireStatus || "?"})`);

  // Notify Slack channel on key lifecycle moments (optional)
  if (slackNotify && process.env.SLACK_NOTIFY_CHANNEL) {
    const messages = {
      contractAccepted: `✅ Contract signed${record.workerName ? ` with *${record.workerName}*` : ""}${record.startDate ? ` — starts ${record.startDate}` : ""}`,
      hireCancelled: `⚠️ A hire was cancelled${record.workerName ? ` (*${record.workerName}*)` : ""}`,
      hireTerminated: `⚠️ An engagement was terminated early${record.workerName ? ` (*${record.workerName}*)` : ""}`,
      hireEnded: `🏁 An engagement ended${record.workerName ? ` (*${record.workerName}*)` : ""}`,
    };
    const msg = messages[event];
    if (msg) slackNotify(msg).catch(err => console.warn("[Webhook] Slack notify failed:", err.message));
  }

  res.json({ received: true });
});

// Recent lifecycle events (drives future funnel UI)
app.get("/api/webhooks/events", (req, res) => {
  res.json({ events: webhookLog.recent(50) });
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
    socketMode: true, // socket mode — no signing secret needed (no public HTTP endpoint)
    appToken: process.env.SLACK_APP_TOKEN,
  });

  slackBot.register(slack, gemini, auditLog);

  // Expose a notifier for webhook lifecycle messages
  if (process.env.SLACK_NOTIFY_CHANNEL) {
    slackNotify = (text) => slack.client.chat.postMessage({
      channel: process.env.SLACK_NOTIFY_CHANNEL,
      text,
    });
  }

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
