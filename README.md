# Exa Ultra MCP

A **100% local, offline-built stdio MCP server** and **universal AI agent skill** for the full [Exa](https://exa.ai) API.

- Covers every Exa surface on the free plan: search (all types), contents, find-similar, answer, Agent runs, Monitors.
- **Runs locally over stdio (`node dist/index.js`).** No remote MCP relay or third-party host sees your queries or API keys—requests go directly from your machine to `https://api.exa.ai`.
- **Quality modes:** `fast`, `auto` (Exa standard), and `max` (highest the free plan allows). Set one server-wide, or pass one per call.
- **Pool of API keys with failover.** On 401/402/429/5xx, timeouts, or malformed responses, the call automatically fails over to the next healthy key. Bad requests (400) are rejected without retrying.
- **Budget guard & shared cross-process state.** Every session on your machine shares monthly spend ($10/key default), cooldowns, reservations, and active mode.
- **Private key hygiene.** Auto-discovers `~/.config/exa-ultra/keys` (`chmod 600`), supports plain text or JSON key files, filters placeholder tokens, warns on loose file permissions, redacts keys from all errors, and includes an offline `$0`-credit `--doctor` check.

> **AI Agents (Antigravity, Claude Code, Codex, Cursor, Windsurf, OpenCode, Cline, Roo, Copilot, OpenBot):** Read [`AGENTS.md`](AGENTS.md) and [`skills/exa-ultra/SKILL.md`](skills/exa-ultra/SKILL.md) for local offline installation, private key rules, and tool usage.

---

## Quick Start (Offline Build + Private Keys)

Requires **Node.js >= 20.6**:

```bash
git clone https://github.com/chocowarsky/exa-ultra-mcp.git
cd exa-ultra-mcp
npm install            # installs dependencies and compiles dist/
```

Create your private key file **outside the repo** (`chmod 600`). Paste one or more keys from https://dashboard.exa.ai/api-keys (one per line, comma-separated, or JSON `["k1", "k2"]`):

```bash
mkdir -p ~/.config/exa-ultra
install -m 600 /dev/null ~/.config/exa-ultra/keys
$EDITOR ~/.config/exa-ultra/keys
```

Verify readiness **100% offline ($0 credits spent)**:

```bash
node dist/index.js --doctor --json
```

---

## Install Across Every AI Agent Harness

### Agent Skill Discovery (`skills.sh` / Claude Code / Antigravity)

```bash
# Universal Agent Skills CLI (30+ harnesses)
npx skills add chocowarsky/exa-ultra-mcp
```

- **Claude Code Plugin Marketplace:** `/plugin marketplace add chocowarsky/exa-ultra-mcp`
- **Antigravity / Codex / Cursor / Windsurf / Copilot / Cline / Roo / OpenCode / OpenBot:** Native entrypoints included ([`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), [`GEMINI.md`](GEMINI.md), [`plugin.json`](plugin.json), [`.claude-plugin/`](.claude-plugin/), [`.cursor/rules/exa-ultra.mdc`](.cursor/rules/exa-ultra.mdc), [`.github/copilot-instructions.md`](.github/copilot-instructions.md), [`skills/exa-ultra/SKILL.md`](skills/exa-ultra/SKILL.md)).

### MCP Client Registration

Because `~/.config/exa-ultra/keys` is **auto-discovered**, standard stdio MCP registration is simply:

```json
{
  "mcpServers": {
    "exa-ultra": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/exa-ultra-mcp/dist/index.js"]
    }
  }
}
```

*(Pass `"--keys-file=/ABSOLUTE/PATH/keys"` as a second argument if you store your key file at a custom location. Leading `~/` is automatically expanded.)*

Ready-to-use templates for every client live in [`examples/`](examples/):
- **Antigravity:** [`examples/antigravity-mcp.json`](examples/antigravity-mcp.json)
- **Claude Code:** [`examples/claude-code.sh`](examples/claude-code.sh)
- **Claude Desktop:** [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)
- **OpenAI Codex:** [`examples/codex-config.toml`](examples/codex-config.toml)
- **Cursor:** [`examples/cursor-mcp.json`](examples/cursor-mcp.json)
- **Windsurf:** [`examples/windsurf-mcp.json`](examples/windsurf-mcp.json)
- **VS Code / Copilot:** [`examples/vscode-mcp.json`](examples/vscode-mcp.json)
- **OpenCode:** [`examples/opencode.json`](examples/opencode.json)
- **Cline / Roo Code:** [`examples/cline-mcp.json`](examples/cline-mcp.json)
- **OpenBot:** [`examples/openbot.md`](examples/openbot.md)

---

## Key Discovery & Security Rules

Keys are merged and deduplicated from these sources (never committed to git, never printed in logs or chat):

1. `--keys-file=PATH` or `--keys-file PATH` *(supports `~/`)*
2. `EXA_API_KEYS_FILE` env var *(supports `~/`)*
3. `EXA_API_KEYS` (comma/newline-separated) or `EXA_API_KEY` env var
4. Auto-discovered default private files when no explicit key source is given:
   - `$XDG_CONFIG_HOME/exa-ultra/keys` *(default `~/.config/exa-ultra/keys`)*
   - `$XDG_CONFIG_HOME/exa-ultra/keys.txt`
   - `$XDG_CONFIG_HOME/exa-ultra/keys.json`

---

## Modes

| Mode | `exa_search` / `exa_find_similar` | `exa_agent_run` | Typical use |
|---|---|---|---|
| `fast` | `lite`: under 1 s, $0.004 | `minimal`: $0.012 | Autocomplete, tight agent loops |
| `auto` | `auto`: about 2 s, $0.007 | `low`: $0.025 | Exa's standard defaults |
| `max` **(default)** | `deep-reasoning`: 7–20 s, $0.015 | `ultra`: usage-based, capped at `EXA_AGENT_MAX_COST` ($1) | Best quality on the free plan |

Precedence: explicit `type`/`effort` → per-call `mode` → saved server mode (`exa_mode`) → `--mode=` / `EXA_MODE`.

---

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

---

## Configuration

Every setting is optional except the keys.

| Variable / Flag | Default | Meaning |
|---|---|---|
| `EXA_API_KEYS_FILE` / `--keys-file` | `~/.config/exa-ultra/keys` *(auto)* | Private file with keys (plain text with `#` comments, or JSON); supports `~/` |
| `EXA_API_KEYS` / `EXA_API_KEY` | — | Keys in the environment (comma or newline separated) |
| `EXA_MODE` / `--mode` | `max` | `fast`, `auto` or `max` |
| `EXA_AGENT_MAX_COST` | `1` | Cap per `auto`/`ultra` agent run, in USD (1–100) |
| `EXA_AGENT_WAIT_SECONDS` | `120` | How long `exa_agent_run` waits before returning the run id |
| `EXA_MONTHLY_BUDGET_PER_KEY` | `10` | USD per key per month |
| `EXA_BUDGET_MARGIN` | `0.05` | Stop using a key this many USD before its budget |
| `EXA_KEY_STRATEGY` | `round-robin` | `round-robin`, `priority` or `least-used` |
| `EXA_QPS_PER_KEY` | `10` | Requests per second per key (free plan: 10); `0` = no limit |
| `EXA_TIMEOUT_MS` | `60000` | Timeout of one HTTP attempt |
| `EXA_MAX_ATTEMPTS` | `5` | Keys tried per call |
| `EXA_MAX_CHARS` | `8000` | Default cap on the text returned to the model |
| `EXA_CACHE_TTL_SECONDS` / `EXA_CACHE_MAX` | `600` / `200` | In-memory cache of identical calls |
| `EXA_ENABLE_AGENT` / `EXA_ENABLE_MONITORS` | `1` / `0` | Turn tool groups on or off |
| `EXA_STATE_DIR` | `~/.local/state/exa-ultra-mcp` | Shared state: sha256 fingerprints, spend, mode. Never raw keys |
| `EXA_BASE_URL` | `https://api.exa.ai` | For proxies or tests |

---

## Failover Rules

| Exa answer | What happens to the key | Retried on another key |
|---|---|---|
| 401 / 403 | Disabled for 6 h | ✓ |
| 403 "plan doesn't include …" | Nothing; the key is fine | — (every key on the plan would answer the same) |
| 402, or 429 about credits | Disabled until next month | ✓ |
| 429 rate limit | Cooldown (`Retry-After` or backoff, max 2 min) | ✓ |
| 5xx, 408, timeout, network error, 200 with a non-JSON body | Cooldown with backoff | ✓ |
| 400 / 404 / 422 | Nothing | — (the request itself is wrong) |

---

## Development, Testing & Security

```bash
npm run build           # compile TypeScript to dist/
npm test                # run offline unit + CLI --doctor tests
npm run check:secrets   # scan tracked files (and --history) for leaked keys/UUIDs
```

- Never commit keys. `.gitignore` blocks common key files, and `npm run check:secrets` (enforced in GitHub Actions CI) fails on anything resembling a key—including UUIDs, the format Exa uses.
- The shared state file (`~/.local/state/exa-ultra-mcp/keys.json`) stores sha256 fingerprints and the last 4 characters only (`0600`), never raw keys.

## License

[MIT](LICENSE)
