// Approval gate evaluation — turns the configurable gates
// (e.g. "spend > 100000" → "procurement_review") into real checks
// against a completed routing decision.
//
// Condition grammar:  <field> <op> <value>
// Fields:  spend|budget, headcount, duration_months, route, known_worker, confidence
// Ops:     > >= < <= == = !=

// Pull a number out of free text like "£120k", "100,000", "around 50000 EUR"
function parseAmount(text) {
  if (text == null) return null;
  if (typeof text === "number") return text;
  const m = String(text).replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2]) n *= m[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
  return n;
}

// "6 weeks" → 1.4, "3 months" → 3, "1 year" → 12, "90 days" → 3
function durationToMonths(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(day|week|month|year|wk|mo|yr)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("day")) return +(n / 30).toFixed(1);
  if (unit.startsWith("w")) return +(n / 4.33).toFixed(1);
  if (unit.startsWith("y")) return n * 12;
  return n; // months
}

function fieldValue(field, routeResult) {
  switch (field) {
    case "spend":
    case "budget": return parseAmount(routeResult.budget);
    case "headcount": return Number(routeResult.headcount) || 1;
    case "duration_months": return durationToMonths(routeResult.duration);
    case "route": return routeResult.route || null;
    case "known_worker": return !!routeResult.known_worker;
    case "confidence": return routeResult.confidence || null;
    default: return undefined; // unknown field — gate is skipped
  }
}

function compare(actual, op, expected) {
  if (actual === null || actual === undefined) return false; // missing data never triggers
  if (typeof actual === "number") {
    const num = parseAmount(expected);
    if (num === null) return false;
    switch (op) {
      case ">": return actual > num;
      case ">=": return actual >= num;
      case "<": return actual < num;
      case "<=": return actual <= num;
      case "==": case "=": return actual === num;
      case "!=": return actual !== num;
    }
  }
  const a = String(actual).toLowerCase();
  const b = String(expected).trim().toLowerCase().replace(/^["']|["']$/g, "");
  switch (op) {
    case "==": case "=": return a === b;
    case "!=": return a !== b;
    default: return false; // ordering ops don't apply to strings
  }
}

// Returns the first triggered gate: { condition, action } — or null.
function evaluateGates(gates, routeResult) {
  if (!Array.isArray(gates) || !routeResult) return null;
  for (const gate of gates) {
    if (!gate || !gate.condition || !gate.action) continue;
    const m = String(gate.condition).trim().match(/^(\w+)\s*(>=|<=|!=|==|=|>|<)\s*(.+)$/);
    if (!m) continue; // unparseable condition — skip, never block on bad config
    const [, field, op, value] = m;
    const actual = fieldValue(field.toLowerCase(), routeResult);
    if (actual === undefined) continue;
    if (compare(actual, op, value)) {
      return { condition: gate.condition, action: gate.action };
    }
  }
  return null;
}

module.exports = { evaluateGates, parseAmount, durationToMonths };
