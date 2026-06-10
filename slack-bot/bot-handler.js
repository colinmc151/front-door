// Slack bot handler — imported by server.js
// The Slack App and Gemini client are passed in from the server
const worksome = require("../worksome-client");
const configStore = require("../config-store");
const routing = require("../routing");
const approval = require("../approval");
const githubClient = require("../github-client");
const { buildExternalTalentLead } = require("../github-scoring");
const { scoreWorker } = require("../worksome-scoring");

// Live config: the server-side store is the source of truth (same config
// the web portal edits); env vars override deployment-specific values.
function getConfig() {
  const c = configStore.get();
  return {
    assistant_name: process.env.ASSISTANT_NAME || c.assistant_name,
    vms: { name: process.env.VMS_NAME || c.vms.name },
    worksome_url: process.env.WORKSOME_URL || c.worksome_url,
    worksome_talent_pool_url: process.env.WORKSOME_TALENT_POOL_URL || c.worksome_talent_pool_url,
    vms_url: process.env.VMS_URL || c.vms.url,
    weights: c.weights,
    knockouts: c.knockouts,
  };
}

function buildSystemPrompt() {
  return require("../prompt").buildSystemPrompt(getConfig(), { channel: "slack" });
}

const sessions = new Map();          // userId → messages array
const sessionStarts = new Map();     // userId → intake start time (for audit duration)
const sessionTimestamps = new Map(); // userId → last active timestamp
const waitingForName = new Set();    // Track users in the "what's their name?" state
const SESSION_TTL = 30 * 60_000;     // 30 minutes

// Touch session timestamp on any access
const origSet = sessions.set.bind(sessions);
sessions.set = function(key, value) {
  sessionTimestamps.set(key, Date.now());
  return origSet(key, value);
};
const origGet = sessions.get.bind(sessions);
sessions.get = function(key) {
  sessionTimestamps.set(key, Date.now());
  return origGet(key);
};
const origDelete = sessions.delete.bind(sessions);
sessions.delete = function(key) {
  sessionTimestamps.delete(key);
  sessionStarts.delete(key);
  return origDelete(key);
};

// Clean up stale sessions every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [userId, ts] of sessionTimestamps) {
    if (ts < cutoff) {
      sessions.delete(userId);
      waitingForName.delete(userId);
      console.log(`[Slack] Expired session for user ${userId}`);
    }
  }
}, 300_000);

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
  if ((t.includes("remote") && t.includes("on-site")) || (t.includes("remote") && t.includes("hybrid")))
    return ["Remote", "On-site", "Hybrid"];
  if (t.includes("budget") && t.includes("rate") && t.includes("mind"))
    return ["I have a budget in mind", "No specific budget yet"];
  return null;
}

function buildBlocks(text, quickReplies, routeResult) {
  const config = getConfig();
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
    if (routeResult._approval) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:double_vertical_bar: *Approval required:* ${routeResult._approval.action}\n_Rule: ${routeResult._approval.condition}_ — your request is on hold until it's approved.`,
        },
      });
    } else {
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
  }

  return blocks;
}

