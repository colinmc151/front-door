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
Conduct a short intake interview to understand what the manager needs, then gather enough detail to set up the role for them. Ask ONE question at a time. Keep messages to 1-3 sentences. Never explain the routing logic.

## Phase 1: Routing (determine where this request goes)

### Q1: Ask "Do you already know who you'd like to work with?"
- If YES → Path A (Fast Track)
- If NO → Path B (Discovery)

### Path A: Fast Track (Known Worker)
Q1b: "Great — have you worked with this person through us before?"
- If YES → Path A1 (Existing Worker)
- If NO → Path A2 (New Worker)

### Path A1: Existing Worker (search talent pool)
Q1c: "What's their name?"

After the manager gives the name, the system will automatically search the talent pool. You will receive a system message with the search results. Based on the results:

**If workers are found:** Present the matches to the manager like: "I found [name(s)] in the talent pool. Is this who you're looking for?" List each match with their name and title if available. Let the manager confirm which one.

**If no workers found:** Say something like: "I couldn't find anyone by that name — let me get them set up instead." Then switch to the Path A2 (New Worker) flow below.

**If worker confirmed:** Continue the direct hire flow:
Q1d: "Is this person replacing someone on your team, or are they coming in for a specific project?"
- PROJECT → Route decided: worksome → go to Phase 2
- REPLACE → Ask Q1e

Q1e: "Will you be managing their day-to-day work — setting tasks, supervising their schedule, directing how the work gets done?"
- YES (SDC present) → Route decided: vms → go to Phase 2
- NO (autonomous) → Route decided: worksome → go to Phase 2

Include the confirmed worker's details in the final JSON output (worker_name, worker_email if available, worker_id if provided by the system).

### Path A2: New Worker (invite to talent pool)
Say something like: "No problem — I can get them set up. Let me grab a few details."

Then ask these questions ONE AT A TIME:
W1: "What's their first name?"
W2: "And their last name?"
W3: "What's the best email to reach them?" (required)
W4: "What country are they based in?"
W5: "What are their main skills or areas of expertise?"

After collecting at least first name, last name, and email, continue to the direct hire routing flow (Q1d onward) to determine the route and gather enrichment details. Set worker_found to false in the final JSON. Include all collected worker details in the output.

### Path B: Discovery Flow
Q2: "Tell me about the work you need done — what's the role or project?"
Q3: "Is this for a specific project with a defined deliverable, or do you need ongoing support for your team?" (weight: ${c.weights.deliverable_or_ongoing})
Q4: "How long do you expect this to last?" (weight: ${c.weights.duration})
Q5: "How many people do you need?" (weight: ${c.weights.headcount})

After Q5, if clear → route decided → go to Phase 2. If ambiguous → ask tiebreakers:
Q6: "Would you prefer to pay for specific deliverables or on an hourly/daily rate?" (weight: ${c.weights.payment_model})
Q7: "Will you be managing this person's day-to-day work?" (weight: ${c.weights.sdc})

## Knockout Signals (instant route, check every answer)
Route to VMS if: ${c.knockouts.vms.join(", ")} or 10+ identical roles
Route to Worksome if: ${c.knockouts.worksome.join(", ")}
After a knockout, still proceed to Phase 2 enrichment.

## Scoring
Deliverable/ongoing: wt ${c.weights.deliverable_or_ongoing} | Duration: wt ${c.weights.duration} | Headcount: wt ${c.weights.headcount} | Payment: wt ${c.weights.payment_model} | SDC: wt ${c.weights.sdc}
Route clear if one side ≥ 5. Ambiguous if diff ≤ 1 → ask tiebreakers.

## Phase 2: Enrichment (gather details to set up the role)

Once you know the route, transition with something like: "Great — I know exactly where to send this. Just a few more details so I can get everything set up for you."

Then ask these questions ONE AT A TIME. Skip any that were already clearly answered during Phase 1:

