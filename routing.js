// Routing decision extraction + validation.
// The model emits a ```json block at the end of an intake conversation.
// This module finds it, validates/normalizes it, and detects the failure
// modes that previously lost routes silently (malformed or truncated JSON).

const VALID_ROUTES = new Set(["worksome", "vms"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_PAYMENT = new Set(["hourly", "daily", "milestone", "fixed", "unknown"]);

const toStr = v => (typeof v === "string" && v.trim() ? v.trim() : null);
const toBool = v => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null);
const toStrArr = v => (Array.isArray(v) ? v.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : []);

// Validate + normalize a parsed route object.
// Returns { ok: true, value } or { ok: false, reason }.
function validateRoute(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not an object" };

  const route = toStr(obj.route);
  if (!route || !VALID_ROUTES.has(route)) {
    return { ok: false, reason: `route must be "worksome" or "vms" (got ${JSON.stringify(obj.route)})` };
  }

  const headcount = parseInt(obj.headcount, 10);
  const payment = toStr(obj.payment_model);

  const value = {
    route,
    confidence: VALID_CONFIDENCE.has(toStr(obj.confidence)) ? obj.confidence : "medium",
    role_title: toStr(obj.role_title) || "New Role",
    description: toStr(obj.description),
    skills: toStrArr(obj.skills),
    known_worker: toBool(obj.known_worker) || false,
    worker_name: toStr(obj.worker_name),
    worker_first_name: toStr(obj.worker_first_name),
    worker_last_name: toStr(obj.worker_last_name),
    worker_email: toStr(obj.worker_email),
    worker_id: toStr(obj.worker_id),
    worker_found: toBool(obj.worker_found),
    worker_country: toStr(obj.worker_country),
    worker_skills: toStrArr(obj.worker_skills),
    sdc_present: toBool(obj.sdc_present),
    headcount: Number.isFinite(headcount) && headcount > 0 ? headcount : 1,
    duration: toStr(obj.duration),
    payment_model: VALID_PAYMENT.has(payment) ? payment : "unknown",
    location: toStr(obj.location),
    budget: toStr(String(obj.budget ?? "")) === "null" ? null : (toStr(obj.budget) || null),
  };

  return { ok: true, value };
}

// Inspect a full model reply.
// Returns:
//   { hasRoute: false, needsRetry: false }                       — no JSON block at all
//   { hasRoute: false, needsRetry: true, reason, prose }         — block present but broken/truncated/invalid
//   { hasRoute: true, needsRetry: false, route, prose, text }    — valid; `text` is prose + normalized JSON block
function checkReply(reply) {
  const text = reply || "";
  const opens = text.includes("```json");

  if (!opens) return { hasRoute: false, needsRetry: false };

  const match = text.match(/```json\s*([\s\S]*?)```/);
  const prose = text.replace(/```json[\s\S]*$/, "").trim(); // everything before the (possibly broken) block

  if (!match) {
    // Opened a json fence but never closed it — classic token-cap truncation
    return { hasRoute: false, needsRetry: true, reason: "JSON block is truncated (no closing fence)", prose };
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (e) {
    return { hasRoute: false, needsRetry: true, reason: `JSON does not parse (${e.message})`, prose };
  }

  const result = validateRoute(parsed);
  if (!result.ok) {
    return { hasRoute: false, needsRetry: true, reason: result.reason, prose };
  }

  const normalizedBlock = "```json\n" + JSON.stringify(result.value) + "\n```";
  const cleanProse = text.replace(/```json[\s\S]*?```/, "").trim();
  return {
    hasRoute: true,
    needsRetry: false,
    route: result.value,
    prose: cleanProse,
    text: cleanProse + "\n\n" + normalizedBlock,
  };
}

// Message appended to the conversation when asking the model to fix its JSON.
function retryInstruction(reason) {
  return `[SYSTEM: The JSON block in your last message was invalid — ${reason}. Re-send your confirmation sentence followed by a single corrected \`\`\`json block. The JSON must include "route" ("worksome" or "vms") and follow the schema exactly. Output nothing else.]`;
}

module.exports = { checkReply, validateRoute, retryInstruction };
