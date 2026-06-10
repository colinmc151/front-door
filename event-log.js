// Append-only JSONL event log — dependency-free persistence for audit
// records and webhook events. One file per log under data/, loaded into
// memory at boot, appended synchronously (records are small and rare).
// Records are never mutated or deleted — audit-trail semantics.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");

class JsonlLog {
  constructor(name) {
    this.file = path.join(DATA_DIR, `${name}.jsonl`);
    this.records = [];
    try {
      const lines = fs.readFileSync(this.file, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.records.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
      }
    } catch { /* no file yet */ }
  }

  append(obj) {
    const record = {
      id: crypto.randomBytes(8).toString("hex"),
      ts: new Date().toISOString(),
      ...obj,
    };
    this.records.push(record);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch (err) {
      console.error(`[EventLog] Failed to persist to ${this.file}:`, err.message);
    }
    return record;
  }

  all() {
    return this.records;
  }

  recent(limit = 50) {
    return this.records.slice(-limit).reverse();
  }
}

const logs = new Map();
function open(name) {
  if (!logs.has(name)) logs.set(name, new JsonlLog(name));
  return logs.get(name);
}

module.exports = { open };
