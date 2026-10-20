// Deliberately small method surface: read-only, pinned-block execution.
export const METHODS = Object.freeze([
  'eth_chainId', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getCode', 'eth_getStorageAt', 'eth_getBlockByNumber'
]);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const quantity = v => typeof v === 'string' && v.length <= 66 && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v);
const address = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const data = v => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
const hash = v => data(v) && v.length === 66;
const fail = message => { throw new Error(message); };
function boundedTree(value, depth = 0, budget = { n: 0 }) {
  if (++budget.n > 20000 || depth > 32) fail('JSON exceeds structural limits');
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('Unsafe JSON number');
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Reserved JSON key');
      boundedTree(value[key], depth + 1, budget);
    }
  }
}
export function parseJSON(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576) fail('JSON exceeds 1 MiB');
  let value;
  try { value = JSON.parse(text); } catch { fail('Invalid JSON'); }
  boundedTree(value);
  return value;
}
export function validateSuite(suite) {
  if (!object(suite) || suite.version !== 1 || !quantity(suite.block)) fail('Suite needs version 1 and a fixed hexadecimal block');
  if (suite.label !== undefined && (typeof suite.label !== 'string' || suite.label.length > 120)) fail('Invalid suite label');
  if (!Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > 100) fail('Suite needs 1–100 cases');
  const names = new Set();
  for (const c of suite.cases) {
    if (!object(c) || typeof c.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.name) || names.has(c.name)) fail('Case names must be unique safe identifiers');
    names.add(c.name);
    if (!METHODS.includes(c.method) || !Array.isArray(c.params)) fail('Unsupported method or parameters');
    const p = c.params;
    let valid = false;
    switch (c.method) {
      case 'eth_chainId': valid = p.length === 0; break;
      case 'eth_getBlockByNumber': valid = p.length === 2 && p[0] === suite.block && p[1] === false; break;
      case 'eth_getStorageAt': valid = p.length === 3 && address(p[0]) && quantity(p[1]) && p[1].length <= 66 && p[2] === suite.block; break;
      default: valid = p.length === 2 && address(p[0]) && p[1] === suite.block;
    }
    if (!valid) fail(`Invalid pinned parameters for ${c.name}`);
  }
  return suite;
}
export function validateResponse(response, id, method) {
  const errors = [];
  if (!object(response)) return ['Response must be an object'];
  if (response.jsonrpc !== '2.0') errors.push('jsonrpc must be 2.0');
  if (response.id !== id) errors.push('Response id does not match request');
  const hasResult = own(response, 'result'), hasError = own(response, 'error');
  if (hasResult === hasError) errors.push('Response needs exactly one of result or error');
  if (hasError) {
    if (!object(response.error) || !Number.isSafeInteger(response.error.code) ||
        typeof response.error.message !== 'string') errors.push('Invalid JSON-RPC error');
  }
  if (hasResult) {
    const r = response.result;
    if (['eth_chainId', 'eth_getBalance', 'eth_getTransactionCount'].includes(method) && !quantity(r)) errors.push('Result must be a minimally encoded hex quantity');
    if (method === 'eth_getCode' && !data(r)) errors.push('Code must contain complete hexadecimal bytes');
    if (method === 'eth_getStorageAt' && !hash(r)) errors.push('Storage result must be 32 bytes');
    if (method === 'eth_getBlockByNumber' && r !== null) {
      if (!object(r) || !quantity(r.number) || !hash(r.hash) || !hash(r.parentHash) ||
          !Array.isArray(r.transactions) || !r.transactions.every(hash)) {
        errors.push('Block requires number, hash, parentHash and transaction hashes');
      }
    }
  }
  return errors;
}
function canonical(value) {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function diff(left, right, limit = 50) {
  const changes = [];
  function walk(a, b, path) {
    if (changes.length >= limit || JSON.stringify(a) === JSON.stringify(b)) return;
    if (object(a) && object(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk(a[key], b[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      }
    } else if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length) && changes.length < limit; i++) walk(a[i], b[i], `${path}/${i}`);
    } else changes.push({ path: path || '/', left: a === undefined ? { missing: true } : a, right: b === undefined ? { missing: true } : b });
  }
  walk(canonical(left), canonical(right), '');
  return changes;
}
function comparable(response) {
  if (own(response, 'error')) {
    // Error prose is provider-specific; preserve it in evidence, compare code/data.
    return { error: { code: response.error.code, ...(own(response.error, 'data') ? { data: response.error.data } : {}) } };
  }
  return { result: response.result };
}
export function comparePair(left, right, id, method) {
  const validation = { left: validateResponse(left, id, method), right: validateResponse(right, id, method) };
  if (validation.left.length || validation.right.length) return { status: 'invalid', validation, changes: [] };
  const changes = diff(comparable(left), comparable(right));
  const bothErrors = own(left, 'error') && own(right, 'error');
  return { status: changes.length ? 'divergent' : bothErrors ? 'matching-error' : 'match', validation, changes };
}
async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}
export async function runSuite(suite, transports, options = {}) {
  validateSuite(suite);
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('Concurrency must be 1–8');
  if (!Array.isArray(transports) || transports.length !== 2 || transports.some(t => typeof t !== 'function')) fail('Exactly two transports required');
  const records = [];
  async function pair(name, method, params, id) {
    const request = { jsonrpc: '2.0', id, method, params };
    const outcomes = await Promise.all(transports.map(async transport => {
      try { return { response: await transport(request) }; }
      catch (error) { return { failure: ['TIMEOUT', 'HTTP', 'SIZE', 'JSON', 'NETWORK', 'ABORTED'].includes(error.code) ? error.code : 'TRANSPORT' }; }
    }));
    const record = { name, request, left: outcomes[0], right: outcomes[1] };
    records.push(record);
    return record;
  }
  const chain = await pair('_chain', 'eth_chainId', [], 1);
  const anchor = await pair('_anchor', 'eth_getBlockByNumber', [suite.block, false], 2);
  const guard = r => !r.left.failure && !r.right.failure &&
    comparePair(r.left.response, r.right.response, r.request.id, r.request.method).validation.left.length === 0 &&
    comparePair(r.left.response, r.right.response, r.request.id, r.request.method).validation.right.length === 0 &&
    own(r.left.response, 'result') && own(r.right.response, 'result');
  let preflight = 'ok';
  if (!guard(chain) || !guard(anchor)) preflight = 'Preflight response unavailable or invalid';
  else if (chain.left.response.result.toLowerCase() !== chain.right.response.result.toLowerCase()) preflight = 'Chain IDs differ';
  else {
    const a = anchor.left.response.result, b = anchor.right.response.result;
    if (!a || !b) preflight = 'Pinned block unavailable';
    else if (BigInt(a.number) !== BigInt(suite.block) || BigInt(b.number) !== BigInt(suite.block)) preflight = 'Wrong block returned';
    else if (a.hash.toLowerCase() !== b.hash.toLowerCase()) preflight = 'Pinned block hashes differ';
  }
  let cases = [];
  if (preflight === 'ok') {
    cases = await pool(suite.cases, concurrency, async (c, i) => {
      const r = await pair(c.name, c.method, c.params, i + 3);
      if (r.left.failure || r.right.failure) return { name: c.name, method: c.method, status: 'transport-error', failures: { left: r.left.failure, right: r.right.failure } };
      return { name: c.name, method: c.method, ...comparePair(r.left.response, r.right.response, i + 3, c.method) };
    });
    // Fixed block numbers can reorg: recheck both providers after all reads.
    const end = await pair('_anchor_after', 'eth_getBlockByNumber', [suite.block, false], suite.cases.length + 3);
    if (!guard(end) || !end.left.response.result || !end.right.response.result ||
        end.left.response.result.hash.toLowerCase() !== anchor.left.response.result.hash.toLowerCase() ||
        end.right.response.result.hash.toLowerCase() !== anchor.right.response.result.hash.toLowerCase() ||
        BigInt(end.left.response.result.number) !== BigInt(suite.block) ||
        BigInt(end.right.response.result.number) !== BigInt(suite.block)) {
      preflight = 'Anchor changed or became unavailable during run; comparisons are inconclusive';
    }
  }
  const summary = {};
  for (const c of cases) summary[c.status] = (summary[c.status] || 0) + 1;
  return { version: 1, suite, preflight, cases, summary, evidence: records.sort((a, b) => a.request.id - b.request.id) };
}
export function replayTransports(evidence) {
  if (!Array.isArray(evidence)) fail('Replay evidence must be an array');
  const ids = new Set();
  for (const r of evidence) {
    if (!object(r) || !object(r.request) || !Number.isSafeInteger(r.request.id) || ids.has(r.request.id) ||
        !object(r.left) || !object(r.right)) fail('Invalid or duplicate replay record');
    ids.add(r.request.id);
  }
  return ['left', 'right'].map(side => async request => {
    const entry = evidence.find(e => e.request.id === request.id);
    if (!entry || JSON.stringify(entry.request) !== JSON.stringify(request)) throw Object.assign(new Error('Missing replay request'), { code: 'TRANSPORT' });
    if (entry[side].failure) throw Object.assign(new Error('Recorded failure'), { code: entry[side].failure });
    return entry[side].response;
  });
}
