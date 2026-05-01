// Slack bot handler — imported by server.js
// The Slack App and Anthropic client are passed in from the server
const worksome = require("../worksome-client");

const config = {
  assistant_name: process.env.ASSISTANT_NAME || "Worksome Hiring Hub",
  vms: { name: process.env.VMS_NAME || "Beeline" },
  worksome_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
  worksome_talent_pool_url: process.env.WORKSOME_TALENT_POOL_URL || "https://sandbox.worksome.com/contacts",
  vms_url: process.env.VMS_URL || "https://beeline.com",
  weights: { deliverable_or_ongoing: 3, duration: 2, headcount: 2, payment_model: 1, sdc: 1 },
  knockouts: {
    vms: ["agency", "staffing firm", "temp workers", "temps"],
    worksome: ["freelancer", "independent consultant", "sow", "statement of work", "fixed bid", "milestone payment"],
  },
};

function buildSystemPrompt() {
  const c = config;
  return `You are ${c.assistant_name}, a hiring assistant that helps managers find the right talent quickly. You make the process simple — the manager describes what they need in plain language, and you handle the rest.

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
- *[Name]* — [Title] · Skills: [their skills] · *Match: 8/10* — [brief reason why they're a good/okay fit]
- *[Name]* — [Title] · Skills: [their skills] · *Match: 6/10* — [reason]

Then ask: "Would you like to hire one of these people?"

- Pick someone → Ask Q1d. Then output JSON. Done.
- None fit → "No problem — let me set up the role so we can find someone new." → Go to B2 Q3 onward (skip Q2, we already have the project description and skills).

**If no workers found:** "I didn't find anyone with those skills in your talent pool yet. Let me set up the role." → Go to B2 Q3 onward.

### B2: Full discovery
Ask these in order, ONE AT A TIME. Skip any already answered:

Q2: "Tell me about the work you need done — what's the role or project?"
Q3: "Is this for a specific project with a deliverable, or ongoing support?" (weight: ${c.weights.deliverable_or_ongoing})
Q4: "How long do you expect this to last?" (weight: ${c.weights.duration})
Q5: "How many people do you need?" (weight: ${c.weights.headcount})

If route is clear after Q5 → go to Enrichment.
If ambiguous (scores within 1 point) → ask tiebreakers:
Q6: "Would you prefer to pay for specific deliverables or on an hourly/daily rate?" (weight: ${c.weights.payment_model})
Q7: "Will you be managing this person's day-to-day work?" (weight: ${c.weights.sdc})

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
VMS if: ${c.knockouts.vms.join(", ")} or 10+ identical roles
Worksome if: ${c.knockouts.worksome.join(", ")}
After a knockout, still ask remaining enrichment questions.

### Scoring (B2 only)
Deliverable/ongoing: wt ${c.weights.deliverable_or_ongoing} | Duration: wt ${c.weights.duration} | Headcount: wt ${c.weights.headcount} | Payment: wt ${c.weights.payment_model} | SDC: wt ${c.weights.sdc}
Route clear if one side ≥ 5. Ambiguous if diff ≤ 1.

VMS provider: ${c.vms.name}

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
3. Never mention Worksome, ${c.vms.name}, SDC, scoring, or routing.
4. No procurement jargon.
5. Be conversational — like a helpful colleague, not a form.
6. Fast-track paths (A1, A2, B1-pick) should feel like 3-4 messages total. Don't pad them with extra questions.`;
}

const sessions = new Map();
const waitingForName = new Set(); // Track users in the "what's their name?" state

function isAskingForName(text) {
  const t = text.toLowerCase();
  return t.includes("what's their name") || t.includes("what is their name") || t.includes("who is it") || t.includes("what's the person's name");
}

