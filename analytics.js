// Analytics aggregation over the audit log — pure functions, easily tested.

// ISO week number label, e.g. "W24"
function weekLabel(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `W${week}`;
}

// Build the analytics payload from intake + handoff audit records.
function computeAnalytics(intakes, handoffs, { recentLimit = 20, weeks = 6 } = {}) {
  const jobByIntake = new Map();
  for (const h of handoffs) {
    if (h.intakeId && h.job_id) jobByIntake.set(h.intakeId, h.job_id);
  }

  const total = intakes.length;
  const worksome = intakes.filter(r => r.route === "worksome").length;
  const vms = total - worksome;

  const durations = intakes.map(r => r.duration_seconds).filter(s => Number.isFinite(s) && s > 0 && s < 3600);
  const avgDurationSeconds = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  const recent = intakes.slice(-recentLimit).reverse().map(r => ({
    id: r.id,
    date: (r.ts || "").slice(0, 10),
    role: r.role_title || "Role",
    route: r.route,
    confidence: r.confidence || "medium",
    status: jobByIntake.has(r.id) ? "job_created" : (r.approval_required ? "pending_approval" : "routed"),
    manager: r.manager || (r.channel === "slack" ? "Slack user" : "Web portal"),
    channel: r.channel || "web",
    durationSeconds: Number.isFinite(r.duration_seconds) ? r.duration_seconds : null,
  }));

  // Last N ISO weeks, oldest → newest
  const weekKeys = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * 86400000);
    const label = weekLabel(d);
    if (!weekKeys.includes(label)) weekKeys.push(label);
  }
  const volByWeek = Object.fromEntries(weekKeys.map(w => [w, { week: w, worksome: 0, vms: 0 }]));
  const durByWeek = Object.fromEntries(weekKeys.map(w => [w, []]));

  for (const r of intakes) {
    const w = weekLabel(new Date(r.ts));
    if (volByWeek[w]) {
      volByWeek[w][r.route === "worksome" ? "worksome" : "vms"]++;
      if (Number.isFinite(r.duration_seconds) && r.duration_seconds > 0 && r.duration_seconds < 3600) {
        durByWeek[w].push(r.duration_seconds);
      }
    }
  }

  return {
    total,
    worksome,
    vms,
    avgDurationSeconds,
    recent,
    weeklyVolume: weekKeys.map(w => volByWeek[w]),
    avgDurationWeekly: weekKeys.map(w => ({
      week: w,
      seconds: durByWeek[w].length ? Math.round(durByWeek[w].reduce((a, b) => a + b, 0) / durByWeek[w].length) : 0,
    })),
  };
}

module.exports = { computeAnalytics, weekLabel };
