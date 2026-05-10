// Tests for GitHub Talent Discovery — scoring engine + query builders
// Run: node test-github.js

const { calculateFitScore, buildExternalTalentLead, WEIGHTS } = require("./github-scoring");
const { buildRepoQuery, buildUserQuery } = require("./github-client");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function test(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL (threw): ${err.message}`);
  }
}

// ─── Mock data ───────────────────────────────────────

const strongProfile = {
  login: "janedoe",
  displayName: "Jane Doe",
  bio: "Senior full-stack developer. React, Node.js, GraphQL.",
  location: "London, UK",
  publicEmail: "jane@example.com",
  websiteUrl: "https://janedoe.dev",
  githubProfileUrl: "https://github.com/janedoe",
  avatarUrl: "https://github.com/janedoe.png",
  hireable: true,
  topLanguages: ["TypeScript", "JavaScript", "Python"],
  topRepos: [
    { name: "janedoe/react-dashboard", description: "React admin dashboard with GraphQL", stars: 320, language: "TypeScript", topics: ["react", "graphql", "dashboard"], pushedAt: "2026-04-20", url: "https://github.com/janedoe/react-dashboard" },
    { name: "janedoe/node-api", description: "Node.js REST API boilerplate", stars: 180, language: "JavaScript", topics: ["node", "express", "api"], pushedAt: "2026-04-15", url: "https://github.com/janedoe/node-api" },
  ],
  searchMatchedRepos: [],
  activityRecency: "last_30_days",
  contributionSignals: { publicRepos: 35, ownRepos: 20, totalStars: 500, followers: 200 },
  lastCheckedAt: new Date().toISOString(),
};

const weakProfile = {
  login: "newdev42",
  displayName: "newdev42",
  bio: null,
  location: null,
  publicEmail: null,
  websiteUrl: null,
  githubProfileUrl: "https://github.com/newdev42",
  avatarUrl: "https://github.com/newdev42.png",
  hireable: false,
  topLanguages: ["Java"],
  topRepos: [
    { name: "newdev42/hello-world", description: "", stars: 0, language: "Java", topics: [], pushedAt: "2024-03-01", url: "https://github.com/newdev42/hello-world" },
  ],
  searchMatchedRepos: [],
  activityRecency: "over_year",
  contributionSignals: { publicRepos: 2, ownRepos: 1, totalStars: 0, followers: 0 },
  lastCheckedAt: new Date().toISOString(),
};

const matchingCriteria = { skills: ["React", "Node.js", "GraphQL"], languages: ["TypeScript"], location: "Europe" };
const mismatchCriteria = { skills: ["Rust", "WebAssembly"], languages: ["Rust"], location: "Japan" };

// ─── Scoring tests ───────────────────────────────────

test("Weights sum to 1.0", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1.0) < 0.001, `Weights sum = ${sum}, expected 1.0`);
});

test("Strong profile + matching criteria = high score", () => {
  const result = calculateFitScore(strongProfile, matchingCriteria);
  assert(result.fitScore >= 65, `fitScore ${result.fitScore} should be >= 65`);
  assert(result.confidenceScore >= 70, `confidenceScore ${result.confidenceScore} should be >= 70`);
  assert(result.explanation.length > 0, "Should have non-empty explanation");
  assert(result.explanation.includes("React") || result.explanation.includes("TypeScript"), "Explanation should mention matched skills");
});

test("Strong profile + mismatched criteria = low score", () => {
  const result = calculateFitScore(strongProfile, mismatchCriteria);
  assert(result.fitScore < 50, `fitScore ${result.fitScore} should be < 50 for mismatched criteria`);
});

test("Weak profile = low score regardless of criteria", () => {
  const result = calculateFitScore(weakProfile, matchingCriteria);
  assert(result.fitScore < 30, `fitScore ${result.fitScore} should be < 30 for weak profile`);
  assert(result.confidenceScore < 60, `confidenceScore ${result.confidenceScore} should be < 60 (missing data)`);
});

test("Empty criteria = neutral scores (50)", () => {
  const result = calculateFitScore(strongProfile, { skills: [], languages: [] });
  assert(result.fitScore > 30 && result.fitScore < 80, `fitScore ${result.fitScore} should be moderate with no criteria`);
});

test("Fit score is always 0-100", () => {
  for (const profile of [strongProfile, weakProfile]) {
    for (const criteria of [matchingCriteria, mismatchCriteria, {}]) {
      const r = calculateFitScore(profile, criteria);
      assert(r.fitScore >= 0 && r.fitScore <= 100, `fitScore ${r.fitScore} out of range for ${profile.login}`);
      assert(r.confidenceScore >= 0 && r.confidenceScore <= 100, `confidenceScore ${r.confidenceScore} out of range`);
    }
  }
});

test("Breakdown has all expected keys", () => {
  const result = calculateFitScore(strongProfile, matchingCriteria);
  const expectedKeys = ["skillLanguageMatch", "repoRelevance", "recentActivity", "projectCredibility", "locationRelevance", "contactability"];
  for (const key of expectedKeys) {
    assert(key in result.breakdown, `Missing breakdown key: ${key}`);
    assert("score" in result.breakdown[key], `Missing score in ${key}`);
    assert("weight" in result.breakdown[key], `Missing weight in ${key}`);
    assert("weighted" in result.breakdown[key], `Missing weighted in ${key}`);
  }
});

test("Weighted scores sum to fitScore", () => {
  const result = calculateFitScore(strongProfile, matchingCriteria);
  const sumWeighted = Object.values(result.breakdown).reduce((a, b) => a + b.weighted, 0);
  assert(Math.abs(sumWeighted - result.fitScore) <= 1, `Weighted sum ${sumWeighted} != fitScore ${result.fitScore}`);
});

// ─── ExternalTalentLead builder ──────────────────────

test("buildExternalTalentLead returns correct shape", () => {
  const lead = buildExternalTalentLead(strongProfile, matchingCriteria);

  assert(lead.id === "gh_janedoe", `id should be gh_janedoe, got ${lead.id}`);
  assert(lead.source === "github", `source should be github, got ${lead.source}`);
  assert(lead.githubLogin === "janedoe", "githubLogin");
  assert(lead.displayName === "Jane Doe", "displayName");
  assert(typeof lead.fitScore === "number", "fitScore should be number");
  assert(typeof lead.confidenceScore === "number", "confidenceScore should be number");
  assert(typeof lead.fitExplanation === "string", "fitExplanation should be string");
  assert(lead.fitBreakdown !== null, "fitBreakdown should exist");
  assert(lead.consentStatus === "not_contacted", "consentStatus default");
  assert(lead.inviteStatus === "not_invited", "inviteStatus default");
  assert(lead.convertedWorkerId === null, "convertedWorkerId default null");
  assert(Array.isArray(lead.inferredSkills), "inferredSkills should be array");
  assert(Array.isArray(lead.topLanguages), "topLanguages should be array");
  assert(Array.isArray(lead.relevantRepositories), "relevantRepositories should be array");
  assert(lead.createdAt !== null, "createdAt should be set");
  assert(lead.updatedAt !== null, "updatedAt should be set");
});

test("buildExternalTalentLead infers matched skills", () => {
  const lead = buildExternalTalentLead(strongProfile, matchingCriteria);
  // "React" appears in topics and bio, "Node.js" in bio and topics, "GraphQL" in description/topics
  assert(lead.inferredSkills.includes("React"), `Should infer React, got ${lead.inferredSkills}`);
  assert(lead.inferredSkills.includes("Node.js"), `Should infer Node.js, got ${lead.inferredSkills}`);
  assert(lead.inferredSkills.includes("GraphQL"), `Should infer GraphQL, got ${lead.inferredSkills}`);
});

test("buildExternalTalentLead deduplicates repos", () => {
  const profileWithDups = {
    ...strongProfile,
    searchMatchedRepos: [strongProfile.topRepos[0]], // same repo as in topRepos
  };
  const lead = buildExternalTalentLead(profileWithDups, matchingCriteria);
  const repoNames = lead.relevantRepositories.map(r => r.name);
  const unique = new Set(repoNames);
  assert(repoNames.length === unique.size, `Repos should be deduplicated, got ${repoNames}`);
});

// ─── Location scoring ────────────────────────────────

test("Location: exact match = 100", () => {
  const result = calculateFitScore({ ...strongProfile, location: "London" }, { ...matchingCriteria, location: "London" });
  assert(result.breakdown.locationRelevance.score === 100, `Expected 100, got ${result.breakdown.locationRelevance.score}`);
});

test("Location: same region = 70", () => {
  const result = calculateFitScore({ ...strongProfile, location: "Berlin, Germany" }, { ...matchingCriteria, location: "Europe" });
  assert(result.breakdown.locationRelevance.score === 70, `Expected 70, got ${result.breakdown.locationRelevance.score}`);
});

test("Location: no preference = 50 (neutral)", () => {
  const result = calculateFitScore(strongProfile, { ...matchingCriteria, location: null });
  assert(result.breakdown.locationRelevance.score === 50, `Expected 50, got ${result.breakdown.locationRelevance.score}`);
});

test("Location: unknown profile location = 30", () => {
  const result = calculateFitScore({ ...strongProfile, location: null }, { ...matchingCriteria, location: "Europe" });
  assert(result.breakdown.locationRelevance.score === 30, `Expected 30, got ${result.breakdown.locationRelevance.score}`);
});

// ─── Activity recency scoring ────────────────────────

test("Activity: last_30_days = 100", () => {
  const r = calculateFitScore({ ...strongProfile, activityRecency: "last_30_days" }, matchingCriteria);
  assert(r.breakdown.recentActivity.score === 100, `Expected 100, got ${r.breakdown.recentActivity.score}`);
});

test("Activity: over_year = 10", () => {
  const r = calculateFitScore({ ...strongProfile, activityRecency: "over_year" }, matchingCriteria);
  assert(r.breakdown.recentActivity.score === 10, `Expected 10, got ${r.breakdown.recentActivity.score}`);
});

// ─── Query builders ──────────────────────────────────

test("buildRepoQuery includes language qualifiers", () => {
  const q = buildRepoQuery({ languages: ["Python", "Rust"], skills: ["ML"], keywords: [] });
  assert(q.includes('language:"Python"'), `Should include Python language qualifier`);
  assert(q.includes('language:"Rust"'), `Should include Rust language qualifier`);
  assert(q.includes("ML"), `Should include skill term`);
  assert(q.includes("stars:>=5"), "Should require minimum stars");
  assert(q.includes("pushed:>"), "Should have recency filter");
});

test("buildRepoQuery limits languages to 3", () => {
  const q = buildRepoQuery({ languages: ["Python", "Rust", "Go", "Java", "C++"], skills: [] });
  const langCount = (q.match(/language:/g) || []).length;
  assert(langCount <= 3, `Should limit to 3 languages, got ${langCount}`);
});

test("buildUserQuery includes location", () => {
  const q = buildUserQuery({ skills: ["React"], keywords: [], location: "San Francisco" });
  assert(q.includes('location:"San Francisco"'), `Should include location qualifier`);
  assert(q.includes("repos:>=3"), "Should require minimum repos");
});

test("buildUserQuery without location", () => {
  const q = buildUserQuery({ skills: ["React"], keywords: [], location: null });
  assert(!q.includes("location:"), "Should not include location when null");
});

// ─── Contactability scoring ──────────────────────────

test("Contactability: full info = high score", () => {
  const r = calculateFitScore(strongProfile, matchingCriteria);
  assert(r.breakdown.contactability.score >= 80, `Expected >= 80, got ${r.breakdown.contactability.score}`);
});

test("Contactability: no info = low score", () => {
  const r = calculateFitScore(weakProfile, matchingCriteria);
  assert(r.breakdown.contactability.score <= 20, `Expected <= 20, got ${r.breakdown.contactability.score}`);
});

// ─── Summary ─────────────────────────────────────────

console.log(`\n${"═".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
}
