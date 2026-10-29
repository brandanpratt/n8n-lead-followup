// Tests the workflow's Code-node logic outside n8n by mocking $() and $input.
// Usage: node scripts/test-code-nodes.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const wf = JSON.parse(readFileSync(new URL('../workflow/lead-followup.json', import.meta.url), 'utf8'));
const code = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;
const run = (name, { nodes = {}, input = [] }) => {
  const $ = (n) => {
    if (!(n in nodes)) return { isExecuted: false, first: () => { throw new Error(`no ${n}`); } };
    return { isExecuted: true, first: () => ({ json: nodes[n] }) };
  };
  const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
  return new Function('$', '$input', '$json', code(name))($, $input, input[0])[0].json;
};
const cfg = { businessName: 'Acme & Co', duplicateWindowDays: 7, aiMaxChars: 2000 };
const lead = { name: 'Jasmine Rolle', email: 'j@example.com', phone: '', company: 'R<b>', message: 'Need a <site> & app', leadId: 'L-1' };
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();

// Check Duplicate
const dup = (rows) => run('Check Duplicate', { nodes: { Config: cfg, 'Validate Submission': lead }, input: rows });
assert.equal(dup([{}]).isDuplicate, false, 'empty sheet');
assert.equal(dup([{ error: 'sheet down' }]).isDuplicate, false, 'lookup failed');
assert.equal(dup([{ Email: 'J@example.com', Status: 'Sent', 'Submitted At': daysAgo(2), 'Lead ID': 'L-0' }]).isDuplicate, true, 'recent sent');
assert.equal(dup([{ Email: 'j@example.com', Status: 'New', 'Submitted At': daysAgo(0) }]).isDuplicate, true, 'double submit');
assert.equal(dup([{ Email: 'j@example.com', Status: 'Sent', 'Submitted At': daysAgo(9) }]).isDuplicate, false, 'outside window');
assert.equal(dup([{ Email: 'j@example.com', Status: 'Email failed', 'Submitted At': daysAgo(1) }]).isDuplicate, false, 'previous failed → retry');
assert.equal(dup([{ Email: 'j@example.com', Status: 'Sent', 'Submitted At': daysAgo(1), 'Lead ID': 'L-0' }]).previousLeadId, 'L-0');

// Parse AI Reply: OpenAI node v1.8 shapes + junk
const parse = (out) => run('Parse AI Reply', { nodes: { Config: cfg, 'Check Duplicate': lead }, input: [out] });
const good = { is_spam: false, spam_reason: '', subject: 'Your\nsite', body: 'Hi Jasmine,\n...' };
assert.deepEqual(parse({ message: { role: 'assistant', content: good } }), { isSpam: false, spamReason: '', usedFallback: false, subject: 'Your site', body: 'Hi Jasmine,\n...' });
assert.equal(parse({ message: { content: JSON.stringify(good) } }).usedFallback, false, 'string JSON content');
assert.equal(parse({ choices: [{ message: { content: JSON.stringify(good) } }] }).usedFallback, false, 'raw shape');
assert.equal(parse({ message: { content: { is_spam: true, spam_reason: 'SEO pitch', subject: '', body: '' } } }).isSpam, true);
const fb = parse({ message: { content: 'Sure! Here is your email...' } });
assert.equal(fb.usedFallback, true); assert.match(fb.body, /^Hi Jasmine,/); assert.match(fb.subject, /Acme & Co/);
assert.equal(parse({ message: { content: { is_spam: false, subject: '', body: '' } } }).usedFallback, true, 'empty draft');

// Build Notification: escaping + statuses
const note = (nodes) => run('Build Notification', { nodes: { 'Check Duplicate': lead, ...nodes } }).text;
const sent = note({ 'Parse AI Reply': { isSpam: false, usedFallback: false, subject: 'Hi <there>', body: 'b' } });
assert.match(sent, /✅ AI follow-up sent/); assert.match(sent, /R&lt;b&gt;/); assert.match(sent, /&lt;site&gt; &amp; app/); assert.match(sent, /Hi &lt;there&gt;/);
assert.doesNotMatch(sent, /Phone/, 'empty phone omitted');
assert.match(note({ 'Parse AI Reply': { isSpam: true, spamReason: 'pitch' } }), /🚫 Flagged as spam/);
assert.match(run('Build Notification', { nodes: { 'Check Duplicate': { ...lead, isDuplicate: true, previousLeadId: 'L-0' } } }).text, /🔁 Duplicate.*L-0/);
const long = run('Build Notification', { nodes: { 'Check Duplicate': { ...lead, message: 'x'.repeat(5000) }, 'Parse AI Reply': { isSpam: false, subject: 's', body: 'y'.repeat(3000) } } }).text;
assert.ok(long.length < 4096, `telegram limit, got ${long.length}`);

// Build Alert: error shapes
const alert = (json) => run('Build Alert', { nodes: { 'Check Duplicate': lead }, input: [{ failedStep: 'Email', ...json }] });
assert.equal(alert({ error: { message: 'Invalid grant' } }).errorMessage, 'Invalid grant');
assert.equal(alert({ error: 'Quota exceeded' }).errorMessage, 'Quota exceeded');
assert.equal(alert({}).errorMessage, 'Unknown error');
console.log('✓ all Code node checks passed');
