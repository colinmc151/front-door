// Dev tool: introspect Worksome GraphQL input types (read-only).
// Safer replacement for the removed debug HTTP endpoints — runs locally only.
//
// Usage: node scripts/introspect-worksome.js [TypeName ...]
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fetch = require("node-fetch");

const URL = process.env.WORKSOME_API_URL || "https://general-api.sand.aws.worksome.com/graphql";
const TOKEN = process.env.WORKSOME_API_TOKEN;

async function gql(query) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join("; "));
  return data.data;
}

function typeName(t) {
  if (!t) return "?";
  if (t.name) return t.name;
  if (t.kind === "NON_NULL") return typeName(t.ofType) + "!";
  if (t.kind === "LIST") return "[" + typeName(t.ofType) + "]";
  return t.kind;
}

async function main() {
  if (!TOKEN) { console.error("WORKSOME_API_TOKEN not set"); process.exit(1); }

  const types = process.argv.slice(2);
  if (types.length === 0) {
    // Default: find mutations related to the fast-track flows
    const data = await gql(`{ __schema { mutationType { fields { name args { name type { name kind ofType { name kind ofType { name } } } } } } } }`);
    const re = /trustedcontact|drafthire|milestone|hire|invite/i;
    for (const m of data.__schema.mutationType.fields.filter(f => re.test(f.name))) {
      console.log(`${m.name}(${m.args.map(a => `${a.name}: ${typeName(a.type)}`).join(", ")})`);
    }
    return;
  }

  for (const name of types) {
    const data = await gql(`{ __type(name: "${name.replace(/[^A-Za-z0-9_]/g, "")}") {
      name kind
      inputFields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } }
      fields { name type { name kind ofType { name kind ofType { name } } } }
    } }`);
    const t = data.__type;
    if (!t) { console.log(`${name}: NOT FOUND`); continue; }
    console.log(`\n${t.kind} ${t.name}:`);
    for (const f of (t.inputFields || t.fields || [])) {
      console.log(`  ${f.name}: ${typeName(f.type)}`);
    }
  }
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
