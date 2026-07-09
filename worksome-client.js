// Worksome GraphQL API client
// Creates draft jobs from Front Door intake data
const fetch = require("node-fetch");

const WORKSOME_API_URL = process.env.WORKSOME_API_URL || "https://general-api.sand.aws.worksome.com/graphql";
const WORKSOME_API_TOKEN = process.env.WORKSOME_API_TOKEN;

// Cache the account ID so we only fetch it once
let _cachedAccountId = null;

// Validate account ID format (prevents GraphQL injection via string interpolation)
function safeAccountId(id) {
  if (!id) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) {
    console.warn(`[Worksome] Suspicious account ID rejected: ${id}`);
    return null;
  }
  return String(id);
}

async function getAccountId() {
  if (_cachedAccountId) return _cachedAccountId;
  try {
    const data = await graphql(`{ accounts { id name } }`);
    const accounts = data.accounts || [];
    if (accounts.length > 0) {
      // When the token's user belongs to several accounts, WORKSOME_ACCOUNT_NAME
      // selects the one to scope queries to (substring match, case-insensitive).
      const wanted = (process.env.WORKSOME_ACCOUNT_NAME || "").trim().toLowerCase();
      const match = wanted
        ? accounts.find((a) => (a.name || "").toLowerCase().includes(wanted))
        : null;
      if (wanted && !match) {
        console.warn(`[Worksome] No account matching "${process.env.WORKSOME_ACCOUNT_NAME}" — available: ${accounts.map(a => a.name).join(", ")}`);
      }
      const chosen = match || accounts[0];
      _cachedAccountId = safeAccountId(chosen.id);
      console.log(`[Worksome] Using account: ${chosen.name} (${_cachedAccountId})`);
    }
  } catch (err) {
    console.warn(`[Worksome] Failed to fetch accounts: ${err.message}`);
  }
  return _cachedAccountId;
}

async function graphql(query, variables = {}) {
  if (!WORKSOME_API_TOKEN) {
    throw new Error("WORKSOME_API_TOKEN not configured");
  }

  // Verbose logging disabled for production
  // console.log(`[Worksome] GraphQL request to ${WORKSOME_API_URL}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const res = await fetch(WORKSOME_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${WORKSOME_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  const data = await res.json();

  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map((e) => e.message).join("; ");
    throw new Error(`Worksome GraphQL error: ${msg}`);
  }

  return data.data;
}

// ─── Search talent pool by name ─────────────────────────────
async function searchWorkers(name) {
  const accountId = await getAccountId();

  // Build query with optional account scope
  const accountFilter = accountId ? `, accounts: ["${accountId}"]` : '';
  const query = `
    query SearchWorkers($search: String!) {
      trustedContacts(search: $search${accountFilter}, first: 3) {
        data {
          id
          worker {
            id
            name
            firstName
            lastName
            email
          }
        }
      }
    }
  `;

  try {
    console.log(`[Worksome] Searching talent pool for: "${name}" (account: ${accountId || 'all'})`);
    const data = await graphql(query, { search: name });
    const raw = data.trustedContacts?.data || [];

    // Flatten: pull worker details up to top level for the rest of the app
    const contacts = raw.map(tc => ({
      id: tc.worker?.id || tc.id,
      name: tc.worker?.name || null,
      email: tc.worker?.email || null,
      title: tc.worker?.jobTitle || null,
    }));

    console.log(`[Worksome] Search "${name}" returned ${contacts.length} result(s):`, contacts.map(c => c.name));

    // If full name returned nothing, try last name only
    if (contacts.length === 0 && name.includes(' ')) {
      const lastName = name.split(' ').pop();
      console.log(`[Worksome] Retrying with last name only: "${lastName}"`);
      const retryData = await graphql(query, { search: lastName });
      const retryRaw = retryData.trustedContacts?.data || [];
      const retryContacts = retryRaw.map(tc => ({
        id: tc.worker?.id || tc.id,
        name: tc.worker?.name || null,
        email: tc.worker?.email || null,
        title: tc.worker?.jobTitle || null,
      }));
      console.log(`[Worksome] Retry "${lastName}" returned ${retryContacts.length} result(s):`, retryContacts.map(c => c.name));
      return retryContacts;
    }

    return contacts;
  } catch (err) {
    console.warn(`[Worksome] Worker search failed: ${err.message}`);
    return [];
  }
}

