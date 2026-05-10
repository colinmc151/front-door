// GitHub Talent Discovery — public API client
// Searches GitHub for technical talent based on skills, languages, and keywords
const fetch = require("node-fetch");

const GITHUB_API = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Helpers ──────────────────────────────────────────

function headers() {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "front-door-talent-discovery" };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(path, params = {}) {
  const url = new URL(path, GITHUB_API);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const res = await fetch(url.toString(), { headers: headers(), signal: controller.signal });
  clearTimeout(timeout);

  // Rate limit info
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining && parseInt(remaining) < 5) {
    const reset = res.headers.get("x-ratelimit-reset");
    const resetIn = reset ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000)) : "?";
    console.warn(`[GitHub] Rate limit nearly exhausted: ${remaining} remaining, resets in ${resetIn}s`);
  }

  if (res.status === 403 && remaining === "0") {
    const reset = res.headers.get("x-ratelimit-reset");
    const resetIn = reset ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000)) : 60;
    throw new Error(`GitHub rate limit exceeded. Resets in ${resetIn}s.`);
  }

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

// ─── Search strategies ────────────────────────────────

// Build a GitHub search query for repositories
function buildRepoQuery({ languages = [], skills = [], keywords = [], topics = [] }) {
  const parts = [];

  // Keywords and skills go into the general search
  const terms = [...keywords, ...skills].filter(Boolean);
  if (terms.length > 0) parts.push(terms.join(" "));

  // Languages as qualifiers
  for (const lang of languages.slice(0, 3)) {
    parts.push(`language:"${lang}"`);
  }

  // Topics as qualifiers
  for (const topic of topics.slice(0, 3)) {
    parts.push(`topic:${topic.toLowerCase().replace(/\s+/g, "-")}`);
  }

  // Only repos with recent activity (pushed in last 6 months)
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  parts.push(`pushed:>${sixMonthsAgo}`);

  // Minimum stars for credibility
  parts.push("stars:>=5");

  return parts.join(" ");
}

// Build a GitHub search query for users
function buildUserQuery({ skills = [], keywords = [], location = null }) {
  const parts = [];
  const terms = [...skills, ...keywords].filter(Boolean);
  if (terms.length > 0) parts.push(terms.slice(0, 3).join(" "));
  if (location) parts.push(`location:"${location}"`);
  // Only users with repos
  parts.push("repos:>=3");
  return parts.join(" ");
}

// ─── Search repos → extract owners ───────────────────

async function searchViaRepos(criteria, maxResults = 15) {
  const q = buildRepoQuery(criteria);
  if (!q.trim()) return [];

  console.log(`[GitHub] Repo search: "${q}"`);
  const data = await ghFetch("/search/repositories", { q, sort: "stars", order: "desc", per_page: 30 });
  const repos = data.items || [];

  // Extract unique owners
  const ownerMap = new Map();
  for (const repo of repos) {
    const login = repo.owner?.login;
    if (!login || repo.owner?.type !== "User") continue; // skip orgs
    if (!ownerMap.has(login)) {
      ownerMap.set(login, {
        login,
        matchedRepos: [],
      });
    }
    const entry = ownerMap.get(login);
    if (entry.matchedRepos.length < 3) {
      entry.matchedRepos.push({
        name: repo.full_name,
        description: (repo.description || "").slice(0, 120),
        stars: repo.stargazers_count,
        language: repo.language,
        topics: repo.topics || [],
        pushedAt: repo.pushed_at,
        url: repo.html_url,
      });
    }
  }

  // Return top owners by total stars
  return Array.from(ownerMap.values())
    .sort((a, b) => {
      const starsA = a.matchedRepos.reduce((s, r) => s + r.stars, 0);
      const starsB = b.matchedRepos.reduce((s, r) => s + r.stars, 0);
      return starsB - starsA;
    })
    .slice(0, maxResults);
}

// ─── Search users directly ────────────────────────────

async function searchUsers(criteria, maxResults = 10) {
  const q = buildUserQuery(criteria);
  if (!q.trim()) return [];

  console.log(`[GitHub] User search: "${q}"`);
  const data = await ghFetch("/search/users", { q, sort: "followers", order: "desc", per_page: 20 });
  const users = data.items || [];

  return users.slice(0, maxResults).map(u => ({
    login: u.login,
    matchedRepos: [],
  }));
}

// ─── Enrich a GitHub user profile ─────────────────────

