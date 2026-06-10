// Tests for routing.js and config-store.js — run with: node test-routing.js
const assert = require("assert");
const routing = require("./routing");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "—", e.message); process.exitCode = 1; }
}

console.log("routing.checkReply:");

t("no JSON block → no route, no retry", () => {
  const r = routing.checkReply("What's their first name?");
  assert.strictEqual(r.hasRoute, false);
  assert.strictEqual(r.needsRetry, false);
});

t("valid route JSON → normalized route", () => {
  const r = routing.checkReply('Perfect — setting this up.\n```json\n{"route":"worksome","confidence":"high","role_title":"Designer","skills":["Figma"],"headcount":"2","payment_model":"hourly"}\n```');
  assert.strictEqual(r.hasRoute, true);
  assert.strictEqual(r.route.route, "worksome");
  assert.strictEqual(r.route.headcount, 2); // coerced from string
  assert.strictEqual(r.route.payment_model, "hourly");
  assert.ok(r.text.includes("```json"));
  assert.ok(r.prose.startsWith("Perfect"));
});

t("truncated JSON (no closing fence) → needsRetry", () => {
  const r = routing.checkReply('All set!\n```json\n{"route":"worksome","role_title":"Dev');
  assert.strictEqual(r.hasRoute, false);
  assert.strictEqual(r.needsRetry, true);
  assert.ok(r.reason.includes("truncated"));
  assert.strictEqual(r.prose, "All set!");
});

t("malformed JSON → needsRetry", () => {
  const r = routing.checkReply('Done.\n```json\n{route: worksome,}\n```');
  assert.strictEqual(r.needsRetry, true);
});

t("invalid route value → needsRetry", () => {
  const r = routing.checkReply('Done.\n```json\n{"route":"beeline","role_title":"Dev"}\n```');
  assert.strictEqual(r.needsRetry, true);
  assert.ok(r.reason.includes("route must be"));
});

t("defaults applied: missing headcount/confidence/title", () => {
  const r = routing.checkReply('```json\n{"route":"vms"}\n```');
  assert.strictEqual(r.hasRoute, true);
  assert.strictEqual(r.route.headcount, 1);
  assert.strictEqual(r.route.confidence, "medium");
  assert.strictEqual(r.route.role_title, "New Role");
});

t("boolean coercion from strings", () => {
  const r = routing.checkReply('```json\n{"route":"worksome","known_worker":"true","worker_found":"false"}\n```');
  assert.strictEqual(r.route.known_worker, true);
  assert.strictEqual(r.route.worker_found, false);
});

t("bogus payment model → unknown", () => {
  const r = routing.checkReply('```json\n{"route":"worksome","payment_model":"equity"}\n```');
  assert.strictEqual(r.route.payment_model, "unknown");
});

console.log("config-store.sanitize (via update/get):");
const store = require("./config-store");

t("defaults load", () => {
  const c = store.get();
  assert.strictEqual(typeof c.assistant_name, "string");
  assert.ok(Array.isArray(c.knockouts.vms));
});

t("update merges + clamps weights", () => {
  const c = store.update({ vms: { name: "Fieldglass" }, weights: { duration: 99 } });
  assert.strictEqual(c.vms.name, "Fieldglass");
  assert.strictEqual(c.weights.duration, 5); // clamped to max
  assert.strictEqual(c.weights.headcount, 2); // untouched
});

t("garbage input ignored, shape preserved", () => {
  const c = store.update({ knockouts: { vms: [123, {x:1}, "agency"] }, evil_key: "x", branding: { primary_color: 42 } });
  assert.deepStrictEqual(c.knockouts.vms, ["agency"]);
  assert.strictEqual("evil_key" in c, false);
  assert.strictEqual(typeof c.branding.primary_color, "string");
});

t("reset restores defaults", () => {
  const c = store.reset();
  assert.strictEqual(c.vms.name, "Beeline");
});

console.log("analytics.computeAnalytics:");
const { computeAnalytics, weekLabel } = require("./analytics");

t("empty log → zeroed stats with week buckets", () => {
  const a = computeAnalytics([], []);
  assert.strictEqual(a.total, 0);
  assert.strictEqual(a.avgDurationSeconds, null);
  assert.ok(a.weeklyVolume.length >= 1);
  assert.strictEqual(a.recent.length, 0);
});

