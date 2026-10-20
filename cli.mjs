#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseJSON, runSuite, replayTransports, validateSuite } from './core.mjs';
import { httpTransport } from './transport.mjs';
import { demoTransports, suite as demoSuite } from './demo.mjs';
import { renderHTML } from './report.mjs';

async function main(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--suite', '--input', '--out', '--left-env', '--right-env', '--concurrency'].includes(rest[i]) ||
        !rest[i + 1] || rest[i + 1].startsWith('--') || options[rest[i]]) throw new Error('Invalid arguments');
    options[rest[i]] = rest[i + 1];
  }
  if (!['demo', 'run', 'replay'].includes(command)) {
    console.log('RPC Crucible\n  node cli.mjs demo [--out demo-report]\n  node cli.mjs replay --input report.json [--out replay-report]\n  node cli.mjs run --suite suite.json --left-env RPC_A --right-env RPC_B [--concurrency 2] [--out report]');
    if (command && command !== '--help') process.exitCode = 2;
    return;
  }
  let suite, transports;
  if (command === 'demo') { suite = demoSuite; transports = demoTransports(); }
  if (command === 'replay') {
    if (!options['--input']) throw new Error('Replay requires --input');
    const previous = parseJSON(await readFile(options['--input'], 'utf8'));
    if (previous.version !== 1) throw new Error('Unsupported report version');
    suite = previous.suite; transports = replayTransports(previous.evidence);
  }
  if (command === 'run') {
    if (!options['--suite'] || !options['--left-env'] || !options['--right-env']) throw new Error('Run requires suite and two endpoint environment variable names');
    suite = validateSuite(parseJSON(await readFile(options['--suite'], 'utf8')));
    transports = ['--left-env', '--right-env'].map(key => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(options[key])) throw new Error('Invalid endpoint variable name');
      const value = process.env[options[key]];
      if (!value) throw new Error('Endpoint environment variable is missing');
      return httpTransport(value);
    });
  }
  const report = await runSuite(suite, transports, { concurrency: options['--concurrency'] ? Number(options['--concurrency']) : 2 });
  const prefix = resolve(options['--out'] || (command === 'demo' ? 'demo-report' : 'report'));
  // Exclusive writes prevent an accidental overwrite of an earlier run.
  await writeFile(prefix + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(prefix + '.html', renderHTML(report), { flag: 'wx' });
  console.log(JSON.stringify({ preflight: report.preflight, summary: report.summary, output: prefix }, null, 2));
  const failed = report.preflight !== 'ok' || report.cases.some(c => c.status !== 'match');
  if (command !== 'demo' && failed) process.exitCode = 1;
}
main(process.argv.slice(2)).catch(error => {
  // Never print stack traces, endpoint values, request bodies or provider prose.
  const safe = /^(Invalid|Unsupported|Run requires|Replay requires|Endpoint|Suite needs|Case names|Concurrency|Use HTTP|Remote endpoints|JSON exceeds|Reserved JSON|Unsafe JSON)/.test(error.message);
  console.error(safe ? error.message : error.code === 'EEXIST' ? 'Output already exists; choose another --out prefix' : 'Unable to complete run. Check input files and output location.');
  process.exitCode = 2;
});
