require("dotenv").config();
const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");

// ─── Config ───────────────────────────────────────────
const config = {
  assistant_name: process.env.ASSISTANT_NAME || "Worksome Hiring Hub",
  vms: { name: process.env.VMS_NAME || "Beeline" },
  worksome_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
  vms_url: process.env.VMS_URL || "https://beeline.com",
  weights: {
    deliverable_or_ongoing: 3,
    duration: 2,
    headcount: 2,
    payment_model: 1,
    sdc: 1,
  },
  knockouts: {
    vms: ["agency", "staffing firm", "temp workers", "temps"],
    worksome: [
      "freelancer",
      "independent consultant",
      "sow",
      "statement of work",
      "fixed bid",
      "milestone payment",
    ],
  },
};

// ─── System prompt (same as portal) ───────────────────
function buildSystemPrompt() {
  const c = config;
  return `You are ${c.assistant_name}, a hiring assistant that helps managers find the right talent quickly. You make the process simple — the manager describes what they need in plain language, and you handle the rest.

You are warm, professional, and efficient. You never use procurement jargon (no "SOW," "staff augmentation," "IC," or "VMS"). You speak the manager's language.

## Your Job
Conduct a short intake interview (2–7 questions) to understand what the manager needs, then produce a structured routing decision. Ask ONE question at a time. Keep messages to 1-3 sentences. Never explain the routing logic.

## Conversation Flow

### Q1: Ask "Do you already know who you'd like to work with?"
- If YES → Path A (Fast Track)
- If NO → Path B (Discovery)

### Path A: Fast Track
Q1b: "Great — is this person replacing someone on your team, or are they coming in for a specific project?"
- PROJECT → Route: worksome
- REPLACE → Ask Q1c

Q1c: "Will you be managing their day-to-day work — setting tasks, supervising their schedule, directing how the work gets done?"
- YES (SDC present) → Route: vms
- NO (autonomous) → Route: worksome

### Path B: Discovery Flow
Q2: "Tell me about the work you need done — what's the role or project?"
Q3: "Is this for a specific project with a defined deliverable, or do you need ongoing support for your team?" (weight: ${c.weights.deliverable_or_ongoing})
Q4: "How long do you expect this to last?" (weight: ${c.weights.duration})
Q5: "How many people do you need?" (weight: ${c.weights.headcount})

After Q5, if clear → route. If ambiguous → ask tiebreakers:
Q6: "Would you prefer to pay for specific deliverables or on an hourly/daily rate?" (weight: ${c.weights.payment_model})
Q7: "Will you be managing this person's day-to-day work?" (weight: ${c.weights.sdc})

## Knockout Signals (instant route, check every answer)
Route to VMS if: ${c.knockouts.vms.join(", ")} or 10+ identical roles
Route to Worksome if: ${c.knockouts.worksome.join(", ")}

## Scoring
Deliverable/ongoing: wt ${c.weights.deliverable_or_ongoing} | Duration: wt ${c.weights.duration} | Headcount: wt ${c.weights.headcount} | Payment: wt ${c.weights.payment_model} | SDC: wt ${c.weights.sdc}
Route clear if one side ≥ 5. Ambiguous if diff ≤ 1 → ask tiebreakers.

## VMS Provider
The VMS for this client is: ${c.vms.name}

## Output
When routing is determined, respond with your confirmation message, then on a NEW LINE output EXACTLY this JSON block (the system will parse it):
\`\`\`json
{"route":"worksome_or_vms","confidence":"high_or_medium","role_title":"...","description":"...","known_worker":true_or_false,"sdc_present":true_or_false_or_null,"headcount":1,"duration":"...","payment_model":"..."}
\`\`\`

## Rules
1. One question at a time. Never stack questions.
2. Keep messages to 1-3 sentences.
3. Never mention Worksome, ${c.vms.name}, SDC, scoring, or routing to the manager.
4. Never use procurement jargon.
5. Be conversational — like a helpful colleague, not a form.
6. When confirming the route, say: "Perfect — I've got everything I need. I'm setting this up for you now."`;
}

// ─── In-memory conversation store ─────────────────────
// Key: Slack user ID → array of { role, content }
const sessions = new Map();

// ─── Anthropic client ─────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function callClaude(userId) {
  const messages = sessions.get(userId) || [];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: buildSystemPrompt(),
    messages,
  });
  return response.content[0].text;
}

// ─── Quick-reply detection ────────────────────────────
function detectQuickReplies(text) {
  const t = text.toLowerCase();
  if (t.includes("already know who") || t.includes("know who you'd like"))
    return ["Yes, I have someone in mind", "No, I need to find someone"];
  if (
    (t.includes("replacing someone") || t.includes("replace someone")) &&
    (t.includes("project") || t.includes("specific"))
  )
    return ["Replacing someone on my team", "For a specific project"];
  if (
    t.includes("managing their day-to-day") ||
    t.includes("managing this person") ||
    t.includes("supervising their schedule")
  )
    return ["Yes, I'll manage them directly", "No, they'll work independently"];
  if (
    (t.includes("specific project") || t.includes("defined deliverable")) &&
    t.includes("ongoing")
  )
    return ["Specific project with a deliverable", "Ongoing support for my team"];
  if (t.includes("prefer to pay") && (t.includes("deliverable") || t.includes("hourly")))
    return ["Pay for deliverables / milestones", "Hourly or daily rate"];
  return null;
}