function detectQuickReplies(text) {
  const t = text.toLowerCase();
  if (t.includes("already know who") || t.includes("know who you'd like"))
    return ["Yes, I have someone in mind", "No, I need to find someone"];
  if (t.includes("worked with") && (t.includes("before") || t.includes("through us")))
    return ["Yes, they've worked with us before", "No, they're new"];
  if ((t.includes("replacing someone") || t.includes("replace someone")) && (t.includes("project") || t.includes("specific")))
    return ["Replacing someone on my team", "For a specific project"];
  if (t.includes("managing their day-to-day") || t.includes("managing this person") || t.includes("supervising their schedule"))
    return ["Yes, I'll manage them directly", "No, they'll work independently"];
  if (t.includes("project brief") && (t.includes("ai") || t.includes("talent pool") || t.includes("best match")))
    return ["Yes, create a project brief", "No, I'll just describe the role"];
  if ((t.includes("specific project") || t.includes("defined deliverable")) && t.includes("ongoing"))
    return ["Specific project with a deliverable", "Ongoing support for my team"];
  if (t.includes("prefer to pay") && (t.includes("deliverable") || t.includes("hourly")))
    return ["Pay for deliverables / milestones", "Hourly or daily rate"];
  // Enrichment quick replies
  if (t.includes("remote") && t.includes("on-site") || t.includes("remote") && t.includes("hybrid"))
    return ["Remote", "On-site", "Hybrid"];
  if (t.includes("budget") && t.includes("rate") && t.includes("mind"))
    return ["I have a budget in mind", "No specific budget yet"];
  return null;
}

function buildBlocks(text, quickReplies, routeResult) {
  const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];

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
    let url = isWorksome ? config.worksome_url : config.vms_url;
    const headcount = routeResult.headcount > 1 ? ` · ${routeResult.headcount} people` : "";

    // Worker not found — send to trusted contacts to invite
    const isNewWorker = isWorksome && routeResult.worker_found === false && routeResult.worker_email;
    if (isNewWorker || (isWorksome && routeResult.worker_found === false && !routeResult.worker_email)) {
      url = config.worksome_talent_pool_url;
    }
    // If routed to Worksome and handoff data is available, use the job URL
    else if (isWorksome && routeResult._handoff && routeResult._handoff.job_url) {
      url = routeResult._handoff.job_url;
    }

    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `:white_check_mark:  *Routed → ${dest}*` } });
    const fields = [
      { type: "mrkdwn", text: `*Role*\n${routeResult.role_title || "Role"}` },
      { type: "mrkdwn", text: `*Confidence*\n${routeResult.confidence}` },
      { type: "mrkdwn", text: `*Type*\n${routeResult.known_worker ? "Known worker" : "Talent search"}${headcount}` },
      { type: "mrkdwn", text: `*Duration*\n${routeResult.duration || "—"}` },
    ];
    if (isWorksome && routeResult._handoff && routeResult._handoff.job_id) {
      fields.push({ type: "mrkdwn", text: `*Worksome Job*\nDraft #${routeResult._handoff.job_id}` });
    }
    if (isNewWorker && routeResult._handoff && routeResult._handoff.worker_invited) {
      fields.push({ type: "mrkdwn", text: `*Worker*\n${routeResult.worker_first_name || ''} ${routeResult.worker_last_name || ''} invited` });
    }
    blocks.push({ type: "section", fields });
    const buttonLabel = isNewWorker ? "View in Worksome →" : `Continue in ${dest} →`;
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: buttonLabel, emoji: true },
        url, action_id: "open_destination", style: "primary",
      }],
    });
  }

  return blocks;
}

