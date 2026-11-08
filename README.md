# Exa Ultra MCP

A local **stdio MCP server** for the full [Exa](https://exa.ai) API, built for AI agents.

- Covers every Exa surface on the free plan: search (all types), contents, find-similar, answer, Agent runs, Monitors.
- **Quality modes:** `fast`, `auto` (Exa standard) and `max` (highest the free plan allows). Set one server-wide, or pass one per call.
- **Pool of API keys with failover.** On 401/402/429/5xx, timeouts or a broken response, the call moves to the next key. Bad requests (400) are not retried.
- **Budget guard.** Spend per key comes from `costDollars`. A key is skipped near its monthly budget ($10 on the free plan). Agent runs reserve their worst-case cost until Exa bills them.
- **Shared state.** Every process on the machine (one per chat session is common) shares the same budget, cooldowns and mode.
- **Lean output.** Short Markdown for the model, typed JSON in `structuredContent`, real errors flagged `isError: true`, and the cost on every call.
- **Keys stay private.** Keys are read from a file or the environment. They are never logged or returned, and every error message is scrubbed of them.

> **Agents (OpenBot, Claude, Codex, …):** read [`AGENTS.md`](AGENTS.md) for setup and usage rules.

## Quick start

```bash
git clone https://github.com/chocowarsky/exa-ultra-mcp.git
cd exa-ultra-mcp
npm install            # also builds dist/
```

Put your keys in a private file, one per line or comma-separated. Keep it outside the repo:

```bash
install -m 600 /dev/null ~/.config/exa-ultra/keys
$EDITOR ~/.config/exa-ultra/keys
```

Register the server with your MCP client:

```json
{
  "mcpServers": {
    "exa-ultra": {
      "command": "node",
      "args": ["/absolute/path/to/exa-ultra-mcp/dist/index.js", "--keys-file=/home/you/.config/exa-ultra/keys"]
    }
  }
}
```

More client configs (OpenBot, Claude Desktop/Code, Cursor, Codex, OpenCode) are in [`examples/`](examples/).

## Modes

| Mode | `exa_search` / `exa_find_similar` | `exa_agent_run` | Typical use |
|---|---|---|---|
| `fast` | `lite`: under 1 s, $0.004 | `minimal`: $0.012 | Autocomplete, tight agent loops |
| `auto` | `auto`: about 2 s, $0.007 | `low`: $0.025 | Exa's standard defaults |
| `max` **(default)** | `deep-reasoning`: 7–20 s, $0.015 | `ultra`: usage-based, capped at `EXA_AGENT_MAX_COST` ($1) | Best quality on the free plan |

An earlier rule wins over a later one:

1. An explicit `type` or `effort` in the call.
2. `mode` in the call (`fast` / `auto` / `max`).
3. The server mode saved with the `exa_mode` tool. It applies to every session on the machine and survives restarts.
4. `EXA_MODE`, or `--mode=`, from the config.

A mode never breaks a call. If the mode's search type cannot handle the options you set, the server falls back to `auto` and adds a `note`. Two cases: `lite` with `outputSchema` or freshness options, and `deep-*` with Snapshot. An **explicit** invalid combination is rejected locally, before any credits are spent.

## Tools

| Tool | Exa endpoint | Notes |
|---|---|---|
| `exa_search` | `POST /search` | All types, filters, `objective`, `systemPrompt`, `outputSchema`, contents options, Snapshot |
| `exa_contents` | `POST /contents` | text, highlights or summary; live crawl, subpages, links/images, Snapshot |
| `exa_find_similar` | `/contents` + `/search` | Replaces the deprecated `/findSimilar` |
| `exa_answer` | `POST /answer` | Cited answer, optional schema |
| `exa_agent_run` / `exa_agent_get` / `exa_agent_manage` | `/agent/runs` | Create, wait, follow-up, list, events, cancel, delete |
| `exa_monitor` | `/monitors` | Off by default (`EXA_ENABLE_MONITORS=1`), needs a public webhook |
| `exa_mode` | local | Show or set the server mode |
| `exa_keys_status` | local | Key health, cooldowns, spend, reservations; `action=reset` |

Resources: `exa://keys/status`, `exa://modes`. Prompt: `exa_research`.

## Configuration

Every setting is optional except the keys.

| Variable | Default | Meaning |
|---|---|---|
| `EXA_API_KEYS_FILE` / `--keys-file=` | — | File with keys: commas, spaces or newlines; `#` comments allowed |
| `EXA_API_KEYS` / `EXA_API_KEY` | — | Keys in the environment (comma-separated) |
| `EXA_MODE` / `--mode=` | `max` | `fast`, `auto` or `max` |
| `EXA_AGENT_MAX_COST` | `1` | Cap per `auto`/`ultra` agent run, in USD (1–100) |
| `EXA_AGENT_WAIT_SECONDS` | `120` | How long `exa_agent_run` waits before it returns the run id |
| `EXA_MONTHLY_BUDGET_PER_KEY` | `10` | USD per key per month |
| `EXA_BUDGET_MARGIN` | `0.05` | Stop using a key this many USD before its budget |
| `EXA_KEY_STRATEGY` | `round-robin` | `round-robin`, `priority` or `least-used` |
| `EXA_QPS_PER_KEY` | `10` | Requests per second per key (free plan: 10); `0` = no limit |
| `EXA_TIMEOUT_MS` | `60000` | Timeout of one HTTP attempt |
| `EXA_MAX_ATTEMPTS` | `5` | Keys tried per call |
| `EXA_MAX_CHARS` | `8000` | Default cap on the text returned to the model |
| `EXA_CACHE_TTL_SECONDS` / `EXA_CACHE_MAX` | `600` / `200` | In-memory cache of identical calls |
| `EXA_ENABLE_AGENT` / `EXA_ENABLE_MONITORS` | `1` / `0` | Turn tool groups on or off |
| `EXA_STATE_DIR` | `~/.local/state/exa-ultra-mcp` | Shared state: fingerprints, spend, mode. Never keys |
| `EXA_BASE_URL` | `https://api.exa.ai` | For proxies or tests |

Invalid values fall back to the default, with a warning on stderr.

## Failover rules

| Exa answer | What happens to the key | Retried on another key |
|---|---|---|
| 401 / 403 | Disabled for 6 h | ✓ |
| 403 "plan doesn't include …" | Nothing; the key is fine | — (every key on the plan would answer the same) |
| 402, or 429 about credits | Disabled until next month | ✓ |
| 429 rate limit | Cooldown (`Retry-After` or backoff, max 2 min) | ✓ |
| 5xx, 408, timeout, network error, 200 with a non-JSON body | Cooldown with backoff | ✓ |
| 400 / 404 / 422 | Nothing | — (the request itself is wrong) |

Agent runs and monitors stay on the key that created them. A run with an unknown owner is found by asking each key.

## Project layout

```
src/
  index.ts         CLI entry: config → server → stdio
  server.ts        createServer(config): builds the MCP server (used by the CLI and tests)
  config.ts        env/argv → Config, with validation
  modes.ts         fast / auto / max presets, efforts, prices
  core/
    client.ts      HTTP client: failover, pacing, redaction, cancellation
    keypool.ts     key selection, budget, reservations, cooldowns
    state.ts       cross-process JSON state with a lock
    cache.ts       TTL cache
    format.ts      compact Markdown output
  tools/
    index.ts       list of tool modules (add yours here)
    shared.ts      Ctx, schemas, helpers, cache + in-flight dedupe
    search.ts      exa_search, exa_find_similar
    contents.ts    exa_contents, exa_answer
    agent.ts       exa_agent_run / get / manage
    monitors.ts    exa_monitor
    admin.ts       exa_mode, exa_keys_status
test/              mock Exa API, unit + end-to-end + stress tests
scripts/           check-secrets.mjs
examples/          client configs
```

To add a tool, write a `ToolModule` (`(server, ctx) => void`) in `src/tools/` and add it to `toolModules()` in `src/tools/index.ts`. To add a mode, add an entry to `MODES` in `src/modes.ts`. Schemas, docs and `exa_mode` pick it up automatically.

You can also use the server as a library:

```ts
import { createServer } from "exa-ultra-mcp";
import { loadConfig } from "exa-ultra-mcp/config";
const { server } = createServer(loadConfig({ ...process.env, EXA_MODE: "auto" }));
```

## Security

- Never commit keys. `.gitignore` blocks common key files, and `npm run check:secrets` (also run in CI) fails on anything that looks like a key, including UUIDs, the format Exa uses.
- The state file stores sha256 fingerprints and the last 4 characters of each key, never the key itself, with mode `0600`.
- Monitor webhook secrets are written to `monitor-secrets/` in the state dir (`0600`) and are never returned to the model.

## License

[MIT](LICENSE)
