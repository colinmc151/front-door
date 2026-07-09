// Talent fixtures — optional, env-configured contacts merged into talent
// pool search results. Useful for demo deployments whose API token cannot
// see the target account's pool (set TALENT_FIXTURES to a JSON array).
//
// Fixture shape (all fields optional except name):
//   { "id": "fixture-1", "name": "Craig Strawberry", "title": "Developer",
//     "skills": ["Java Developer"], "location": "Glasgow, United Kingdom",
//     "hiresCount": 0, "previouslyEngaged": false }
//
// Without TALENT_FIXTURES set, this module is a no-op.

let FIXTURES = [];
try {
  if (process.env.TALENT_FIXTURES) {
    const parsed = JSON.parse(process.env.TALENT_FIXTURES);
    if (Array.isArray(parsed)) {
      FIXTURES = parsed
        .filter((f) => f && typeof f === "object" && typeof f.name === "string")
        .map((f, i) => ({
          id: f.id || `fixture-${i + 1}`,
          name: f.name,
          firstName: f.firstName || f.name.split(" ")[0] || null,
          lastName: f.lastName || f.name.split(" ").slice(1).join(" ") || null,
          title: f.title || null,
          avatar: f.avatar || null,
          bio: f.bio || null,
          location: f.location || null,
          skills: Array.isArray(f.skills) ? f.skills : [],
          companySkills: [],
          customFields: null,
          dayRate: f.dayRate || null,
          currency: f.currency || null,
          isCurrentlyHired: !!f.isCurrentlyHired,
          totalPaid: f.previouslyEngaged ? 1 : 0,
          notesCount: 0,
          hiresCount: f.hiresCount || 0,
          hires: [],
          isFixture: true,
        }));
      console.log(`[Fixtures] Loaded ${FIXTURES.length} talent fixture(s)`);
    }
  }
} catch (err) {
  console.warn(`[Fixtures] Failed to parse TALENT_FIXTURES: ${err.message}`);
}

const norm = (s) => (s || "").toLowerCase();

function searchByName(name) {
  const q = norm(name);
  if (!q || FIXTURES.length === 0) return [];
  return FIXTURES.filter((f) => norm(f.name).includes(q) || q.includes(norm(f.lastName)));
}

function searchBySkills(skillNames) {
  if (!Array.isArray(skillNames) || skillNames.length === 0 || FIXTURES.length === 0) return [];
  const wanted = skillNames.map(norm).filter(Boolean);
  return FIXTURES.filter((f) =>
    f.skills.some((s) => wanted.some((w) => norm(s).includes(w) || w.includes(norm(s))))
  );
}

// Merge: real API results win; fixtures only fill in contacts the API
// didn't return (deduplicated by lowercased name). Real records carry real
// worker ids, so downstream deep links (e.g. /profile/<id>/hire) resolve.
function merge(fixtureMatches, apiResults) {
  const api = apiResults || [];
  const seen = new Set(api.map((w) => norm(w.name)));
  return [...api, ...fixtureMatches.filter((f) => !seen.has(norm(f.name)))];
}

const enabled = () => FIXTURES.length > 0;

module.exports = { searchByName, searchBySkills, merge, enabled };