function parseRoute(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function cleanReply(text) {
  return text.replace(/```json[\s\S]*?```/, "").trim();
}

// ─── Register handlers on a Slack App instance ────────
module.exports.register = function (app, anthropic) {
  async function callClaude(userId) {
    const messages = sessions.get(userId) || [];
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: buildSystemPrompt(),
      messages,
    });
    return response.content[0].text;
  }

  // Call Claude with an explicit message array (for follow-up calls)
  async function callClaudeWithMessages(msgArray) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: buildSystemPrompt(),
      messages: msgArray,
    });
    return response.content[0].text;
  }

  // ─── Shared reply processing (used by both message + quick_reply) ───
  async function processReply(userId, channel, client) {
    const history = sessions.get(userId);
    const reply = await callClaude(userId);

    // Check for [TALENT_SEARCH: ...] marker — B1 AI Project Brief flow
    const talentSearchMatch = reply.match(/\[TALENT_SEARCH:\s*([^\]]+)\]/);

    if (talentSearchMatch && !parseRoute(reply)) {
      const skillsText = talentSearchMatch[1].trim();
      const displayReply = reply.replace(/\[TALENT_SEARCH:[^\]]+\]/, '').trim();
      const cleanDisplay = cleanReply(displayReply);

      // Show the project brief immediately
      await client.chat.postMessage({
        channel,
        text: cleanDisplay,
        blocks: buildBlocks(cleanDisplay, null, null),
      });

      // Show searching indicator
      const searchMsg = await client.chat.postMessage({
        channel,
        text: `:mag: Searching your talent pool for: ${skillsText}...`,
      });

      // Search talent pool by skills
      let workers = [];
      let resolved = [];
      try {
        const result = await worksome.searchWorkersBySkills(skillsText.split(',').map(s => s.trim()));
        workers = result.workers || [];
        resolved = result.resolvedSkills || [];
      } catch (err) {
        console.warn("[Slack] Skill search failed:", err.message);
      }

      const skillSummary = resolved.map(s => s.name).join(', ') || skillsText;

      // Build follow-up message array with results
      history.push({ role: "assistant", content: reply });
      let followUpMsg;

      if (workers.length > 0) {
        const workerList = workers.map(w =>
          `- ${w.name}${w.title ? ` (${w.title})` : ''}${w.email ? ` — ${w.email}` : ''}${w.skills && w.skills.length > 0 ? ` | Skills: ${w.skills.join(', ')}` : ''} [ID: ${w.id}]`
        ).join('\n');
        followUpMsg = `[SYSTEM: Talent pool search for skills "${skillSummary}" found these workers:\n${workerList}\n\nScore each worker out of 10 based on how well their skills and title match the project requirements you just described. Present results as a ranked list with name, title, skills, score out of 10, and a brief reason. Then ask if the manager wants to hire one of them. IMPORTANT: Include the worker's ID in worker_id in the final JSON if they pick someone.]`;
      } else {
        followUpMsg = `[SYSTEM: Talent pool search for skills "${skillSummary}" found no matches. Tell the manager you didn't find anyone with those skills in their talent pool yet. Offer to set up the role so they can find the right person. Continue to Path B2 Q3 onward — you already have the project description and skills.]`;
      }

      history.push({ role: "user", content: followUpMsg });

      // Second Claude call with talent pool results
      const followUpReply = await callClaudeWithMessages(history);
      const routeResult = parseRoute(followUpReply);
      const followUpClean = cleanReply(followUpReply);
      const quickReplies = routeResult ? null : detectQuickReplies(followUpClean);
      history.push({ role: "assistant", content: followUpReply });

      // Attempt Worksome handoff if routed
      if (routeResult && routeResult.route === "worksome") {
        try {
          const handoffData = await worksome.handoff(routeResult);
          routeResult._handoff = handoffData;
        } catch (err) {
          console.warn("[Slack] Worksome handoff failed (non-fatal):", err.message);
        }
      }

      await client.chat.postMessage({ channel, text: followUpClean, blocks: buildBlocks(followUpClean, quickReplies, routeResult) });
      if (routeResult) { sessions.delete(userId); waitingForName.delete(userId); }
      return;
    }

    // Normal flow — no talent search marker
    const routeResult = parseRoute(reply);
    const clean = cleanReply(reply);
    const quickReplies = routeResult ? null : detectQuickReplies(clean);

    // Check if Claude is now asking for the worker's name
    if (!routeResult && isAskingForName(clean)) {
      waitingForName.add(userId);
    }
    history.push({ role: "assistant", content: reply });

    // Attempt Worksome handoff if routed there
    if (routeResult && routeResult.route === "worksome") {
      try {
        const handoffData = await worksome.handoff(routeResult);
        routeResult._handoff = handoffData;
      } catch (err) {
        console.warn("[Slack] Worksome handoff failed (non-fatal):", err.message);
      }
    }

    await client.chat.postMessage({ channel, text: clean, blocks: buildBlocks(clean, quickReplies, routeResult) });
    if (routeResult) { sessions.delete(userId); waitingForName.delete(userId); }
  }

  app.command("/hire", async ({ command, ack, client }) => {
    await ack();
    const userId = command.user_id;
    const greeting = `${config.assistant_name}\n\nHi! I'm here to help you find the right talent. Let's get started.\n\nDo you already know who you'd like to work with?`;
    sessions.set(userId, [{ role: "assistant", content: greeting }]);
    await client.chat.postMessage({
      channel: command.user_id,
      text: greeting,
      blocks: buildBlocks(greeting, ["Yes, I have someone in mind", "No, I need to find someone"], null),
    });
  });

  app.message(async ({ message, client }) => {
    if (message.bot_id || message.subtype) return;
    const userId = message.user;
    if (!sessions.has(userId)) {
      await client.chat.postMessage({ channel: message.channel, text: 'Type `/hire` to start a new hiring request.' });
      return;
    }
    const history = sessions.get(userId);
    history.push({ role: "user", content: message.text });

    // If waiting for a worker name, search the talent pool
    if (waitingForName.has(userId)) {
      waitingForName.delete(userId);
      try {
        const workers = await worksome.searchWorkers(message.text.trim());
        history.push({ role: "assistant", content: `Let me check the talent pool for "${message.text}"...` });
        if (workers.length > 0) {
          const workerList = workers.map(w => `- ${w.name}${w.title ? ` (${w.title})` : ''}${w.email ? ` — ${w.email}` : ''} [ID: ${w.id}]`).join('\n');
          history.push({ role: "user", content: `[SYSTEM: Talent pool search results for "${message.text}":\n${workerList}\nPresent these matches to the manager and ask them to confirm which worker. IMPORTANT: When outputting the final JSON, you MUST include the worker's ID exactly as shown above in the worker_id field.]` });
        } else {
          history.push({ role: "user", content: `[SYSTEM: Talent pool search for "${message.text}" returned no results. Tell the manager you couldn't find them but you can get them set up. Ask for their first name to start collecting details (first name, last name, email, country, skills) — one question at a time.]` });
        }
      } catch (err) {
        console.warn("[Slack] Worker search failed:", err.message);
      }
    }

    try {
      await processReply(userId, message.channel, client);
    } catch (err) {
      console.error("Claude API error:", err.message);
      await client.chat.postMessage({ channel: message.channel, text: "Something went wrong — please try again or type `/hire` to restart." });
    }
  });

  app.action(/quick_reply_\d+/, async ({ action, body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const channel = body.channel.id;
    const text = action.value;
    if (!sessions.has(userId)) {
      await client.chat.postMessage({ channel, text: 'That session has ended. Type `/hire` to start a new one.' });
      return;
    }
    await client.chat.postMessage({ channel, text: `You chose: ${text}`, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `↳ *${text}*` }] }] });
    const history = sessions.get(userId);
    history.push({ role: "user", content: text });
    try {
      await processReply(userId, channel, client);
    } catch (err) {
      console.error("Claude API error:", err.message);
      await client.chat.postMessage({ channel, text: "Something went wrong — please try again or type `/hire` to restart." });
    }
  });

  app.action("open_destination", async ({ ack }) => { await ack(); });
};
