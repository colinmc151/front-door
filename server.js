require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const worksome = require("./worksome-client");

const app = express();
app.use(express.json());

// ─── Serve the portal ─────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Claude API proxy ─────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post("/api/chat", async (req, res) => {
  try {
    const { system, messages } = req.body;

    if (!system || !messages) {
      return res.status(400).json({ error: "Missing system or messages" });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system,
      messages,
    });

    res.json({ text: response.content[0].text });
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

// ─── Debug: test different GraphQL query shapes ──────
app.get("/api/debug-search", async (req, res) => {
  const name = req.query.name || "Sterling";
  const results = {};

  // Try 1: Introspect TrustedContact type fields
  try {
    const d = await worksome.graphql(`{ __type(name: "TrustedContact") { fields { name type { name kind ofType { name kind } } } } }`);
    results.trustedContact_fields = d.__type?.fields?.map(f => ({ name: f.name, type: f.type?.name || f.type?.ofType?.name || f.type?.kind })) || [];
  } catch (e) { results.introspection_error = e.message; }

  // Try 2: trustedContacts with just id (minimal query to confirm search works)
  try {
    const d = await worksome.graphql(`{ trustedContacts(search: "${name}", first: 5) { data { id } } }`);
    results.search_ids = d.trustedContacts?.data || [];
  } catch (e) { results.search_ids_error = e.message; }

  // Try 3: trustedContacts with likely field names
  try {
    const d = await worksome.graphql(`{ trustedContacts(search: "${name}", first: 5) { data { id firstName lastName worker { id name email title } } } }`);
    results.search_with_worker = d.trustedContacts?.data || [];
  } catch (e) { results.search_with_worker_error = e.message; }

  res.json({ query: name, results });
});

// ─── Health check ─────────────────────────────────────
app.get("/api/health", async (req, res) => {
  const wsHealth = process.env.WORKSOME_API_TOKEN
    ? await worksome.healthCheck()
    : { ok: false, error: "No token configured" };

  res.json({
    status: "ok",
    time: new Date().toISOString(),
    worksome: wsHealth,
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
  });
}

// ─── Start server ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Front Door running at http://localhost:${PORT}`);
  console.log(`   Portal: http://localhost:${PORT}`);
  console.log(`   API:    http://localhost:${PORT}/api/chat`);
});