// ─── Resolve skill names to IDs ────────────────────────────
async function resolveSkillIds(skillNames) {
  const ids = [];
  for (const name of skillNames) {
    try {
      const data = await graphql(
        `query FindSkill($search: String!) { skills(search: $search, first: 3) { data { id name } } }`,
        { search: name }
      );
      const matches = data.skills?.data || [];
      // Pick exact match first, otherwise first result
      const exact = matches.find(s => s.name.toLowerCase() === name.toLowerCase());
      const best = exact || matches[0];
      if (best) {
        ids.push({ id: best.id, name: best.name, searched: name });
        console.log(`[Worksome] Skill "${name}" → ${best.name} (${best.id})`);
      } else {
        console.log(`[Worksome] Skill "${name}" → no match`);
      }
    } catch (err) {
      console.warn(`[Worksome] Skill lookup failed for "${name}": ${err.message}`);
    }
  }
  return ids;
}

// ─── Map a TrustedContact GraphQL result to a flat worker object ──
function mapTrustedContact(tc, richProfile = false) {
  const w = tc.worker || {};

  // Merge worker skills + TC-level (company-added) skills, deduplicated
  const workerSkills = (w.skills || []).map(s => s.name);
  const companySkills = (tc.skills || []).map(s => s.name);
  const allSkills = [...new Set([...workerSkills, ...companySkills])];

  // Extract custom field values (e.g. Title, Rate overrides)
  const customFields = {};
  for (const cf of (tc.customFieldValues || [])) {
    if (cf.customField?.name && cf.value) {
      customFields[cf.customField.name] = cf.value;
    }
  }

  // Use custom field "Title" as fallback for jobTitle
  const title = w.jobTitle || customFields['Title'] || customFields['title'] || null;

  return {
    id: w.id || tc.id,
    name: w.name || null,
    firstName: w.firstName || null,
    lastName: w.lastName || null,
    email: w.email || null,
    title,
    avatar: w.avatar || null,
    bio: customFields['Bio'] || customFields['bio'] || customFields['About'] || null,
    location: w.address ? [w.address.city, w.address.country?.name || w.address.country].filter(Boolean).join(', ') : null,
    skills: allSkills,
    companySkills,
    customFields: Object.keys(customFields).length > 0 ? customFields : null,
    dayRate: w.dayRate || null,
    currency: w.currency || null,
    isCurrentlyHired: w.isCurrentlyHired || false,
    totalPaid: w.totalPaid || 0,
    notesCount: (tc.notes?.data || []).length,
    hiresCount: (w.hires?.data || []).length,
    hires: (w.hires?.data || []).map(h => ({
      id: h.id,
      status: h.status,
      startDate: h.startDate,
      endDate: h.endDate,
      rate: h.rate,
      rateType: h.rateType,
      currency: h.currency,
      contractType: h.contractTypeLabel,
      tenure: h.tenure,
    })),
    source: 'worksome',
    richProfile,
  };
}

