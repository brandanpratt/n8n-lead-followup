// Sanity-checks the exported workflow before committing or importing.
// Usage: node scripts/validate-workflow.mjs [path/to/workflow.json]
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('../workflow/lead-followup.json', import.meta.url);
const errors = [];
let wf;

try {
  wf = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Invalid JSON: ${err.message}`);
  process.exit(1);
}

const names = new Set();
for (const node of wf.nodes ?? []) {
  if (names.has(node.name)) errors.push(`Duplicate node name: ${node.name}`);
  names.add(node.name);
  for (const key of ['id', 'type', 'typeVersion', 'position']) {
    if (node[key] === undefined) errors.push(`${node.name}: missing "${key}"`);
  }
}

for (const [source, outputs] of Object.entries(wf.connections ?? {})) {
  if (!names.has(source)) errors.push(`Connection from unknown node: ${source}`);
  for (const branch of outputs.main ?? []) {
    for (const link of branch ?? []) {
      if (!names.has(link.node)) errors.push(`${source} -> unknown node: ${link.node}`);
    }
  }
}

// Every node except the trigger should be reachable from something.
const targets = new Set(
  Object.values(wf.connections ?? {}).flatMap((o) => (o.main ?? []).flat().map((l) => l?.node)),
);
for (const node of wf.nodes ?? []) {
  if (!node.type.endsWith('.webhook') && !node.type.endsWith('.stickyNote') && !targets.has(node.name)) {
    errors.push(`Orphan node (nothing connects to it): ${node.name}`);
  }
}

// Expressions like $('Node Name') must point at real nodes.
const raw = JSON.stringify(wf.nodes);
for (const [, ref] of raw.matchAll(/\$\(\\?["']([^"'\\]+)\\?["']\)/g)) {
  if (!names.has(ref)) errors.push(`Expression references unknown node: ${ref}`);
}

// No real secrets should ever be committed.
if (/sk-[A-Za-z0-9_-]{20,}|\d{8,10}:[A-Za-z0-9_-]{35}/.test(JSON.stringify(wf))) {
  errors.push('Possible API key or bot token found in workflow JSON');
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${wf.nodes.length} nodes, connections and expressions look valid`);
