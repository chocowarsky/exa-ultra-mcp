# Design and roadmap

## Why this server
Many hosted Exa MCP servers expose one or two tools. They return one long Markdown string with a fixed search type, flag failures as successes, and rely on a single shared key on a remote host that sees every query. This server runs locally and goes the other way:

| Problem in a typical wrapper | Exa Ultra |
|---|---|
| One fixed search type | Every type, plus `fast` / `auto` / `max` modes |
| No control over page content | highlights / text / summary, freshness, subpages, links, Snapshot |
| No `objective`, `systemPrompt`, `outputSchema` | All passed through, with local guards |
| One long text, no data | Compact text plus typed `structuredContent` |
| Cost unknown | `costDollars`, `requestId`, key, attempts on every call |
| Errors reported as success | `isError: true`; invalid arguments rejected before any credits are spent |
| Uses the deprecated `/findSimilar` | Seed page + semantic `/search` |
| No `/contents`, `/answer`, Agent, Monitors | All of them |
| One key, one remote host | Local key pool with failover and a budget guard |
| Third party sees every query | Runs on your machine, calls Exa directly |

## Principles
- Free plan first: $10 per key per month, 10 QPS, every endpoint. Snapshot and Exa Connect are paid features.
- Send Exa only the fields the caller set (`prune`).
- Reject combinations that Exa would reject, locally and for free. When a *mode* picks a type that does not fit the call, adjust the type instead of failing.
- Never expose a key: keys are scrubbed from errors, the state holds fingerprints only, and CI runs a secret scan.
- Modular: one tool group per file; add a feature by adding a module.

## Done
- v0.1: core tools, key pool, failover, cache, Agent API, Monitors (opt-in).
- v0.2:
  - Modes (`fast` / `auto` / `max`) and the `exa_mode` tool.
  - Modular layout.
  - Cross-process shared state with a lock.
  - Budget reservations for agent runs.
  - Per-key QPS pacing.
  - In-flight dedupe of identical calls.
  - Cancellation support.
  - Stricter validation.
  - Mock-based test suite (38 tests), stress test, secret scanner, CI.

## Ideas
- Streaming (`stream: true`) for synthesized search output and agent events.
- Optional disk cache for repeated contents calls.
- OpenAI-compatible endpoints (`/chat/completions`, `/responses`) as an extra tool group.
- Exa Connect `dataSources` for paid plans (behind a flag).
