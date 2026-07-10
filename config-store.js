// Server-side config store — single source of truth for routing config,
// branding, and education content. Persisted to data/config.json with
// atomic writes; falls back to defaults when no file exists.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// Env overrides — allow per-deployment defaults so multiple Railway services
// can share this codebase (documented in .env.example). A saved
// data/config.json still takes precedence over these defaults.
const ENV_VMS_NAME = process.env.VMS_NAME || "Beeline";
const ENV_VMS_URL = process.env.VMS_URL || "https://beeline.com";

const DEFAULTS = {
  client_name: process.env.CLIENT_NAME || "Worksome",
  assistant_name: process.env.ASSISTANT_NAME || "Worksome Hiring Hub",
  branding: {
    logo_text: process.env.LOGO_TEXT || "W",
    primary_color: process.env.PRIMARY_COLOR || "#1a1d23",
    greeting: process.env.GREETING || "Hi! I'm here to help you find the right talent. Let's get started.",
    logo_url: process.env.LOGO_URL || "",
    hero_image_url: process.env.HERO_IMAGE_URL || "",
    headline: process.env.HEADLINE || "",
    subheadline: process.env.SUBHEADLINE || "",
  },
  vms: { name: ENV_VMS_NAME, url: ENV_VMS_URL, api_type: "REST" },
  // GitHub external talent discovery (set GITHUB_DISCOVERY=false to disable)
  github_discovery: !/^(0|false|off)$/i.test(process.env.GITHUB_DISCOVERY || ""),
  worksome_url: process.env.WORKSOME_URL || "https://sandbox.worksome.com/login",
  worksome_talent_pool_url: process.env.WORKSOME_TALENT_POOL_URL || "https://sandbox.worksome.com/contacts",
  weights: { deliverable_or_ongoing: 3, duration: 2, headcount: 2, payment_model: 1, sdc: 1 },
  knockouts: {
    // VMS_KNOCKOUTS_EXTRA: comma-separated terms appended per deployment
    // (e.g. "maternity cover, paternity cover, sick leave cover")
    vms: [
      "agency", "staffing firm", "temp workers", "temps",
      ...(process.env.VMS_KNOCKOUTS_EXTRA || "").split(",").map((s) => s.trim()).filter(Boolean),
    ],
    worksome: ["freelancer", "independent consultant", "sow", "statement of work", "fixed bid", "milestone payment"],
  },
  approval_gates: [{ condition: "spend > 100000", action: "procurement_review" }],
  education: {
    policies: [
      { title: "Classification before engagement", body: "Every contractor must have a completed status assessment before work begins. For UK engagements, this means an IR35 determination (PSC) or employment status analysis (sole trader). For US engagements, federal and state classification review is required. Worksome handles this as part of onboarding — no contractor may start without it." },
      { title: "Contract and practice must align", body: "The way you work with a contractor must match what the contract says. Do not include contractors in performance reviews, employee benefits, bonus schemes, or equity plans. Do not direct their daily schedule or provide company equipment. If the scope of work materially changes, a status reassessment is triggered automatically in Worksome." },
      { title: "Misclassification risk", body: "Getting classification wrong can result in backdated tax, penalties, and employment claims. In the UK, failure to exercise \"reasonable care\" on IR35 transfers tax liability to your company. In the US, states like California apply strict ABC tests where the worker is presumed to be an employee unless specific conditions are met. Worksome manages this risk — but your working practices need to support the classification." },
      { title: "Long-term engagement reviews", body: "Engagements that run for extended periods are subject to periodic reassessment. The longer a contractor works with you, the higher the risk of employment status drift. Worksome tracks engagement duration and flags reviews automatically. If you need ongoing support beyond 12 months, discuss renewal with your procurement team." },
      { title: "When to use each channel", body: `Use Worksome for independent contractors, freelancers, and consultants engaged on defined projects or deliverables. Use ${ENV_VMS_NAME} for temporary staff augmentation, agency workers, and roles where you manage day-to-day work directly. If in doubt, this intake tool will route you to the right place.` },
    ],
    guides: [
      { title: "Writing a great project brief", body: "Be specific about deliverables, not just skills. Instead of \"need a designer,\" say \"redesign our checkout flow to improve mobile conversion.\" Include timeline, budget range, and whether the work is remote or on-site. A clear brief leads to better talent matches and faster onboarding." },
      { title: "Working with contractors safely", body: "Treat contractors as independent partners, not employees. Define outcomes and deliverables rather than dictating hours or methods. Do not include them in team stand-ups as mandatory attendees or put them on internal org charts. Keep supervision consistent with independent status — this protects both you and the contractor." },
      { title: "Onboarding a freelancer", body: "Once routed through Worksome, the contract, compliance checks, and payments are handled for you. Your part: provide a clear project brief, grant access to necessary tools or repos, schedule a kickoff meeting, and assign a primary point of contact on your team." },
      { title: "How the intake process works", body: "Describe what you need in plain language. The system asks a few quick questions to understand the type of work, then routes you to the right platform and creates a draft engagement. The whole process takes under 2 minutes. You can also use the AI project brief feature to search your talent pool for the best match." },
    ],
  },
};

