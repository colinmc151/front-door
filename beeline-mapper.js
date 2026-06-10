// Beeline requisition mapping — turns a routing decision into the
// requisition payload defined in output-schemas.md. Used today for the
// requisition preview; the real `POST /requisitions` call slots in behind
// it when a Beeline (or other VMS) API connection is configured.
const { durationToMonths, parseAmount } = require("./approval");

const iso = d => (d ? d.toISOString().slice(0, 10) : null);

function buildRequisition(routeResult, opts = {}) {
  const r = routeResult || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const months = durationToMonths(r.duration);
  const endDate = months ? new Date(now.getTime() + months * 30 * 86400000) : null;

  // SOW for deliverable-style payment, staff augmentation otherwise
  const requisitionType = ["milestone", "fixed"].includes(r.payment_model) ? "SOW" : "STAFF_AUG";
  const rateType = r.payment_model === "hourly" ? "HOURLY" : r.payment_model === "daily" ? "DAILY" : null;

  const loc = String(r.location || "").toLowerCase();
  const remoteAllowed = !loc || loc.includes("remote") || loc.includes("hybrid");

  return {
    requisition: {
      title: r.role_title || "New Role",
      description: r.description || null,
      jobCategory: (r.skills && r.skills[0]) || r.role_title || null, // taxonomy table comes later
      requisitionType,
      numberOfPositions: Number(r.headcount) || 1,
      startDate: iso(now),
      endDate: iso(endDate),
      estimatedDuration: r.duration || null,
      rateType,
      maxBillRate: parseAmount(r.budget),
      currency: opts.currency || null,
      location: {
        site: null,
        city: null,
        country: null,
        remoteAllowed,
      },
      approvalStatus: opts.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
      metadata: {
        source: "front-door",
        routing_confidence: r.confidence || "medium",
        intake_session_id: r._intakeId || null,
      },
    },
  };
}

module.exports = { buildRequisition };
