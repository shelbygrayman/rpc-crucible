# Validation and benchmarks

## Reproduce

Use Node 24. No dependency installation is needed for these checks.

```sh
node --test crucible.test.mjs
```

On 25 October 2026, the suite passed **28 tests** on the maintainer's Mac. These are regression checks for the covered cases, not proof of zero bugs, a security audit, or a comparison with competing products. CI runs the same suite on Linux.

## Differential RPC evidence

`node cli.mjs demo --out demo` produces deterministic offline comparison evidence. For live work, select a fixed block, provide endpoints through environment variables, retain the suite, JSON and HTML outputs, and replay with `node cli.mjs --help` for supported options. Redact credentials before publishing.

The 25 October Ethereum comparison of eth.drpc.org and 1rpc.io at block 0x190a254 found two transport errors and one result/error divergence: the right provider reported historical state unavailable while the left returned a nonce. Replay preserved those outcomes. A later sequential run at block 0x190d1d1 had two matches and one HTTP error. This is evidence of endpoint availability differences in those runs, not evidence that either provider returned a conflicting valid nonce, or a provider ranking.

Retain failures; do not count unavailable responses as matches or exclude them to improve scores. A reproducible benchmark should report block hashes, methods, parameters, retries, concurrency, timestamps and transport failures alongside comparison outcomes.

Raw runs: [historical block](rpc-audit-2026-10-25.json), [offline replay](rpc-audit-replay-2026-10-25.json), [recent block](rpc-audit-recent-2026-10-25.json). Each JSON includes its suite and captured responses.