// ─── Talent + GitHub discovery cards (Block Kit) ───────
function workerCardBlocks(workers) {
  const blocks = [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: ":busts_in_silhouette: *Talent pool matches*" } },
  ];
  for (const w of workers.slice(0, 3)) {
    const meta = [
      w.title || null,
      w.location || null,
      w.dayRate ? `${w.currency || ""} ${w.dayRate}/day`.trim() : null,
      w.isCurrentlyHired ? "on a hire" : ((w.totalPaid || 0) > 0 ? "previously engaged" : null),
    ].filter(Boolean).join(" · ");
    const skills = (w.skills || []).slice(0, 6).join(", ");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${w.name || "Unknown"}*  ·  Fit *${w.fitScore != null ? w.fitScore : "—"}/100*${meta ? `\n${meta}` : ""}${skills ? `\n_${skills}_` : ""}`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: `Choose ${(w.name || "worker").split(" ")[0]}`.slice(0, 75), emoji: true },
        action_id: `pick_worker_${w.id}`,
        value: JSON.stringify({ name: w.name, id: w.id }).slice(0, 2000),
      },
    });
  }
  return blocks;
}

function githubCardBlocks(leads) {
  const blocks = [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: ":octopus: *External GitHub profiles* — public technical work matching your brief" } },
  ];
  for (const lead of leads.slice(0, 3)) {
    const langs = (lead.topLanguages || []).slice(0, 4).join(", ");
    const repo = (lead.relevantRepositories || [])[0];
    const lines = [
      `*<${lead.githubProfileUrl}|${lead.displayName || lead.githubLogin}>*  ·  Fit *${lead.fitScore}/100*`,
      lead.bio ? lead.bio.slice(0, 100) : null,
      langs ? `_${langs}_` : null,
      repo ? `↳ <${repo.url}|${repo.name.split("/").pop()}>${repo.stars ? ` · ${repo.stars}★` : ""}` : null,
    ].filter(Boolean);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Draft invite", emoji: true },
        action_id: `gh_invite_${lead.githubLogin}`,
        value: JSON.stringify({ login: lead.githubLogin, name: lead.displayName, skills: (lead.inferredSkills || lead.topLanguages || []).slice(0, 4) }).slice(0, 2000),
      },
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Public GitHub data only — no contact info is shared until the candidate creates a Worksome profile." }] });
  return blocks;
}

function parseRoute(text) {
  const check = routing.checkReply(text);
  return check.hasRoute ? check.route : null;
}

function cleanReply(text) {
  return text.replace(/```json[\s\S]*?(?:```|$)/, "").trim();
}

// ─── Register handlers on a Slack App instance ────────
module.exports.register = function (app, gemini, auditLog) {
  // Record a completed routing decision in the shared audit log
  function recordIntake(userId, routeResult) {
    if (!auditLog) return;
    const startedAt = sessionStarts.get(userId);
    const rec = auditLog.append({
      type: "intake_routed",
      channel: "slack",
      manager: userId,
      route: routeResult.route,
      confidence: routeResult.confidence,
      role_title: routeResult.role_title,
      known_worker: routeResult.known_worker,
      headcount: routeResult.headcount,
      payment_model: routeResult.payment_model,
      location: routeResult.location,
      skills: routeResult.skills,
      turns: (sessions.get(userId) || []).length,
      approval_required: routeResult._approval ? routeResult._approval.action : null,
      duration_seconds: startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 1000)) : null,
    });
    routeResult._intakeId = rec.id;
    console.log(`[Audit] Slack intake routed → ${routeResult.route} (${routeResult.role_title}) [${rec.id}]`);
  }
  // Convert messages to Gemini format
  function toGeminiMessages(messages) {
    return messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text || m.content || '' }],
    }));
  }

  async function callGemini(userId) {
    const messages = sessions.get(userId) || [];
    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: toGeminiMessages(messages),
      config: {
        systemInstruction: buildSystemPrompt(),
        maxOutputTokens: 1500,
      },
    });
    return response.text || "";
  }

  // Call with an explicit message array (for follow-up calls)
  async function callGeminiWithMessages(msgArray) {
    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: toGeminiMessages(msgArray),
      config: {
        systemInstruction: buildSystemPrompt(),
        maxOutputTokens: 1500,
      },
    });
    return response.text || "";
  }

  // ─── Shared reply processing (used by both message + quick_reply) ───
  async function processReply(userId, channel, client) {
    const history = sessions.get(userId);
    let reply = await callGemini(userId);

    // Validate any routing JSON; one corrective retry on malformed/truncated output
    const chk = routing.checkReply(reply);
    if (chk.needsRetry) {
      console.warn(`[Slack] Invalid routing JSON (${chk.reason}) — retrying once`);
      try {
        const fixed = await callGeminiWithMessages([
          ...(sessions.get(userId) || []),
          { role: "assistant", content: reply },
          { role: "user", content: routing.retryInstruction(chk.reason) },
        ]);
        const fixedChk = routing.checkReply(fixed);
        if (fixedChk.hasRoute) {
          reply = (chk.prose ? chk.prose + "\n\n" : "") +
            "```json\n" + JSON.stringify(fixedChk.route) + "\n```";
        } else {
          reply = chk.prose || reply;
        }
      } catch (e) {
        console.warn("[Slack] Routing retry failed:", e.message);
        reply = chk.prose || reply;
      }
    }

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

      // Search talent pool + GitHub in parallel
      const skillNames = skillsText.split(',').map(s => s.trim()).filter(Boolean);
      let workers = [];
      let resolved = [];
      let ghLeads = [];

      const ghCriteria = { skills: skillNames, languages: [], keywords: skillNames, location: null, maxResults: 3 };
      const [wsResult, ghProfiles] = await Promise.all([
        worksome.searchWorkersBySkills(skillNames).catch(err => {
          console.warn("[Slack] Skill search failed:", err.message);
          return { workers: [], resolvedSkills: [] };
        }),
        githubClient.discoverTalent(ghCriteria).catch(err => {
          console.warn("[Slack] GitHub discovery failed:", err.message);
          return [];
        }),
      ]);

      // Score + rank internal matches (same engine as the web portal)
      const criteria = { skills: skillNames, keywords: skillNames };
      workers = (wsResult.workers || []).map(w => scoreWorker(w, criteria)).sort((a, b) => b.fitScore - a.fitScore);
      resolved = wsResult.resolvedSkills || [];
      ghLeads = ghProfiles.map(p => buildExternalTalentLead(p, ghCriteria)).sort((a, b) => b.fitScore - a.fitScore).slice(0, 3);

      const skillSummary = resolved.map(s => s.name).join(', ') || skillsText;

      // Post talent cards (internal first, then external)
      if (workers.length > 0) {
        await client.chat.postMessage({ channel, text: "Talent pool matches", blocks: workerCardBlocks(workers) });
      }
      if (ghLeads.length > 0) {
        await client.chat.postMessage({ channel, text: "External GitHub profiles", blocks: githubCardBlocks(ghLeads) });
      }

      // Build follow-up message array with results
      history.push({ role: "assistant", content: reply });
      let followUpMsg;

      const ghNote = ghLeads.length > 0
        ? ` I've also posted ${ghLeads.length} external GitHub profile card(s) with relevant public work — the manager can review them and draft invites from the cards.`
        : '';

      if (workers.length > 0) {
        const workerList = workers.map(w =>
          `- ${w.name}${w.title ? ` (${w.title})` : ''}${w.skills && w.skills.length > 0 ? ` | Skills: ${w.skills.join(', ')}` : ''} [ID: ${w.id}]`
        ).join('\n');
        followUpMsg = `[SYSTEM: Talent pool search for skills "${skillSummary}" found these workers (cards already posted in the thread):\n${workerList}\n\nScore each worker out of 10 based on how well their skills and title match the project requirements you just described. Present results as a ranked list with name, title, skills, score out of 10, and a brief reason.${ghNote} Then ask if the manager wants to hire one of them — they can also tap the Choose button on a card. IMPORTANT: Include the worker's ID in worker_id in the final JSON if they pick someone.]`;
      } else if (ghLeads.length > 0) {
        followUpMsg = `[SYSTEM: Talent pool search for skills "${skillSummary}" found no internal matches, but I've posted ${ghLeads.length} external GitHub profile card(s) with relevant public work. Tell the manager you didn't find anyone in their talent pool yet, but there are external GitHub profiles below they can review and invite to Worksome. Also offer to set up the role. Continue to Path B2 Q3 onward — you already have the project description and skills.]`;
      } else {
        followUpMsg = `[SYSTEM: Talent pool search for skills "${skillSummary}" found no matches. Tell the manager you didn't find anyone with those skills in their talent pool yet. Offer to set up the role so they can find the right person. Continue to Path B2 Q3 onward — you already have the project description and skills.]`;
      }

      history.push({ role: "user", content: followUpMsg });

      // Second Gemini call with talent pool results
      const followUpReply = await callGeminiWithMessages(history);
      const routeResult = parseRoute(followUpReply);
      const followUpClean = cleanReply(followUpReply);
      const quickReplies = routeResult ? null : detectQuickReplies(followUpClean);
      history.push({ role: "assistant", content: followUpReply });

      if (routeResult) {
        const gate = approval.evaluateGates(configStore.get().approval_gates, routeResult);
        if (gate) routeResult._approval = gate;
        recordIntake(userId, routeResult);
      }

      // Attempt Worksome handoff if routed (held when an approval gate fires)
      if (routeResult && routeResult.route === "worksome" && !routeResult._approval) {
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

    // Check if the assistant is now asking for the worker's name
    if (!routeResult && isAskingForName(clean)) {
      waitingForName.add(userId);
    }
    history.push({ role: "assistant", content: reply });

    if (routeResult) {
      const gate = approval.evaluateGates(configStore.get().approval_gates, routeResult);
      if (gate) routeResult._approval = gate;
      recordIntake(userId, routeResult);
    }

    // Attempt Worksome handoff if routed there (held when an approval gate fires)
    if (routeResult && routeResult.route === "worksome" && !routeResult._approval) {
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
    const greeting = `${getConfig().assistant_name}\n\nHi! I'm here to help you find the right talent. Let's get started.\n\nDo you already know who you'd like to work with?`;
    sessions.set(userId, [{ role: "assistant", content: greeting }]);
    sessionStarts.set(userId, Date.now());
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
      // Only nudge in DMs — stay silent in channels the bot happens to be in
      if (message.channel_type === 'im') {
        await client.chat.postMessage({ channel: message.channel, text: 'Type `/hire` to start a new hiring request.' });
      }
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
          const workerList = workers.map(w => `- ${w.name}${w.title ? ` (${w.title})` : ''} [ID: ${w.id}]`).join('\n');
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
      console.error("Gemini API error:", err.message);
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
      console.error("Gemini API error:", err.message);
      await client.chat.postMessage({ channel, text: "Something went wrong — please try again or type `/hire` to restart." });
    }
  });

  // "Choose <worker>" button on a talent card — feeds the pick back into the conversation
  app.action(/^pick_worker_/, async ({ action, body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    const channel = body.channel.id;
    if (!sessions.has(userId)) {
      await client.chat.postMessage({ channel, text: 'That session has ended. Type `/hire` to start a new one.' });
      return;
    }
    let v = {};
    try { v = JSON.parse(action.value); } catch {}
    const text = `I'd like to hire ${v.name || 'this worker'}`;
    await client.chat.postMessage({ channel, text: `You chose: ${v.name || 'a worker'}`, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `↳ *${text}*` }] }] });
    const history = sessions.get(userId);
    history.push({ role: "user", content: `${text}${v.id ? ` [worker_id: ${v.id}]` : ''}` });
    try {
      await processReply(userId, channel, client);
    } catch (err) {
      console.error("Gemini API error:", err.message);
      await client.chat.postMessage({ channel, text: "Something went wrong — please try again or type `/hire` to restart." });
    }
  });

  // "Draft invite" button on a GitHub card — posts a copy-ready invite message
  app.action(/^gh_invite_/, async ({ action, body, ack, client }) => {
    await ack();
    const channel = body.channel.id;
    let v = {};
    try { v = JSON.parse(action.value); } catch {}
    if (!v.login) return;
    const cfg = getConfig();
    const firstName = (v.name || v.login).split(" ")[0];
    const skills = (v.skills || []).join(", ");
    const inviteLink = `${cfg.worksome_url.replace("/login", "")}/invite/gh/${v.login}`;
    const msg = `Hi ${firstName},\n\nI came across your public GitHub work and thought your experience with ${skills || "your stack"} could be relevant for a freelance opportunity with our team.\n\nThe role would be managed through Worksome for contracting, compliance, and payment.\n\nIf you're open to hearing more, you can create a Worksome profile here and I'll send you the job to review:\n${inviteLink}\n\nBest,\nThe hiring team`;
    await client.chat.postMessage({
      channel,
      text: `Invite draft for @${v.login}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Invite draft for <https://github.com/${v.login}|@${v.login}>* — copy, personalise, and send:` } },
        { type: "section", text: { type: "mrkdwn", text: "```" + msg + "```" } },
      ],
    });
  });

  app.action("open_destination", async ({ ack }) => { await ack(); });
};