t("aggregates routes, durations, and handoff status", () => {
  const now = new Date().toISOString();
  const intakes = [
    { id: "a1", ts: now, route: "worksome", role_title: "Designer", confidence: "high", channel: "web", duration_seconds: 40 },
    { id: "a2", ts: now, route: "vms", role_title: "Temps", confidence: "high", channel: "slack", manager: "U123", duration_seconds: 80 },
    { id: "a3", ts: now, route: "worksome", role_title: "Dev", confidence: "medium", channel: "web", duration_seconds: null },
  ];
  const handoffs = [{ intakeId: "a1", job_id: "J9" }, { intakeId: "a3", job_id: null }];
  const a = computeAnalytics(intakes, handoffs);
  assert.strictEqual(a.total, 3);
  assert.strictEqual(a.worksome, 2);
  assert.strictEqual(a.vms, 1);
  assert.strictEqual(a.avgDurationSeconds, 60);
  const byId = Object.fromEntries(a.recent.map(r => [r.id, r]));
  assert.strictEqual(byId.a1.status, "job_created");
  assert.strictEqual(byId.a3.status, "routed"); // handoff without job_id doesn't count
  assert.strictEqual(byId.a2.manager, "U123");
  const thisWeek = a.weeklyVolume[a.weeklyVolume.length - 1];
  assert.strictEqual(thisWeek.worksome, 2);
  assert.strictEqual(thisWeek.vms, 1);
});

t("weekLabel produces W-prefixed ISO week", () => {
  assert.ok(/^W\d{1,2}$/.test(weekLabel(new Date())));
});

console.log("approval.evaluateGates:");
const { evaluateGates, parseAmount, durationToMonths } = require("./approval");

t("spend gate triggers on budget text with k-suffix", () => {
  const gate = evaluateGates(
    [{ condition: "spend > 100000", action: "procurement_review" }],
    { route: "worksome", budget: "£120k" }
  );
  assert.ok(gate);
  assert.strictEqual(gate.action, "procurement_review");
});

t("spend gate does not trigger below threshold or with no budget", () => {
  const gates = [{ condition: "spend > 100000", action: "procurement_review" }];
  assert.strictEqual(evaluateGates(gates, { budget: "50,000 EUR" }), null);
  assert.strictEqual(evaluateGates(gates, { budget: null }), null); // missing data never blocks
});

t("headcount and duration gates", () => {
  assert.ok(evaluateGates([{ condition: "headcount >= 5", action: "review" }], { headcount: 6 }));
  assert.ok(evaluateGates([{ condition: "duration_months > 11", action: "ir35_review" }], { duration: "1 year" }));
  assert.strictEqual(evaluateGates([{ condition: "duration_months > 11", action: "x" }], { duration: "6 weeks" }), null);
});

t("string gates: route equality", () => {
  assert.ok(evaluateGates([{ condition: "route == vms", action: "vms_check" }], { route: "vms" }));
  assert.strictEqual(evaluateGates([{ condition: "route == vms", action: "x" }], { route: "worksome" }), null);
});

t("unparseable conditions and unknown fields are skipped", () => {
  assert.strictEqual(evaluateGates([{ condition: "??!", action: "x" }, { condition: "favourite_color == red", action: "x" }], { headcount: 99 }), null);
});

t("parseAmount and durationToMonths helpers", () => {
  assert.strictEqual(parseAmount("£1.5m"), 1500000);
  assert.strictEqual(parseAmount("100,000"), 100000);
  assert.strictEqual(durationToMonths("3 months"), 3);
  assert.strictEqual(durationToMonths("2 years"), 24);
});

t("analytics marks pending_approval", () => {
  const now = new Date().toISOString();
  const a = computeAnalytics([{ id: "p1", ts: now, route: "worksome", role_title: "X", approval_required: "procurement_review" }], []);
  assert.strictEqual(a.recent[0].status, "pending_approval");
});

console.log("beeline-mapper:");
const { buildRequisition } = require("./beeline-mapper");

t("maps a routed decision to a requisition", () => {
  const { requisition: q } = buildRequisition({
    role_title: "Java Developers", description: "Backend team support",
    skills: ["Java", "Spring"], headcount: 5, duration: "6 months",
    payment_model: "hourly", location: "hybrid", confidence: "high",
    budget: "£90k", _intakeId: "i1",
  }, { now: "2026-06-10T00:00:00Z" });
  assert.strictEqual(q.title, "Java Developers");
  assert.strictEqual(q.requisitionType, "STAFF_AUG");
  assert.strictEqual(q.numberOfPositions, 5);
  assert.strictEqual(q.rateType, "HOURLY");
  assert.strictEqual(q.jobCategory, "Java");
  assert.strictEqual(q.startDate, "2026-06-10");
  assert.strictEqual(q.endDate, "2026-12-07"); // ~6 months
  assert.strictEqual(q.maxBillRate, 90000);
  assert.strictEqual(q.location.remoteAllowed, true);
  assert.strictEqual(q.approvalStatus, "APPROVED");
  assert.strictEqual(q.metadata.intake_session_id, "i1");
});

