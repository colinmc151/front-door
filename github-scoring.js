// GitHub Talent Discovery — fit scoring engine
// Produces an explainable score (0–100) for how well a GitHub profile matches search criteria

// Weight configuration
const WEIGHTS = {
  skillLanguageMatch: 0.35,
  repoRelevance: 0.20,
  recentActivity: 0.15,
  projectCredibility: 0.15,
  locationRelevance: 0.10,
  contactability: 0.05,
};

// ─── Sub-scorers (each returns 0–100) ─────────────────

function scoreSkillLanguageMatch(profile, criteria) {
  const { skills = [], languages = [] } = criteria;
  if (skills.length === 0 && languages.length === 0) return { score: 50, reasons: [] };

  const profileLangs = (profile.topLanguages || []).map(l => l.toLowerCase());
  const profileTopics = new Set();
  for (const repo of [...(profile.topRepos || []), ...(profile.searchMatchedRepos || [])]) {
    for (const t of (repo.topics || [])) profileTopics.add(t.toLowerCase());
  }

  const reasons = [];
  let matches = 0;
  const total = skills.length + languages.length;

  // Check languages
  for (const lang of languages) {
    if (profileLangs.includes(lang.toLowerCase())) {
      matches++;
      reasons.push(lang);
    }
  }

  // Check skills against topics, bio, and repo descriptions
  const bioText = (profile.bio || "").toLowerCase();
  const repoText = [...(profile.topRepos || []), ...(profile.searchMatchedRepos || [])]
    .map(r => `${r.description || ""} ${(r.topics || []).join(" ")}`)
    .join(" ")
    .toLowerCase();

  for (const skill of skills) {
    const s = skill.toLowerCase();
    const topicMatch = profileTopics.has(s) || profileTopics.has(s.replace(/\s+/g, "-"));
    const textMatch = bioText.includes(s) || repoText.includes(s);
    if (topicMatch || textMatch) {
      matches++;
      reasons.push(skill);
    }
  }

  const score = total > 0 ? Math.min(100, Math.round((matches / total) * 120)) : 50;
  return { score, reasons };
}

function scoreRepoRelevance(profile, criteria) {
  const { skills = [], keywords = [] } = criteria;
  const searchTerms = [...skills, ...keywords].map(s => s.toLowerCase());
  if (searchTerms.length === 0) return { score: 50, reasons: [] };

  const repos = [...(profile.searchMatchedRepos || []), ...(profile.topRepos || [])];
  const uniqueRepos = [];
  const seen = new Set();
  for (const r of repos) {
    if (!seen.has(r.name)) { seen.add(r.name); uniqueRepos.push(r); }
  }

  let relevantCount = 0;
  const reasons = [];

  for (const repo of uniqueRepos.slice(0, 5)) {
    const text = `${repo.name} ${repo.description || ""} ${(repo.topics || []).join(" ")}`.toLowerCase();
    const matches = searchTerms.filter(t => text.includes(t));
    if (matches.length > 0) {
      relevantCount++;
      if (reasons.length < 2) reasons.push(repo.name.split("/").pop());
    }
  }

  const score = Math.min(100, relevantCount * 25);
  return { score, reasons };
}

function scoreRecentActivity(profile) {
  const recencyScores = {
    last_30_days: 100,
    last_90_days: 80,
    last_6_months: 55,
    last_year: 30,
    over_year: 10,
    unknown: 20,
  };

  const score = recencyScores[profile.activityRecency] || 20;
  const reasons = profile.activityRecency !== "unknown"
    ? [`active ${profile.activityRecency.replace(/_/g, " ")}`]
    : [];

  return { score, reasons };
}

function scoreProjectCredibility(profile) {
  const signals = profile.contributionSignals || {};
  let score = 0;
  const reasons = [];

  // Stars indicate project quality
  if (signals.totalStars >= 1000) { score += 40; reasons.push(`${signals.totalStars} stars`); }
  else if (signals.totalStars >= 100) { score += 30; reasons.push(`${signals.totalStars} stars`); }
  else if (signals.totalStars >= 10) { score += 15; }

  // Own repos (not forks)
  if (signals.ownRepos >= 10) { score += 25; }
  else if (signals.ownRepos >= 5) { score += 15; }
  else if (signals.ownRepos >= 2) { score += 8; }

  // Followers as social proof
  if (signals.followers >= 500) { score += 35; reasons.push(`${signals.followers} followers`); }
  else if (signals.followers >= 100) { score += 25; }
  else if (signals.followers >= 20) { score += 15; }
  else if (signals.followers >= 5) { score += 5; }

  return { score: Math.min(100, score), reasons };
}