// ─── Build Slack Block Kit messages ───────────────────
function buildBlocks(text, quickReplies, routeResult) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];

  if (quickReplies) {
    blocks.push({
      type: "actions",
      elements: quickReplies.map((label, i) => ({
        type: "button",
        text: { type: "plain_text", text: label, emoji: true },
        action_id: `quick_reply_${i}`,
        value: label,
      })),
    });
  }

  if (routeResult) {
    const isWorksome = routeResult.route === "worksome";
    const dest = isWorksome ? "Worksome" : config.vms.name;
    const url = isWorksome ? config.worksome_url : config.vms_url;
    const headcount = routeResult.headcount > 1 ? ` · ${routeResult.headcount} people` : "";

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark:  *Routed → ${dest}*`,
      },
    });
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Role*\n${routeResult.role_title || "Role"}` },
        { type: "mrkdwn", text: `*Confidence*\n${routeResult.confidence}` },
        { type: "mrkdwn", text: `*Type*\n${routeResult.known_worker ? "Known worker" : "Talent search"}${headcount}` },
        { type: "mrkdwn", text: `*Duration*\n${routeResult.duration || "—"}` },
      ],
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: `Continue in ${dest} →`, emoji: true },
          url,
          action_id: "open_destination",
          style: "primary",
        },
      ],
    });
  }

  return blocks;
}

// ─── Parse routing JSON from Claude's response ───────
function parseRoute(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function cleanReply(text) {
  return text.replace(/```json[\s\S]*?```/, "").trim();
}

// ─── Slack app ────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// /hire slash command — starts a new intake
app.command("/hire", async ({ command, ack, client }) => {
  await ack();

  const userId = command.user_id;

  // Reset session
  const greeting = `${config.assistant_name}\n\nHi! I'm here to help you find the right talent. Let's get started.\n\nDo you already know who you'd like to work with?`;
  sessions.set(userId, [{ role: "assistant", content: greeting }]);

  const quickReplies = ["Yes, I have someone in mind", "No, I need to find someone"];

  await client.chat.postMessage({
    channel: command.user_id, // DM the user
    text: greeting,
    blocks: buildBlocks(greeting, quickReplies, null),
  });
});

// DM messages — continue the conversation
app.message(async ({ message, client }) => {
  // Ignore bot messages, edits, threads
  if (message.bot_id || message.subtype) return;

  const userId = message.user;

  // If no session, prompt them to use /hire
  if (!sessions.has(userId)) {
    await client.chat.postMessage({
      channel: message.channel,
      text: 'Type `/hire` to start a new hiring request.',
    });
    return;
  }

  // Add user message to session
  const history = sessions.get(userId);
  history.push({ role: "user", content: message.text });

  // Call Claude
  try {
    const reply = await callClaude(userId);
    const routeResult = parseRoute(reply);
    const clean = cleanReply(reply);
    const quickReplies = routeResult ? null : detectQuickReplies(clean);

    // Store assistant reply in session
    history.push({ role: "assistant", content: reply });

    // If routed, clear session after sending
    await client.chat.postMessage({
      channel: message.channel,
      text: clean,
      blocks: buildBlocks(clean, quickReplies, routeResult),
    });

    if (routeResult) {
      sessions.delete(userId);
    }
  } catch (err) {
    console.error("Claude API error:", err.message);
    await client.chat.postMessage({
      channel: message.channel,
      text: `Something went wrong — please try again or type \`/hire\` to restart.`,
    });
  }
});

// Button clicks (quick replies)
app.action(/quick_reply_\d+/, async ({ action, body, ack, client }) => {
  await ack();

  const userId = body.user.id;
  const channel = body.channel.id;
  const text = action.value;

  if (!sessions.has(userId)) {
    await client.chat.postMessage({
      channel,
      text: 'That session has ended. Type `/hire` to start a new one.',
    });
    return;
  }

  // Post the user's choice as a message-style block
  await client.chat.postMessage({
    channel,
    text: `You chose: ${text}`,
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `↳ *${text}*` }],
      },
    ],
  });

  // Add to session and call Claude
  const history = sessions.get(userId);
  history.push({ role: "user", content: text });

  try {
    const reply = await callClaude(userId);
    const routeResult = parseRoute(reply);
    const clean = cleanReply(reply);
    const quickReplies = routeResult ? null : detectQuickReplies(clean);

    history.push({ role: "assistant", content: reply });

    await client.chat.postMessage({
      channel,
      text: clean,
      blocks: buildBlocks(clean, quickReplies, routeResult),
    });

    if (routeResult) {
      sessions.delete(userId);
    }
  } catch (err) {
    console.error("Claude API error:", err.message);
    await client.chat.postMessage({
      channel,
      text: `Something went wrong — please try again or type \`/hire\` to restart.`,
    });
  }
});

// Acknowledge the destination button click (no-op, it opens a URL)
app.action("open_destination", async ({ ack }) => {
  await ack();
});

// ─── Start ────────────────────────────────────────────
(async () => {
  await app.start();
  console.log(`⚡ Front Door Slack bot is running`);
  console.log(`   Assistant: ${config.assistant_name}`);
  console.log(`   VMS: ${config.vms.name}`);
  console.log(`   Type /hire in Slack to start an intake`);
})();
