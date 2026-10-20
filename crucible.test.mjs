import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJSON, validateSuite, validateResponse, diff, comparePair, runSuite, replayTransports } from './core.mjs';
import { httpTransport } from './transport.mjs';
import { suite, demoTransports } from './demo.mjs';
import { renderHTML } from './report.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const response = (result, id = 1) => ({ jsonrpc: '2.0', id, result });
const clone = value => JSON.parse(JSON.stringify(value));
const request = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
const block = hash => ({ number: suite.block, hash: '0x' + hash.repeat(64), parentHash: '0x' + 'b'.repeat(64), transactions: [] });

test('suite rejects mutable tags and write methods', () => {
  assert.throws(() => validateSuite({ ...suite, block: 'latest' }), /fixed/);
  const s = clone(suite); s.cases[0].method = 'eth_sendRawTransaction';
  assert.throws(() => validateSuite(s), /Unsupported/);
});
test('suite rejects duplicate case names, wrong block and full transaction expansion', () => {
  assert.throws(() => validateSuite({ ...suite, cases: [suite.cases[0], suite.cases[0]] }), /unique/);
  const c = clone(suite); c.cases[1].params[1] = 'latest';
  assert.throws(() => validateSuite(c), /pinned/);
  assert.throws(() => validateSuite({ ...suite, cases: [{ name: 'b', method: 'eth_getBlockByNumber', params: [suite.block, true] }] }), /pinned/);
  assert.throws(() => validateSuite({ ...suite, cases: [{ method: 'eth_chainId', params: [] }] }), /names/);
});
test('suite bounds storage slot and address encodings', () => {
  const s = clone(suite); s.cases[4].params[1] = '0x' + 'f'.repeat(65);
  assert.throws(() => validateSuite(s), /pinned/);
  s.cases[4].params[1] = '0x0'; s.cases[4].params[0] = '0x123';
  assert.throws(() => validateSuite(s), /pinned/);
});
test('JSON parser rejects huge, unsafe, deeply nested and reserved input', () => {
  assert.throws(() => parseJSON(' '.repeat(1048577)), /1 MiB/);
  assert.throws(() => parseJSON('{"n":9007199254740993}'), /Unsafe/);
  assert.throws(() => parseJSON('{"__proto__":{}}'), /Reserved/);
  assert.throws(() => parseJSON('['.repeat(34) + '0' + ']'.repeat(34)), /structural/);
  assert.throws(() => parseJSON('{'), /Invalid JSON/);
});
test('JSON-RPC envelope checks strict ID, version and result/error exclusivity', () => {
  assert.ok(validateResponse(response('0x1', '1'), 1, 'eth_chainId').length);
  assert.ok(validateResponse({ ...response('0x1'), jsonrpc: '1.0' }, 1, 'eth_chainId').length);
  assert.ok(validateResponse({ ...response('0x1'), error: { code: -1, message: 'x' } }, 1, 'eth_chainId').length);
  assert.ok(validateResponse({ jsonrpc: '2.0', id: 1 }, 1, 'eth_chainId').length);
});
test('quantity validation preserves precision and rejects leading zeros', () => {
  for (const q of ['0x0', '0x1', '0x' + 'f'.repeat(64)]) assert.equal(validateResponse(response(q), 1, 'eth_getBalance').length, 0);
  for (const q of ['0x', '0x00', '0x01', '0x' + 'f'.repeat(65), 1, '10', null]) assert.ok(validateResponse(response(q), 1, 'eth_getBalance').length);
});
test('code and storage data enforce byte shape', () => {
  assert.equal(validateResponse(response('0x'), 1, 'eth_getCode').length, 0);
  assert.ok(validateResponse(response('0x1'), 1, 'eth_getCode').length);
  assert.ok(validateResponse(response('0x'), 1, 'eth_getStorageAt').length);
  assert.equal(validateResponse(response('0x' + '0'.repeat(64)), 1, 'eth_getStorageAt').length, 0);
});
test('invalid responses cannot be promoted to a matching result', () => {
  assert.equal(comparePair(response('0x01'), response('0x01'), 1, 'eth_chainId').status, 'invalid');
});
test('comparison ignores object key order and hexadecimal case', () => {
  assert.deepEqual(diff({ a: '0xAB', b: 1 }, { b: 1, a: '0xab' }), []);
  assert.equal(comparePair(response('0xAB'), response('0xab'), 1, 'eth_getBalance').status, 'match');
});
test('differences retain array order, missing fields, null and pointer escaping', () => {
  assert.equal(diff([1, 2], [2, 1]).length, 2);
  assert.equal(diff({ 'a/b~': null }, {})[0].path, '/a~1b~0');
  assert.notDeepEqual(diff({ x: null }, {}), []);
  assert.equal(diff(Array(100).fill(0), Array(100).fill(1)).length, 50);
});
test('matching RPC errors remain distinct from successful matches', () => {
  const a = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'A' } };
  const b = { ...a, error: { code: -32000, message: 'B' } };
  assert.equal(comparePair(a, b, 1, 'eth_getCode').status, 'matching-error');
  b.error.data = '0x01';
  assert.equal(comparePair(a, b, 1, 'eth_getCode').status, 'divergent');
});
test('synthetic demo distinguishes match, disagreement, invalid encoding and error', async () => {
  const r = await runSuite(suite, demoTransports());
  assert.equal(r.preflight, 'ok');
  assert.deepEqual(r.summary, { match: 2, divergent: 1, invalid: 1, 'matching-error': 1 });
  assert.equal(r.evidence.length, 8);
});
test('offline replay reconstructs the original report', async () => {
  const r = await runSuite(suite, demoTransports());
  const replay = await runSuite(r.suite, replayTransports(r.evidence));
  assert.deepEqual(replay, r);
});
test('replay rejects duplicate IDs and mismatched request bodies', async () => {
  const r = await runSuite(suite, demoTransports());
  assert.throws(() => replayTransports([r.evidence[0], r.evidence[0]]), /duplicate/);
  const transports = replayTransports(r.evidence);
  await assert.rejects(transports[0]({ ...request, params: ['changed'] }), /Missing/);
});
test('different chain IDs stop all test cases', async () => {
  const t = demoTransports();
  const r = await runSuite(suite, [t[0], async req => req.method === 'eth_chainId' ? response('0x2', req.id) : t[1](req)]);
  assert.equal(r.preflight, 'Chain IDs differ'); assert.equal(r.cases.length, 0);
});
test('different anchor hashes stop comparisons', async () => {
  const t = demoTransports();
  const r = await runSuite(suite, [t[0], async req => req.method === 'eth_getBlockByNumber' ? response(block('c'), req.id) : t[1](req)]);
  assert.equal(r.preflight, 'Pinned block hashes differ'); assert.equal(r.cases.length, 0);
});
test('unavailable and wrong-number blocks are inconclusive', async () => {
  const t = demoTransports();
  for (const value of [null, { ...block('a'), number: '0x1' }]) {
    const r = await runSuite(suite, [t[0], async req => req.method === 'eth_getBlockByNumber' ? response(value, req.id) : t[1](req)]);
    assert.notEqual(r.preflight, 'ok'); assert.equal(r.cases.length, 0);
  }
});
test('reorg during reads invalidates final comparison conclusions', async () => {
  let anchors = 0;
  const t = demoTransports();
  const changing = async req => req.method === 'eth_getBlockByNumber' ? response(block(++anchors > 1 ? 'c' : 'a'), req.id) : t[0](req);
  const r = await runSuite(suite, [changing, t[1]]);
  assert.match(r.preflight, /Anchor changed/);
});
test('concurrency is bounded per provider and case order is stable', async () => {
  let active = 0, maximum = 0;
  const t = demoTransports()[0];
  const slow = async req => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, req.id % 2 ? 3 : 1));
    active--; return t(req);
  };
  const r = await runSuite(suite, [slow, t], { concurrency: 2 });
  assert.ok(maximum <= 2);
  assert.deepEqual(r.cases.map(c => c.name), suite.cases.map(c => c.name));
  await assert.rejects(runSuite(suite, [t,t], { concurrency: 9 }), /Concurrency/);
});
test('transport failures are classified without leaking error prose', async () => {
  const t = demoTransports()[0];
  const broken = async req => { if (req.method === 'eth_getBalance') throw new Error('https://secret-key.example/KEY'); return t(req); };
  const r = await runSuite(suite, [t, broken]);
  assert.equal(r.cases[1].status, 'transport-error');
  assert.ok(!JSON.stringify(r).includes('secret-key'));
});
test('HTTP transport rejects remote cleartext and embedded credentials', () => {
  for (const endpoint of ['http://example.com', 'https://name:pass@example.com', 'file:///etc/passwd']) assert.throws(() => httpTransport(endpoint));
});
test('HTTP 429 retries are bounded and endpoint stays out of response', async () => {
  let calls = 0;
  const t = httpTransport('https://rpc.example/SECRET', {
    sleep: async () => {}, retries: 1,
    fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429 }) : new Response(JSON.stringify(response('0x1')))
  });
  assert.deepEqual(await t(request), response('0x1')); assert.equal(calls, 2);
});
test('HTTP application errors and invalid JSON are not retried', async () => {
  for (const body of ['not JSON', JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'no' } })]) {
    let calls = 0;
    const t = httpTransport('https://rpc.example', { fetchImpl: async () => { calls++; return new Response(body); } });
    try { await t(request); } catch (e) { assert.equal(e.code, 'JSON'); }
    assert.equal(calls, 1);
  }
});
test('HTTP 400 does not retry; 503 retries then fails cleanly', async () => {
  for (const status of [400, 503]) {
    let calls = 0;
    const t = httpTransport('https://rpc.example', { retries: 2, sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status }); } });
    await assert.rejects(t(request), { code: 'HTTP' });
    assert.equal(calls, status === 400 ? 1 : 3);
  }
});
test('timeout aborts the request and classifies the failure', async () => {
  const t = httpTransport('https://rpc.example', { retries: 0, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret endpoint'))))
  });
  await assert.rejects(t(request), { code: 'TIMEOUT' });
});
test('response byte cap cancels oversized data', async () => {
  const t = httpTransport('https://rpc.example', { fetchImpl: async () => new Response('x'.repeat(1048577)) });
  await assert.rejects(t(request), { code: 'SIZE' });
});
test('HTML report escapes hostile text and includes no executable script', async () => {
  const r = await runSuite(suite, demoTransports());
  r.cases[0].name = '<script>alert(1)</script>';
  const html = renderHTML(r);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes("default-src 'none'"));
});
test('CLI demo, replay and overwrite protection work end to end offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-crucible-'));
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  try {
    const out = join(dir, 'demo'), replay = join(dir, 'replay');
    assert.equal(invoke(['demo', '--out', out]).status, 0);
    assert.equal(invoke(['replay', '--input', out + '.json', '--out', replay]).status, 1);
    assert.equal(await readFile(out + '.json', 'utf8'), await readFile(replay + '.json', 'utf8'));
    assert.equal(invoke(['demo', '--out', out]).status, 2);
    assert.equal(invoke(['run']).status, 2);
    assert.equal(invoke(['--help']).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
