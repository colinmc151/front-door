require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

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
      max_tokens: 500,
      system,
      messages,
    });

    res.json({ text: response.content[0].text });
  } catch (err) {
    console.error("Claude API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
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