t("milestone payment → SOW; on-site → no remote; approval flag respected", () => {
  const { requisition: q } = buildRequisition(
    { role_title: "X", payment_model: "milestone", location: "onsite" },
    { approvalRequired: true }
  );
  assert.strictEqual(q.requisitionType, "SOW");
  assert.strictEqual(q.location.remoteAllowed, false);
  assert.strictEqual(q.approvalStatus, "PENDING_APPROVAL");
});

console.log("worksome-client payload builders:");
const ws = require("./worksome-client");

t("trusted contact candidate includes externalIdentifier from intake", () => {
  const c = ws.buildTrustedContactCandidate({
    worker_first_name: "Maria", worker_last_name: "Lopez",
    worker_email: "maria@example.com", _intakeId: "abc123",
  }, "ACC1");
  assert.strictEqual(c.firstName, "Maria");
  assert.strictEqual(c.email, "maria@example.com");
  assert.strictEqual(c.externalIdentifier, "frontdoor:abc123");
  assert.strictEqual(c.account, "ACC1");
});

t("filterInput drops unknown fields and undefined values", () => {
  const filtered = ws.filterInput(
    { firstName: "M", email: "m@x.com", account: "A", accounts: ["A"], company: "A", externalIdentifier: undefined },
    ["firstName", "lastName", "email", "company"] // schema only accepts these
  );
  assert.deepStrictEqual(filtered, { firstName: "M", email: "m@x.com", company: "A" });
});

t("filterInput passes everything through when schema unknown", () => {
  const filtered = ws.filterInput({ a: 1, b: undefined, c: "x" }, null);
  assert.deepStrictEqual(filtered, { a: 1, c: "x" });
});

t("draft hire candidate offers both field-name conventions", () => {
  const c = ws.buildDraftHireCandidate("J1", "W1");
  assert.strictEqual(c.job, "J1");
  assert.strictEqual(c.workerId, "W1");
});

t("job candidate + milestone scaffold builders", () => {
  const jc = ws.buildJobCandidateCandidate("J1", "W1");
  assert.strictEqual(jc.worker, "W1");
  const ms = ws.buildMilestonesCandidate(
    { role_title: "Designer", duration: "2 months", budget: "£10k" },
    { jobId: "J1", now: "2026-06-10T00:00:00Z" }
  );
  assert.strictEqual(ms.job, "J1");
  assert.strictEqual(ms.milestones.length, 1);
  assert.strictEqual(ms.milestones[0].amount, 10000);
  assert.strictEqual(ms.milestones[0].dueDate, "2026-08-09");
  assert.ok(ms.milestones[0].title.includes("Designer"));
});

console.log("prompt unification:");
const { buildSystemPrompt: buildPrompt } = require("./prompt");
const promptCfg = require("./config-store").get();

t("web and slack prompts share content, differ only in formatting", () => {
  const web = buildPrompt(promptCfg, { channel: "web" });
  const slack = buildPrompt(promptCfg, { channel: "slack" });
  assert.ok(web.includes("**Found:**"));
  assert.ok(slack.includes("*Found:*") && !slack.includes("**Found:**"));
  for (const p of [web, slack]) {
    assert.ok(p.includes("[TALENT_SEARCH:"));
    assert.ok(p.includes('"route":"worksome_or_vms"'));
    assert.ok(p.includes("GitHub"));
    assert.ok(p.includes(promptCfg.vms.name));
    assert.ok(p.includes(`weight: ${promptCfg.weights.duration}`));
  }
});

console.log("event-log:");
const eventLog = require("./event-log");

t("append assigns id+ts and persists across re-open", () => {
  const log = eventLog.open("test-tmp");
  const before = log.all().length;
  const rec = log.append({ type: "x", val: 1 });
  assert.ok(rec.id && rec.ts);
  assert.strictEqual(log.all().length, before + 1);
  // Re-read from disk via a fresh instance
  const fresh = new (require("./event-log").open("test-tmp").constructor)("test-tmp");
  assert.strictEqual(fresh.all().length, before + 1);
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