// ─── Search talent pool by skills (rich profiles) ─────────────
async function searchWorkersBySkills(skillNames) {
  const accountId = await getAccountId();

  // Step 1: Resolve skill names to IDs
  const resolved = await resolveSkillIds(skillNames);
  const skillIds = resolved.map(s => s.id);

  if (skillIds.length === 0) {
    console.log(`[Worksome] No skill IDs resolved — cannot search by skills`);
    return { workers: [], resolvedSkills: resolved };
  }

  // Step 2: Query trusted contacts with rich profile fields
  const accountFilter = accountId ? `, accounts: ["${accountId}"]` : '';

  // Rich query — includes avatar, location, rate, hire status + TC-level skills, notes & hires
  const acctArg = accountId ? `(account: "${accountId}")` : '';
  const richQuery = `
    query SearchBySkills($skills: [ID!]) {
      trustedContacts(skills: $skills${accountFilter}, first: 3) {
        data {
          id
          skills { id name }
          notes { data { id } }
          worker {
            id
            name
            firstName
            lastName
            email
            jobTitle
            avatar
            address { city country { name } }
            skills { name }
            dayRate
            currency
            isCurrentlyHired${acctArg}
            totalPaid${acctArg}
            hires { data { id status startDate endDate rate rateType currency contractTypeLabel tenure } }
          }
        }
      }
    }
  `;

  // Fallback query — basic fields only (in case rich fields aren't supported)
  const basicQuery = `
    query SearchBySkills($skills: [ID!]) {
      trustedContacts(skills: $skills${accountFilter}, first: 3) {
        data {
          id
          skills { id name }
          worker {
            id
            name
            firstName
            lastName
            email
            jobTitle
            skills { name }
          }
        }
      }
    }
  `;

  try {
    console.log(`[Worksome] Searching talent pool by skills: ${skillIds.join(', ')} (account: ${accountId || 'all'})`);
    let data;
    let usedRichQuery = false;

    try {
      data = await graphql(richQuery, { skills: skillIds });
      usedRichQuery = true;
    } catch (richErr) {
      console.warn(`[Worksome] Rich query failed, falling back to basic: ${richErr.message}`);
      data = await graphql(basicQuery, { skills: skillIds });
    }

    const raw = data.trustedContacts?.data || [];

    const contacts = raw.map(tc => mapTrustedContact(tc, usedRichQuery));

    console.log(`[Worksome] Skill search returned ${contacts.length} result(s) (rich: ${usedRichQuery}):`, contacts.map(c => c.name));

    // If skill-filtered search returned nothing, try fetching ALL trusted contacts
    if (contacts.length === 0) {
      console.log(`[Worksome] No skill-matched contacts — falling back to full talent pool`);
      try {
        const allQuery = `
          query AllContacts {
            trustedContacts(${accountId ? `accounts: ["${accountId}"], ` : ''}first: 3) {
              data {
                id
                skills { id name }
                notes { data { id } }
                worker {
                  id name firstName lastName email jobTitle avatar
                  address { city country { name } }
                  skills { name }
                  dayRate currency isCurrentlyHired${acctArg} totalPaid${acctArg}
                  hires { data { id status startDate endDate rate rateType currency contractTypeLabel tenure } }
                }
              }
            }
          }
        `;
        let allData;
        try {
          allData = await graphql(allQuery);
        } catch (richErr) {
          // Fallback to basic fields
          const allBasicQuery = `
            query AllContacts {
              trustedContacts(${accountId ? `accounts: ["${accountId}"], ` : ''}first: 3) {
                data {
                  id
                  skills { id name }
                  worker { id name firstName lastName email jobTitle skills { name } }
                }
              }
            }
          `;
          allData = await graphql(allBasicQuery);
        }
        const allRaw = allData.trustedContacts?.data || [];
        const allContacts = allRaw.map(tc => mapTrustedContact(tc, true));
        console.log(`[Worksome] Full pool returned ${allContacts.length} contact(s):`, allContacts.map(c => c.name));
        if (allContacts.length > 0) {
          return { workers: allContacts, resolvedSkills: resolved, broadSearch: true };
        }
      } catch (fallbackErr) {
        console.warn(`[Worksome] Full pool fallback failed: ${fallbackErr.message}`);
      }
    }

    return { workers: contacts, resolvedSkills: resolved };
  } catch (err) {
    console.warn(`[Worksome] Skill search failed: ${err.message}`);
    return { workers: [], resolvedSkills: resolved, error: err.message };
  }
}

