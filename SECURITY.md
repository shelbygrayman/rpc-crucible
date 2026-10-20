# Trust boundaries

RPC Crucible accepts untrusted RPC responses. They are bounded before parsing, validated before comparison, escaped before HTML rendering, and preserved as evidence.

The tool does not establish that a provider is honest. Two dishonest providers can agree. A provider can behave inconsistently between anchor checks. A valid JSON envelope is not proof of correct chain state.

## Data handling

- No wallet connection, signing or transaction submission.
- Six read-only methods, explicit suite and endpoints.
- No dependencies, telemetry, auto-discovery or background polling.
- Endpoint configuration is not deliberately serialized.
- Raw responses can contain sensitive data, including anything a remote server chooses to echo.
- Generated HTML uses no scripts or external assets; JSON evidence remains unredacted.
- Use synthetic inputs in public bug reports. Never submit API keys or private account details.

## Resource limits

1 MiB JSON bodies, 100 cases, 32 nesting levels, 20,000 nodes, at most eight in-flight cases per endpoint. Defaults: five-second request deadline and one retry, with bounded exponential backoff. HTTP redirects are rejected.

This is an early implementation without an independent security audit. Use it in a controlled diagnostic workflow, not as an authorization gate.

## Reporting

For non-sensitive bugs, open a GitHub issue with a synthetic reproduction. For a suspected vulnerability involving credentials or private infrastructure, do not disclose those details in a public issue. Request a private reporting channel first.