// ─── Sanitizers ───────────────────────────────────────
const str = (v, fallback = "") => (typeof v === "string" ? v.slice(0, 2000) : fallback);
const strArr = (v, fallback = []) =>
  Array.isArray(v) ? v.filter(s => typeof s === "string").map(s => s.slice(0, 100)).slice(0, 50) : fallback;
const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const cardArr = (v, fallback = []) =>
  Array.isArray(v)
    ? v.filter(c => c && typeof c === "object").map(c => ({ title: str(c.title), body: str(c.body, "").slice(0, 4000) })).slice(0, 20)
    : fallback;

// Whitelist + coerce an incoming config object against current values.
function sanitize(input, current) {
  if (!input || typeof input !== "object") return current;
  const out = JSON.parse(JSON.stringify(current));

  if ("client_name" in input) out.client_name = str(input.client_name, current.client_name);
  if ("assistant_name" in input) out.assistant_name = str(input.assistant_name, current.assistant_name);
  if ("worksome_url" in input) out.worksome_url = str(input.worksome_url, current.worksome_url);
  if ("worksome_talent_pool_url" in input) out.worksome_talent_pool_url = str(input.worksome_talent_pool_url, current.worksome_talent_pool_url);

  if (input.branding && typeof input.branding === "object") {
    for (const k of ["logo_text", "primary_color", "greeting", "logo_url", "hero_image_url", "headline", "subheadline"]) {
      if (k in input.branding) out.branding[k] = str(input.branding[k], out.branding[k]);
    }
  }
  if (input.vms && typeof input.vms === "object") {
    if ("name" in input.vms) out.vms.name = str(input.vms.name, out.vms.name);
    if ("url" in input.vms) out.vms.url = str(input.vms.url, out.vms.url);
    if ("api_type" in input.vms) out.vms.api_type = str(input.vms.api_type, out.vms.api_type);
  }
  if ("github_discovery" in input) out.github_discovery = !!input.github_discovery;
  if (input.weights && typeof input.weights === "object") {
    for (const k of Object.keys(DEFAULTS.weights)) {
      if (k in input.weights) out.weights[k] = clampInt(input.weights[k], 0, 5, out.weights[k]);
    }
  }
  if (input.knockouts && typeof input.knockouts === "object") {
    if ("vms" in input.knockouts) out.knockouts.vms = strArr(input.knockouts.vms, out.knockouts.vms);
    if ("worksome" in input.knockouts) out.knockouts.worksome = strArr(input.knockouts.worksome, out.knockouts.worksome);
  }
  if ("approval_gates" in input && Array.isArray(input.approval_gates)) {
    out.approval_gates = input.approval_gates
      .filter(g => g && typeof g === "object")
      .map(g => ({ condition: str(g.condition).slice(0, 200), action: str(g.action).slice(0, 200) }))
      .slice(0, 20);
  }
  if (input.education && typeof input.education === "object") {
    if ("policies" in input.education) out.education.policies = cardArr(input.education.policies, out.education.policies);
    if ("guides" in input.education) out.education.guides = cardArr(input.education.guides, out.education.guides);
  }
  return out;
}

// ─── Persistence ──────────────────────────────────────
let cached = null;

function load() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cached = sanitize(raw, JSON.parse(JSON.stringify(DEFAULTS)));
  } catch {
    cached = JSON.parse(JSON.stringify(DEFAULTS)); // no file yet, or unreadable
  }
  return cached;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2));
  fs.renameSync(tmp, CONFIG_PATH); // atomic on POSIX
}

function get() {
  return load();
}

function update(partial) {
  cached = sanitize(partial, load());
  persist();
  return cached;
}

function reset() {
  cached = JSON.parse(JSON.stringify(DEFAULTS));
  persist();
  return cached;
}

module.exports = { get, update, reset, DEFAULTS };
