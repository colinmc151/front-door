// Worksome Talent Pool — fit scoring engine
// Produces an explainable score (0–100) for how well a worker matches search criteria

const WS_WEIGHTS = {
  skillMatch: 0.45,
  titleRelevance: 0.20,
  engagementHistory: 0.15,
  availability: 0.10,
  profileCompleteness: 0.10,
};

// ─── Sub-scorers (each returns 0–100) ─────────────────

function scoreSkillMatch(worker, criteria) {
  const { skills: searchedSkills = [] } = criteria;
  if (searchedSkills.length === 0) return { score: 50, reasons: [] };

  const workerSkills = (worker.skills || []).map(s => s.toLowerCase());
  const reasons = [];
  let matches = 0;

  for (const skill of searchedSkills) {
    const s = skill.toLowerCase();
    if (workerSkills.some(ws => ws.includes(s) || s.includes(ws))) {
      matches++;
      reasons.push(skill);
    }
  }

  const score = searchedSkills.length > 0
    ? Math.min(100, Math.round((matches / searchedSkills.length) * 120))
    : 50;

  return { score, reasons };
}

function scoreTitleRelevance(worker, criteria) {
  const { skills: searchedSkills = [], keywords = [] } = criteria;
  const title = (worker.title || '').toLowerCase();
  if (!title) return { score: 20, reasons: [] };

  const terms = [...searchedSkills, ...keywords].map(s => s.toLowerCase());
  const reasons = [];
  let matches = 0;

  for (const term of terms) {
    if (title.includes(term)) {
      matches++;
      if (reasons.length < 2) reasons.push(term);
    }
  }

  // Also check if title sounds technical/relevant
  const titleWords = title.split(/\s+/);
  const seniorityBonus = titleWords.some(w => ['senior', 'lead', 'principal', 'staff', 'head'].includes(w)) ? 10 : 0;

  const score = Math.min(100, (matches > 0 ? 50 + matches * 20 : 20) + seniorityBonus);
  return { score, reasons: reasons.length > 0 ? [`title: ${worker.title}`] : [] };
}

function scoreEngagementHistory(worker) {
  let score = 0;
  const reasons = [];

  // Previous paid work = trusted
  if (worker.totalPaid > 0) {
    score += 50;
    reasons.push('previous engagement');
  }

  // Currently hired = high trust but may not be available
  if (worker.isCurrentlyHired) {
    score += 20;
    reasons.push('currently hired');
  }

  // Day rate set = professional
  if (worker.dayRate) {
    score += 20;
    reasons.push(`${worker.currency || ''} ${worker.dayRate}/day`.trim());
  }

  return { score: Math.min(100, score || 10), reasons };
}

function scoreAvailability(worker) {
  let score = 50; // neutral by default
  const reasons = [];

  if (worker.isCurrentlyHired) {
    score = 30; // may be busy
    reasons.push('currently on a hire');
  } else if (worker.totalPaid > 0) {
    score = 80; // known, not currently busy
    reasons.push('available (not currently hired)');
  }

  return { score, reasons };
}

function scoreProfileCompleteness(worker) {
  let score = 0;
  const reasons = [];

  if (worker.name) score += 15;
  if (worker.title) score += 15;
  if (worker.email) score += 15;
  if (worker.bio) { score += 15; reasons.push('has bio'); }
  if (worker.avatar) { score += 10; reasons.push('has photo'); }
  if (worker.location) { score += 10; reasons.push(worker.location); }
  if ((worker.skills || []).length >= 3) score += 10;
  if (worker.dayRate) score += 10;

  return { score: Math.min(100, score), reasons };
}

// ─── Main scoring function ────────────────────────────

function calculateWorksomeFitScore(worker, criteria) {
  const sub = {
    skillMatch: scoreSkillMatch(worker, criteria),
    titleRelevance: scoreTitleRelevance(worker, criteria),
    engagementHistory: scoreEngagementHistory(worker),
    availability: scoreAvailability(worker),
    profileCompleteness: scoreProfileCompleteness(worker),
  };

  // Weighted total
  let fitScore = 0;
  for (const [key, weight] of Object.entries(WS_WEIGHTS)) {
    fitScore += sub[key].score * weight;
  }
  fitScore = Math.round(fitScore);

  // Build explanation
  const allReasons = [];
  for (const [, result] of Object.entries(sub)) {
    allReasons.push(...result.reasons);
  }
  const explanation = allReasons.length > 0
    ? `Matched on ${allReasons.slice(0, 4).join(', ')}${allReasons.length > 4 ? ` +${allReasons.length - 4} more` : ''}.`
    : 'Limited profile data available.';

  return {
    fitScore,
    explanation,
    breakdown: Object.fromEntries(
      Object.entries(sub).map(([k, v]) => [k, { score: v.score, weight: WS_WEIGHTS[k], weighted: Math.round(v.score * WS_WEIGHTS[k]) }])
    ),
  };
}

// ─── Enrich worker with scoring ───────────────────────

function scoreWorker(worker, criteria) {
  const scoring = calculateWorksomeFitScore(worker, criteria);
  return {
    ...worker,
    fitScore: scoring.fitScore,
    fitExplanation: scoring.explanation,
    fitBreakdown: scoring.breakdown,
  };
}

module.exports = { calculateWorksomeFitScore, scoreWorker, WS_WEIGHTS };