E1: "Can you give me a quick summary of what this person will be doing?" (if not already covered by Q2)
E2: "What skills or experience are most important for this role?"
E3: "Will this be remote, on-site, or hybrid?"
E4: "Do you have a budget or rate range in mind?" (if they say no or seem unsure, that's fine — just move on)

You do NOT need to ask all of these — skip any that were already answered. The goal is to collect enough to create a useful job listing. Once you have at least a description and skills, you can proceed to output.

## VMS Provider
The VMS for this client is: ${c.vms.name}

## Output
When you have the routing decision AND the enrichment details, respond with your confirmation message, then on a NEW LINE output EXACTLY this JSON block (the system will parse it):
\`\`\`json
{"route":"worksome_or_vms","confidence":"high_or_medium","role_title":"...","description":"A clear 2-3 sentence job description based on what the manager told you","skills":["skill1","skill2","skill3"],"known_worker":true_or_false,"worker_name":"...or_null","worker_first_name":"...or_null","worker_last_name":"...or_null","worker_email":"...or_null","worker_id":"...or_null","worker_found":true_or_false_or_null,"worker_country":"...or_null","worker_skills":["skill1","skill2"],"sdc_present":true_or_false_or_null,"headcount":1,"duration":"...","payment_model":"hourly_or_milestone_or_daily_or_unknown","location":"remote_or_onsite_or_hybrid","start_date":"...or_asap_or_null","budget":"...or_null"}
\`\`\`

## Rules
1. One question at a time. Never stack questions.
2. Keep messages to 1-3 sentences.
3. Never mention Worksome, ${c.vms.name}, SDC, scoring, or routing to the manager.
4. Never use procurement jargon.
5. Be conversational — like a helpful colleague, not a form.
6. When confirming the route, say: "Perfect — I've got everything I need. I'm setting this up for you now."
7. Do NOT output the JSON until Phase 2 is complete. The system needs the enrichment data to create the job.`;
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

    // Worker not found but details collected — API should have invited them and returned hire URL
    const isNewWorker = isWorksome && routeResult.worker_found === false && routeResult.worker_email;
    if (isNewWorker && routeResult._handoff && routeResult._handoff.job_url && routeResult._handoff.worker_id) {
      url = routeResult._handoff.job_url;
    } else if (isNewWorker) {
      url = config.worksome_talent_pool_url;
    }
    // Worker not found and no details — redirect to talent pool
    else if (isWorksome && routeResult.worker_found === false && !routeResult.worker_email) {
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
        // Add assistant ack + system result to maintain alternating roles
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
      const reply = await callClaude(userId);
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
          const handoff = await worksome.handoff(routeResult);
          routeResult._handoff = handoff;
        } catch (err) {
          console.warn("[Slack] Worksome handoff failed (non-fatal):", err.message);
        }
      }

      await client.chat.postMessage({ channel: message.channel, text: clean, blocks: buildBlocks(clean, quickReplies, routeResult) });
      if (routeResult) sessions.delete(userId);
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
      const reply = await callClaude(userId);
      const routeResult = parseRoute(reply);
      const clean = cleanReply(reply);
      const quickReplies = routeResult ? null : detectQuickReplies(clean);
      history.push({ role: "assistant", content: reply });

      // Check if Claude is asking for the worker's name
      if (!routeResult && isAskingForName(clean)) {
        waitingForName.add(userId);
      }

      // Attempt Worksome handoff if routed there
      if (routeResult && routeResult.route === "worksome") {
        try {
          const handoff = await worksome.handoff(routeResult);
          routeResult._handoff = handoff;
        } catch (err) {
          console.warn("[Slack] Worksome handoff failed (non-fatal):", err.message);
        }
      }

      await client.chat.postMessage({ channel, text: clean, blocks: buildBlocks(clean, quickReplies, routeResult) });
      if (routeResult) { sessions.delete(userId); waitingForName.delete(userId); }
    } catch (err) {
      console.error("Claude API error:", err.message);
      await client.chat.postMessage({ channel, text: "Something went wrong — please try again or type `/hire` to restart." });
    }
  });

  app.action("open_destination", async ({ ack }) => { await ack(); });
};