async function enrichUser(login) {
  const [profile, reposData] = await Promise.all([
    ghFetch(`/users/${login}`),
    ghFetch(`/users/${login}/repos`, { sort: "pushed", per_page: 20, type: "owner" }),
  ]);

  const repos = reposData || [];

  // Calculate top languages from repos
  const langCounts = {};
  for (const repo of repos) {
    if (repo.language) {
      langCounts[repo.language] = (langCounts[repo.language] || 0) + 1;
    }
  }
  const topLanguages = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([lang]) => lang);

  // Most recent push date
  const recentPush = repos.length > 0 ? repos[0].pushed_at : null;

  // Activity recency
  let activityRecency = "unknown";
  if (recentPush) {
    const daysSince = (Date.now() - new Date(recentPush).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 30) activityRecency = "last_30_days";
    else if (daysSince <= 90) activityRecency = "last_90_days";
    else if (daysSince <= 180) activityRecency = "last_6_months";
    else if (daysSince <= 365) activityRecency = "last_year";
    else activityRecency = "over_year";
  }

  // Top repos by stars (for the card)
  const topRepos = repos
    .filter(r => !r.fork)
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, 5)
    .map(r => ({
      name: r.full_name,
      description: (r.description || "").slice(0, 120),
      stars: r.stargazers_count || 0,
      language: r.language,
      topics: r.topics || [],
      pushedAt: r.pushed_at,
      url: r.html_url,
    }));

  // Contribution signals
  const totalStars = repos.filter(r => !r.fork).reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const ownRepos = repos.filter(r => !r.fork).length;

  return {
    login: profile.login,
    displayName: profile.name || profile.login,
    bio: profile.bio || null,
    location: profile.location || null,
    publicEmail: profile.email || null,
    websiteUrl: profile.blog || null,
    githubProfileUrl: profile.html_url,
    avatarUrl: profile.avatar_url,
    followers: profile.followers || 0,
    hireable: profile.hireable || false,
    topLanguages,
    topRepos,
    activityRecency,
    contributionSignals: {
      publicRepos: profile.public_repos || 0,
      ownRepos,
      totalStars,
      followers: profile.followers || 0,
    },
    lastCheckedAt: new Date().toISOString(),
  };
}

// ─── Main search + enrich pipeline ────────────────────

async function discoverTalent(criteria) {
  const { skills = [], languages = [], keywords = [], location = null, maxResults = 10 } = criteria;

  console.log(`[GitHub] Discovery: skills=${skills.join(",")}, langs=${languages.join(",")}, keywords=${keywords.join(",")}, location=${location || "any"}`);

  // Run both search strategies in parallel
  const [repoOwners, directUsers] = await Promise.all([
    searchViaRepos({ languages, skills, keywords }).catch(err => {
      console.warn(`[GitHub] Repo search failed: ${err.message}`);
      return [];
    }),
    searchUsers({ skills, keywords, location }).catch(err => {
      console.warn(`[GitHub] User search failed: ${err.message}`);
      return [];
    }),
  ]);

  // Merge and deduplicate by login
  const seen = new Map();
  for (const owner of [...repoOwners, ...directUsers]) {
    if (!seen.has(owner.login)) {
      seen.set(owner.login, owner);
    } else {
      // Merge matched repos
      const existing = seen.get(owner.login);
      const existingNames = new Set(existing.matchedRepos.map(r => r.name));
      for (const repo of owner.matchedRepos) {
        if (!existingNames.has(repo.name) && existing.matchedRepos.length < 5) {
          existing.matchedRepos.push(repo);
        }
      }
    }
  }

  // Enrich top candidates (limit API calls)
  const toEnrich = Array.from(seen.values()).slice(0, maxResults);
  const enriched = [];

  for (const candidate of toEnrich) {
    try {
      const profile = await enrichUser(candidate.login);
      // Merge search-matched repos with enriched data
      profile.searchMatchedRepos = candidate.matchedRepos;
      enriched.push(profile);
    } catch (err) {
      console.warn(`[GitHub] Failed to enrich ${candidate.login}: ${err.message}`);
    }
  }

  console.log(`[GitHub] Enriched ${enriched.length} profiles from ${seen.size} unique candidates`);
  return enriched;
}

// ─── Health check ─────────────────────────────────────

async function healthCheck() {
  try {
    const data = await ghFetch("/rate_limit");
    const core = data.resources?.core || {};
    return {
      ok: true,
      authenticated: !!GITHUB_TOKEN,
      rateLimit: { remaining: core.remaining, limit: core.limit, resetsAt: core.reset ? new Date(core.reset * 1000).toISOString() : null },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { discoverTalent, enrichUser, healthCheck, buildRepoQuery, buildUserQuery };