// ─── Schema-adaptive input building ─────────────────────────
// The exact input fields vary between Worksome environments. We introspect
// the input type once (cached) and only send fields the schema accepts, so
// fast-track mutations degrade gracefully instead of erroring on unknowns.
const _inputFieldCache = new Map();

async function getInputFields(typeName) {
  if (_inputFieldCache.has(typeName)) return _inputFieldCache.get(typeName);
  try {
    const safe = String(typeName).replace(/[^A-Za-z0-9_]/g, "");
    const data = await graphql(`{ __type(name: "${safe}") { inputFields { name } } }`);
    const fields = (data.__type?.inputFields || []).map(f => f.name);
    _inputFieldCache.set(typeName, fields.length ? fields : null);
  } catch {
    _inputFieldCache.set(typeName, null); // introspection unavailable — send candidates as-is
  }
  return _inputFieldCache.get(typeName);
}

// Drop undefined values; if schema fields are known, drop unknown keys too.
function filterInput(candidate, schemaFields) {
  const out = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (v === undefined) continue;
    if (schemaFields && !schemaFields.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ─── Fast track: pre-invite a new worker to the talent pool ──
// externalIdentifier ties the Worksome worker back to the Front Door intake.
function buildTrustedContactCandidate(routeResult, accountId) {
  return {
    firstName: routeResult.worker_first_name || undefined,
    lastName: routeResult.worker_last_name || undefined,
    email: routeResult.worker_email || undefined,
    externalIdentifier: routeResult._intakeId ? `frontdoor:${routeResult._intakeId}` : undefined,
    // Account linkage — field name differs by schema; introspection picks the real one
    account: accountId || undefined,
    accounts: accountId ? [accountId] : undefined,
    company: accountId || undefined,
  };
}

async function createTrustedContact(routeResult) {
  const accountId = await getAccountId();
  const fields = await getInputFields("CreateTrustedContactInput");
  const input = filterInput(buildTrustedContactCandidate(routeResult, accountId), fields);

  if (!input.email) throw new Error("createTrustedContact requires an email");

  const data = await graphql(`
    mutation CreateTrustedContact($input: CreateTrustedContactInput!) {
      createTrustedContact(input: $input) { id }
    }
  `, { input });
  return data.createTrustedContact;
}

// ─── Fast track: draft hire for a known worker ───────────────
// Draft hires must still be completed in the Worksome UI (compliance,
// contract) — this just saves the manager from re-finding the worker.
function buildDraftHireCandidate(jobId, workerId) {
  return { job: jobId, worker: workerId, jobId, workerId };
}

async function createDraftHire(jobId, workerId) {
  // Input type name varies; try the documented one first
  let fields = await getInputFields("HireInput");
  if (!fields) fields = await getInputFields("CreateDraftHireInput");
  const input = filterInput(buildDraftHireCandidate(jobId, workerId), fields);

  const data = await graphql(`
    mutation CreateDraftHire($input: HireInput!) {
      createDraftHire(input: $input) { id status }
    }
  `, { input });
  return data.createDraftHire;
}

// ─── Fast track: propose a worker as a job candidate ─────────
// Used as a fallback when shareHire isn't available/permitted.
function buildJobCandidateCandidate(jobId, workerId) {
  return { job: jobId, worker: workerId, jobId, workerId };
}

async function createJobCandidate(jobId, workerId) {
  const fields = await getInputFields("CreateJobCandidateInput");
  const input = filterInput(buildJobCandidateCandidate(jobId, workerId), fields);

  const data = await graphql(`
    mutation CreateJobCandidate($input: CreateJobCandidateInput!) {
      createJobCandidate(input: $input) { id status }
    }
  `, { input });
  return data.createJobCandidate;
}

// ─── Fast track: milestone scaffold for fixed-price work ─────
// Builds a single "Project delivery" milestone from the intake data; the
// manager refines amounts/dates in the Worksome UI.
function buildMilestonesCandidate(routeResult, { jobId, hireId, now } = {}) {
  const { durationToMonths, parseAmount } = require("./approval");
  const start = now ? new Date(now) : new Date();
  const months = durationToMonths(routeResult.duration);
  const dueDate = months
    ? new Date(start.getTime() + months * 30 * 86400000).toISOString().slice(0, 10)
    : null;
  return {
    job: jobId || undefined,
    hire: hireId || undefined,
    milestones: [{
      title: `Project delivery — ${routeResult.role_title || "Role"}`,
      amount: parseAmount(routeResult.budget) || undefined,
      dueDate: dueDate || undefined,
    }],
  };
}

async function createMilestones(routeResult, refs) {
  const fields = await getInputFields("CreateMilestonesInput");
  const input = filterInput(buildMilestonesCandidate(routeResult, refs), fields);

  const data = await graphql(`
    mutation CreateMilestones($input: CreateMilestonesInput!) {
      createMilestones(input: $input) { id }
    }
  `, { input });
  return data.createMilestones;
}

// ─── Step 1: Create a job ───────────────────────────────────
async function createJob(routeResult) {
  const accountId = await getAccountId();

  const query = `
    mutation CreateJob($input: CreateJobInput!) {
      createJob(input: $input) {
        id
        name
        skills { name }
      }
    }
  `;

  const input = {
    name: routeResult.role_title || "New Role",
  };

  // Company ID is required
  if (accountId) {
    input.company = accountId;
  }

  // Skills is required by the API
  input.skills = (routeResult.skills && routeResult.skills.length > 0)
    ? routeResult.skills
    : ["General"];

  const data = await graphql(query, { input });
  return data.createJob;
}

// ─── Step 2: Update job with full details ───────────────────
async function updateJob(jobId, routeResult) {
  const query = `
    mutation UpdateJob($input: UpdateJobInput!) {
      updateJob(input: $input) {
        id
        name
        description
        startDate
        endDate
      }
    }
  `;

  // Build a rich description from enrichment data
  const descParts = [];
  if (routeResult.description) descParts.push(routeResult.description);
  if (routeResult.duration) descParts.push(`Duration: ${routeResult.duration}`);
  if (routeResult.location) descParts.push(`Location: ${routeResult.location}`);
  if (routeResult.budget) descParts.push(`Budget: ${routeResult.budget}`);
  if (routeResult.headcount > 1) descParts.push(`Headcount: ${routeResult.headcount}`);

  const input = {
    id: jobId,
    name: routeResult.role_title || "New Role",
    description: descParts.join("\n") || `Role: ${routeResult.role_title}`,
  };

  // Map payment model to rate type
  if (routeResult.payment_model && routeResult.payment_model !== "unknown") {
    const rateTypeMap = { hourly: "HOURLY", daily: "DAILY", milestone: "FIXED", fixed: "FIXED" };
    const rateType = rateTypeMap[routeResult.payment_model];
    if (rateType) {
      input.rateType = { type: rateType };
    }
  }

  // Add start date if available (convert to ISO format YYYY-MM-DD)
  if (routeResult.start_date && routeResult.start_date !== "asap" && routeResult.start_date !== "null") {
    const parsed = new Date(routeResult.start_date);
    if (!isNaN(parsed.getTime())) {
      input.startDate = parsed.toISOString().split('T')[0];
    }
  }

  const data = await graphql(query, { input });
  return data.updateJob;
}

// ─── Build the Worksome URL based on context ───────────────
const WORKSOME_BASE_URL = process.env.WORKSOME_URL ? process.env.WORKSOME_URL.replace('/login', '') : 'https://sandbox.worksome.com';

function buildWorksomeUrl(routeResult, jobId) {
  // Known worker with ID → go straight to direct hire page
  if (routeResult.known_worker && routeResult.worker_id) {
    return `${WORKSOME_BASE_URL}/profile/${routeResult.worker_id}/hire`;
  }
  // Discovery flow or new worker → hires page
  return `${WORKSOME_BASE_URL}/profiles/contracts`;
}

// ─── Main handoff function ──────────────────────────────────
// Routes to the right Worksome page and optionally creates a job.
// Fast tracks (opt-in via env until verified against the live sandbox):
//   FAST_TRACK_INVITE=1      — new worker (A2): pre-create the trusted contact
//   FAST_TRACK_DRAFT_HIRE=1  — known worker: pre-create job + draft hire
async function handoff(routeResult) {
  console.log(`[Worksome] Handoff: ${routeResult.role_title} (known_worker: ${routeResult.known_worker}, worker_id: ${routeResult.worker_id || 'none'})`);

  let job = null;
  let updatedJob = null;
  let invitedContact = null;
  let draftHire = null;

  const isNewWorker = routeResult.worker_found === false && routeResult.worker_email;
  const isKnownWorker = routeResult.known_worker && routeResult.worker_id && routeResult.worker_found !== false;

  // Fast track: pre-invite a brand-new worker into the talent pool
  if (isNewWorker && process.env.FAST_TRACK_INVITE === "1") {
    try {
      invitedContact = await createTrustedContact(routeResult);
      console.log(`[Worksome] Trusted contact created: ${invitedContact.id} (${routeResult.worker_email})`);
    } catch (err) {
      console.warn(`[Worksome] createTrustedContact failed (non-fatal): ${err.message}`);
    }
  }

  // For known workers found in the pool, the hire page handles job creation
  // (unless the draft-hire fast track is enabled). For discovery flow or
  // new workers, create the job via API.
  const fastTrackDraftHire = isKnownWorker && process.env.FAST_TRACK_DRAFT_HIRE === "1";
  const skipJobCreation = isKnownWorker && !fastTrackDraftHire;

  if (!skipJobCreation) {
    try {
      // Step 1: Create the job
      job = await createJob(routeResult);
      console.log(`[Worksome] Job created: ${job.id}`);

      // Step 2: Update with full details
      try {
        updatedJob = await updateJob(job.id, routeResult);
        console.log(`[Worksome] Job updated: ${updatedJob.id}`);
      } catch (err) {
        console.warn(`[Worksome] Job update failed (non-fatal): ${err.message}`);
        updatedJob = job;
      }

      // Fast track: link the known worker via a draft hire (completed in UI)
      if (fastTrackDraftHire && (updatedJob?.id || job?.id)) {
        try {
          draftHire = await createDraftHire(updatedJob?.id || job?.id, routeResult.worker_id);
          console.log(`[Worksome] Draft hire created: ${draftHire.id}`);
        } catch (err) {
          console.warn(`[Worksome] createDraftHire failed (non-fatal): ${err.message}`);
        }
      }

      // Fast track: scaffold a milestone for fixed-price engagements
      if (process.env.FAST_TRACK_MILESTONES === "1"
          && ["milestone", "fixed"].includes(routeResult.payment_model)
          && (updatedJob?.id || job?.id)) {
        try {
          const ms = await createMilestones(routeResult, { jobId: updatedJob?.id || job?.id, hireId: draftHire?.id });
          console.log(`[Worksome] Milestone scaffold created`, ms?.id || "");
        } catch (err) {
          console.warn(`[Worksome] createMilestones failed (non-fatal): ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[Worksome] Job creation failed (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`[Worksome] Skipping job creation — known worker, hire page will handle it`);
  }

  const jobId = updatedJob?.id || job?.id || null;

  // Build the URL based on context
  let jobUrl;
  if (routeResult.worker_found === false) {
    // New worker — send manager to trusted contacts (already invited if fast-tracked)
    jobUrl = `${WORKSOME_BASE_URL}/contacts`;
  } else if (routeResult.worker_id) {
    jobUrl = `${WORKSOME_BASE_URL}/profile/${routeResult.worker_id}/hire`;
  } else {
    jobUrl = buildWorksomeUrl(routeResult, jobId);
  }

  return {
    job_id: jobId,
    job_url: jobUrl,
    status: draftHire ? "draft_hire_created" : (updatedJob?.status || job?.status || "routed"),
    title: routeResult.role_title,
    worker_invited: !!invitedContact,
    contact_id: invitedContact?.id || null,
    draft_hire_id: draftHire?.id || null,
    worker_name: routeResult.worker_name || null,
    worker_id: routeResult.worker_id || null,
  };
}

// ─── Create job and invite multiple workers ─────────────────
async function createJobAndInvite(jobDetails, workerIds, workerNames = {}) {
  console.log(`[Worksome] Creating job "${jobDetails.role_title}" and inviting ${workerIds.length} workers`);

  // Step 1: Create the job
  const job = await createJob(jobDetails);
  console.log(`[Worksome] Job created: ${job.id}`);

  // Step 2: Update with full details
  let updatedJob = job;
  try {
    updatedJob = await updateJob(job.id, jobDetails);
    console.log(`[Worksome] Job updated with details`);
  } catch (err) {
    console.warn(`[Worksome] Job update failed (non-fatal): ${err.message}`);
  }

  // Step 3: Try to invite each worker to the job via createHire mutation
  const inviteResults = [];
  for (const workerId of workerIds) {
    try {
      const hireData = await graphql(`
        mutation ShareHire($input: ShareHireInput!) {
          shareHire(input: $input) {
            id
            status
            worker { name }
          }
        }
      `, {
        input: {
          job: updatedJob.id,
          worker: workerId,
        }
      });
      inviteResults.push({
        workerId,
        status: 'invited',
        hireId: hireData.shareHire?.id,
        workerName: hireData.shareHire?.worker?.name || workerNames[workerId] || workerId,
      });
      console.log(`[Worksome] Worker ${workerId} invited (hire: ${hireData.shareHire?.id})`);
    } catch (err) {
      console.warn(`[Worksome] shareHire failed for ${workerId}: ${err.message}`);
      // Fallback 1: propose them as a job candidate instead
      try {
        const candidate = await createJobCandidate(updatedJob.id, workerId);
        inviteResults.push({
          workerId,
          workerName: workerNames[workerId] || workerId,
          status: 'proposed',
          candidateId: candidate?.id || null,
        });
        console.log(`[Worksome] Worker ${workerId} proposed as job candidate (${candidate?.id})`);
        continue;
      } catch (err2) {
        console.warn(`[Worksome] createJobCandidate also failed for ${workerId}: ${err2.message}`);
      }
      // Fallback 2: provide a direct hire link instead
      inviteResults.push({
        workerId,
        workerName: workerNames[workerId] || workerId,
        status: 'link_only',
        hireUrl: `${WORKSOME_BASE_URL}/profile/${workerId}/hire`,
        error: err.message,
      });
    }
  }

  // Link to the worker's hire page if single selection, otherwise contracts list
  const jobUrl = workerIds.length === 1
    ? `${WORKSOME_BASE_URL}/profile/${workerIds[0]}/hire`
    : `${WORKSOME_BASE_URL}/profiles/contracts`;

  return {
    job_id: updatedJob.id,
    job_title: jobDetails.role_title,
    job_url: jobUrl,
    workers_invited: inviteResults.filter(r => r.status === 'invited').length,
    workers_proposed: inviteResults.filter(r => r.status === 'proposed').length,
    workers_link_only: inviteResults.filter(r => r.status === 'link_only').length,
    results: inviteResults,
  };
}

// ─── Health check — verify the token works ──────────────────
async function healthCheck() {
  try {
    const data = await graphql("{ me { id name email } }");
    return { ok: true, user: data.me };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  handoff, healthCheck, searchWorkers, searchWorkersBySkills, createJobAndInvite,
  createTrustedContact, createDraftHire, createJobCandidate, createMilestones,
  // exported for unit tests
  buildTrustedContactCandidate, buildDraftHireCandidate, buildJobCandidateCandidate, buildMilestonesCandidate, filterInput,
};
