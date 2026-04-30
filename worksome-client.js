// Worksome GraphQL API client
// Creates draft jobs from Front Door intake data
const fetch = require("node-fetch");

const WORKSOME_API_URL = process.env.WORKSOME_API_URL || "https://api.worksome.com/graphql";
const WORKSOME_API_TOKEN = process.env.WORKSOME_API_TOKEN;

async function graphql(query, variables = {}) {
  if (!WORKSOME_API_TOKEN) {
    throw new Error("WORKSOME_API_TOKEN not configured");
  }

  console.log(`[Worksome] GraphQL request to ${WORKSOME_API_URL}`);

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
  const query = `
    query SearchWorkers($search: String!) {
      trustedContacts(search: $search, first: 5) {
        data {
          id
          worker {
            id
            name
            email
            jobTitle
          }
        }
      }
    }
  `;

  try {
    console.log(`[Worksome] Searching talent pool for: "${name}"`);
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

// ─── Step 1: Create a job in DRAFT status ───────────────────
async function createJob(routeResult) {
  const query = `
    mutation CreateJob($input: CreateJobInput!) {
      createJob(input: $input) {
        id
        title
        status
      }
    }
  `;

  const variables = {
    input: {
      title: routeResult.role_title || "New Role",
    },
  };

  const data = await graphql(query, variables);
  return data.createJob;
}

// ─── Step 2: Update job with full details ───────────────────
async function updateJob(jobId, routeResult) {
  const query = `
    mutation UpdateJob($input: UpdateJobInput!) {
      updateJob(input: $input) {
        id
        title
        status
        url
      }
    }
  `;

  // Map payment model to budget type
  const budgetType =
    routeResult.payment_model === "milestone" || routeResult.payment_model === "fixed"
      ? "FIXED"
      : routeResult.payment_model === "daily"
      ? "DAILY"
      : "HOURLY";

  // Build a rich description from enrichment data
  const descParts = [];
  if (routeResult.description) descParts.push(routeResult.description);
  if (routeResult.skills && routeResult.skills.length > 0) {
    descParts.push(`\nKey skills: ${routeResult.skills.join(", ")}`);
  }
  if (routeResult.duration) descParts.push(`Duration: ${routeResult.duration}`);
  if (routeResult.location) descParts.push(`Location: ${routeResult.location}`);
  if (routeResult.start_date) descParts.push(`Start: ${routeResult.start_date}`);
  if (routeResult.budget) descParts.push(`Budget: ${routeResult.budget}`);
  if (routeResult.headcount > 1) descParts.push(`Headcount: ${routeResult.headcount}`);

  const input = {
    id: jobId,
    description: descParts.join("\n") || `Role: ${routeResult.role_title}`,
  };

  const data = await graphql(query, { input });
  return data.updateJob;
}

// ─── Step 3: Invite a known worker (createTrustedContact) ───
async function inviteWorker(routeResult) {
  if (!routeResult.worker_email) return null;

  const query = `
    mutation CreateTrustedContact($input: CreateTrustedContactInput!) {
      createTrustedContact(input: $input) {
        id
        status
      }
    }
  `;

  // Build the input with all available worker details
  const input = {
    email: routeResult.worker_email,
  };

  // Use first/last name if available, fall back to full name
  if (routeResult.worker_first_name) input.firstName = routeResult.worker_first_name;
  if (routeResult.worker_last_name) input.lastName = routeResult.worker_last_name;
  if (!input.firstName && routeResult.worker_name) input.name = routeResult.worker_name;

  // Add country if provided
  if (routeResult.worker_country) input.country = routeResult.worker_country;

  // Add skills if provided
  if (routeResult.worker_skills && routeResult.worker_skills.length > 0) {
    input.skills = routeResult.worker_skills;
  }

  try {
    const data = await graphql(query, { input });
    console.log(`[Worksome] Worker invited: ${routeResult.worker_email} → ${data.createTrustedContact.id}`);
    return data.createTrustedContact;
  } catch (err) {
    // Worker might already be in the talent pool — that's fine
    console.warn(`[Worksome] Worker invite skipped: ${err.message}`);
    return null;
  }
}

// ─── Main handoff function ──────────────────────────────────
// Creates a draft job in Worksome from the intake data
// Returns the job ID and URL so the manager can continue there
async function handoff(routeResult) {
  console.log(`[Worksome] Creating job: ${routeResult.role_title}`);

  // Step 1: Create the job
  const job = await createJob(routeResult);
  console.log(`[Worksome] Job created: ${job.id} (${job.status})`);

  // Step 2: Update with full details
  let updatedJob;
  try {
    updatedJob = await updateJob(job.id, routeResult);
    console.log(`[Worksome] Job updated: ${updatedJob.id} — ${updatedJob.url || "no URL yet"}`);
  } catch (err) {
    console.warn(`[Worksome] Job update failed (non-fatal): ${err.message}`);
    updatedJob = job;
  }

  // Step 3: If known worker with email, invite them to the talent pool
  // This covers both "found in pool" and "not found, details collected" cases
  let worker = null;
  if (routeResult.worker_email) {
    worker = await inviteWorker(routeResult);
  }

  return {
    job_id: updatedJob.id || job.id,
    job_url: updatedJob.url || null,
    status: updatedJob.status || job.status,
    title: routeResult.role_title,
    worker_invited: worker ? true : false,
    worker_name: routeResult.worker_name || null,
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

module.exports = { handoff, healthCheck, searchWorkers, graphql };