function scoreLocationRelevance(profile, criteria) {
  if (!criteria.location) return { score: 50, reasons: [] }; // neutral if no preference
  if (!profile.location) return { score: 30, reasons: [] }; // slight penalty for unknown

  const pLoc = profile.location.toLowerCase();
  const cLoc = criteria.location.toLowerCase();

  // Exact or substring match
  if (pLoc.includes(cLoc) || cLoc.includes(pLoc)) {
    return { score: 100, reasons: [profile.location] };
  }

  // Common timezone/region mappings
  const regions = {
    europe: ["uk", "united kingdom", "london", "berlin", "amsterdam", "paris", "dublin", "copenhagen", "stockholm", "oslo", "lisbon", "madrid", "barcelona", "prague", "warsaw", "vienna", "zurich", "munich", "germany", "france", "spain", "italy", "netherlands", "denmark", "sweden", "norway", "portugal", "ireland", "finland", "poland", "austria", "switzerland", "belgium", "czech"],
    "north america": ["us", "usa", "united states", "canada", "new york", "san francisco", "seattle", "austin", "toronto", "vancouver", "chicago", "los angeles", "boston", "denver", "atlanta", "miami", "portland", "california", "texas", "washington"],
    asia: ["india", "singapore", "japan", "tokyo", "bangalore", "mumbai", "delhi", "china", "hong kong", "korea", "seoul", "taiwan", "vietnam"],
    remote: ["remote", "anywhere", "worldwide", "distributed"],
  };

  for (const [region, terms] of Object.entries(regions)) {
    const cInRegion = terms.some(t => cLoc.includes(t)) || cLoc.includes(region);
    const pInRegion = terms.some(t => pLoc.includes(t)) || pLoc.includes(region);
    if (cInRegion && pInRegion) {
      return { score: 70, reasons: [`${profile.location} (same region)`] };
    }
  }

  return { score: 30, reasons: [] };
}

function scoreContactability(profile) {
  let score = 0;
  const reasons = [];

  if (profile.publicEmail) { score += 50; reasons.push("public email"); }
  if (profile.websiteUrl) { score += 25; reasons.push("website"); }
  if (profile.hireable) { score += 25; reasons.push("marked hireable"); }
  if (profile.bio) { score += 10; }

  return { score: Math.min(100, score), reasons };
}

// ─── Main scoring function ────────────────────────────

function calculateFitScore(profile, criteria) {
  const sub = {
    skillLanguageMatch: scoreSkillLanguageMatch(profile, criteria),
    repoRelevance: scoreRepoRelevance(profile, criteria),
    recentActivity: scoreRecentActivity(profile),
    projectCredibility: scoreProjectCredibility(profile),
    locationRelevance: scoreLocationRelevance(profile, criteria),
    contactability: scoreContactability(profile),
  };

  // Weighted total
  let fitScore = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    fitScore += sub[key].score * weight;
  }
  fitScore = Math.round(fitScore);

  // Confidence based on data completeness
  let confidenceScore = 100;
  if (!profile.bio) confidenceScore -= 10;
  if (!profile.location) confidenceScore -= 10;
  if (!profile.publicEmail && !profile.websiteUrl) confidenceScore -= 15;
  if ((profile.topRepos || []).length < 3) confidenceScore -= 10;
  if (profile.activityRecency === "unknown") confidenceScore -= 15;
  confidenceScore = Math.max(20, confidenceScore);

  // Build explanation string
  const allReasons = [];
  for (const [, sub_result] of Object.entries(sub)) {
    allReasons.push(...sub_result.reasons);
  }
  const explanation = allReasons.length > 0
    ? `Matched on ${allReasons.slice(0, 5).join(", ")}${allReasons.length > 5 ? ` +${allReasons.length - 5} more` : ""}.`
    : "Limited public signals available.";

  return {
    fitScore,
    confidenceScore,
    explanation,
    breakdown: Object.fromEntries(
      Object.entries(sub).map(([k, v]) => [k, { score: v.score, weight: WEIGHTS[k], weighted: Math.round(v.score * WEIGHTS[k]) }])
    ),
  };
}

// ─── Build an ExternalTalentLead from enriched profile ─

function buildExternalTalentLead(profile, criteria) {
  const scoring = calculateFitScore(profile, criteria);

  return {
    id: `gh_${profile.login}`,
    source: "github",
    sourceUserId: profile.login,
    githubLogin: profile.login,
    githubProfileUrl: profile.githubProfileUrl,
    avatarUrl: profile.avatarUrl,
    displayName: profile.displayName,
    bio: profile.bio,
    location: profile.location,
    publicEmail: profile.publicEmail,
    websiteUrl: profile.websiteUrl,
    inferredSkills: scoring.breakdown.skillLanguageMatch?.score > 0
      ? criteria.skills.filter(s => {
          const profileText = [
            profile.bio || "",
            ...(profile.topLanguages || []),
            ...(profile.topRepos || []).flatMap(r => [...(r.topics || []), r.description || ""]),
            ...(profile.searchMatchedRepos || []).flatMap(r => [...(r.topics || []), r.description || ""]),
          ].join(" ").toLowerCase();
          return profileText.includes(s.toLowerCase());
        })
      : [],
    topLanguages: profile.topLanguages || [],
    relevantRepositories: [...(profile.searchMatchedRepos || []), ...(profile.topRepos || [])]
      .filter((r, i, arr) => arr.findIndex(x => x.name === r.name) === i)
      .slice(0, 4),
    contributionSignals: profile.contributionSignals,
    activityRecency: profile.activityRecency,
    fitScore: scoring.fitScore,
    confidenceScore: scoring.confidenceScore,
    fitExplanation: scoring.explanation,
    fitBreakdown: scoring.breakdown,
    consentStatus: "not_contacted",
    inviteStatus: "not_invited",
    convertedWorkerId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCheckedAt: profile.lastCheckedAt,
  };
}

module.exports = { calculateFitScore, buildExternalTalentLead, WEIGHTS };
