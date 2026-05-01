// Worksome GraphQL API client
// Creates draft jobs from Front Door intake data
const fetch = require("node-fetch");

const WORKSOME_API_URL = process.env.WORKSOME_API_URL || "https://general-api.sand.aws.worksome.com/graphql";
const WORKSOME_API_TOKEN = process.env.WORKSOME_API_TOKEN;

// Cache the account ID so we only fetch it once
let _cachedAccountId = null;

async function getAccountId() {
  if (_cachedAccountId) return _cachedAccountId;
  try {
    const data = await graphql(`{ accounts { id name } }`);
    const accounts = data.accounts || [];
    if (accounts.length > 0) {
      _cachedAccountId = accounts[0].id;
      console.log(`[Worksome] Using account: ${accounts[0].name} (${_cachedAccountId})`);
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

  const res = await fetch(WORKSOME_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${WORKSOME_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

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
      trustedContacts(search: $search${accountFilter}, first: 5) {
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

// ─── Search talent pool by skills ──────────────────────────
async function searchWorkersBySkills(skillNames) {
  const accountId = await getAccountId();

  // Step 1: Resolve skill names to IDs
  const resolved = await resolveSkillIds(skillNames);
  const skillIds = resolved.map(s => s.id);

  if (skillIds.length === 0) {
    console.log(`[Worksome] No skill IDs resolved — cannot search by skills`);
    return { workers: [], resolvedSkills: resolved };
  }

  // Step 2: Query trusted contacts filtered by skills (include their skills for scoring)
  const accountFilter = accountId ? `, accounts: ["${accountId}"]` : '';
  const query = `
    query SearchBySkills($skills: [ID!]) {
      trustedContacts(skills: $skills${accountFilter}, first: 10) {
        data {
          id
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
    const data = await graphql(query, { skills: skillIds });
    const raw = data.trustedContacts?.data || [];

    const contacts = raw.map(tc => ({
      id: tc.worker?.id || tc.id,
      name: tc.worker?.name || null,
      email: tc.worker?.email || null,
      title: tc.worker?.jobTitle || null,
      skills: (tc.worker?.skills || []).map(s => s.name),
    }));

    console.log(`[Worksome] Skill search returned ${contacts.length} result(s):`, contacts.map(c => c.name));
    return { workers: contacts, resolvedSkills: resolved };
  } catch (err) {
    console.warn(`[Worksome] Skill search failed: ${err.message}`);
    return { workers: [], resolvedSkills: resolved, error: err.message };
  }
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

  // Add skills if available
  if (routeResult.skills && routeResult.skills.length > 0) {
    input.skills = routeResult.skills;
  }

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
// Routes to the right Worksome page and optionally creates a job
async function handoff(routeResult) {
  console.log(`[Worksome] Handoff: ${routeResult.role_title} (known_worker: ${routeResult.known_worker}, worker_id: ${routeResult.worker_id || 'none'})`);

  let job = null;
  let updatedJob = null;

  // For known workers found in the pool, the hire page handles job creation
  // For discovery flow or new workers, create the job via API
  const skipJobCreation = routeResult.known_worker && routeResult.worker_id && routeResult.worker_found !== false;

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
    // New worker — send manager to trusted contacts to invite them
    jobUrl = `${WORKSOME_BASE_URL}/contacts`;
  } else if (routeResult.worker_id) {
    jobUrl = `${WORKSOME_BASE_URL}/profile/${routeResult.worker_id}/hire`;
  } else {
    jobUrl = buildWorksomeUrl(routeResult, jobId);
  }

  return {
    job_id: jobId,
    job_url: jobUrl,
    status: updatedJob?.status || job?.status || "routed",
    title: routeResult.role_title,
    worker_invited: false,
    worker_name: routeResult.worker_name || null,
    worker_id: routeResult.worker_id || null,
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

module.exports = { handoff, healthCheck, searchWorkers, searchWorkersBySkills };
