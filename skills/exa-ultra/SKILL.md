---
name: exa-ultra
description: >-
  Install, configure, verify offline, and use the local stdio `exa-ultra-mcp`
  server (`exa_search`, `exa_contents`, `exa_find_similar`, `exa_answer`,
  `exa_agent_run`, `exa_agent_get`, `exa_agent_manage`, `exa_mode`,
  `exa_keys_status`) for high-performance AI web search, neural content
  extraction, cited answers, competitor discovery, and multi-step research with
  multi-key failover, budget guards, and strict private key handling.
license: MIT
metadata:
  author: chocowarsky
  version: "0.3.0"
---

# Exa Ultra MCP — Local Offline Setup, Key Rules & Tool Playbook

Complete guidance for any AI agent harness (Antigravity, Claude Code, Codex, Cursor, Windsurf, VS Code / Copilot, OpenCode, Cline, Roo Code, OpenBot) to run and use `exa-ultra-mcp`.

## 1. Local Offline Setup & Key Rules

`exa-ultra-mcp` runs **100% locally over stdio** (`node <repo>/dist/index.js`). No third-party MCP relay sees queries or API keys.

### Non-Negotiable Key Security Rules
- **NEVER** commit an Exa API key, paste it into chat, log it, or pass raw keys in CLI arguments.
- **NEVER** `cat` or `echo` a key file. Always pass only its *path*, or rely on auto-discovery.
- Store keys in a private `0600` file **outside** any git repository:
  ```bash
  mkdir -p ~/.config/exa-ultra
  install -m 600 /dev/null ~/.config/exa-ultra/keys
  # User adds 1 or more Exa keys (one per line, comma-separated, or JSON array)
  ```
- **Key discovery order:**
  1. `--keys-file=PATH` or `--keys-file PATH` (`~/` supported)
  2. `EXA_API_KEYS_FILE` env var (`~/` supported)
  3. `EXA_API_KEYS` / `EXA_API_KEY` env vars
  4. Auto-discovered `~/.config/exa-ultra/keys` (`.txt` / `.json`) when no explicit source is passed.
- Placeholder entries (e.g. `YOUR_EXA_KEY`, `REPLACE_ME`) are safely ignored.

### Build & Offline Readiness Check ($0 Credits)

```bash
git clone https://github.com/chocowarsky/exa-ultra-mcp.git
cd exa-ultra-mcp
npm install                      # installs deps & builds dist/
node dist/index.js --doctor --json
```

Verify `"ready": true` and `"keyCount" >= 1`. If `"ready": false`, direct the user to add their Exa API key(s) from https://dashboard.exa.ai/api-keys into `~/.config/exa-ultra/keys` (`chmod 600`)—never ask them to paste raw keys into chat.

### Registering the Stdio Server

Standard MCP JSON (Antigravity `~/.gemini/config/mcp_config.json`, Claude Desktop, Cursor, Windsurf, Cline, Roo Code):

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

- **Claude Code:** `claude mcp add exa-ultra --scope user -- node /ABSOLUTE/PATH/exa-ultra-mcp/dist/index.js`
- **Codex (`~/.codex/config.toml`):** `[mcp_servers.exa-ultra]` with `command = "node"` and `args = ["/ABSOLUTE/PATH/exa-ultra-mcp/dist/index.js"]`
- **OpenCode (`opencode.json`):** `"type": "local"`, `"command": ["node", "/ABSOLUTE/PATH/exa-ultra-mcp/dist/index.js"]`, leave `cwd` unset.
- **OpenBot:** `openbot.request_api_key` (`EXA_API_KEYS`) → `openbot.save_mcp_server` (empty `workingDirectory`) → `openbot.test_mcp_server`.
- Pass `"--keys-file=/ABSOLUTE/PATH/keys"` if not using `~/.config/exa-ultra/keys`.

---

## 2. When to Use Which Tool

| Task | Preferred Tool | Configuration |
| :--- | :--- | :--- |
| General search / fact finding | `exa_search` | Default `mode: "max"` uses `deep-reasoning` (7–20 s, $0.015). For fast lookups (<1 s), pass `mode: "fast"` (`lite`, $0.004) or `mode: "auto"`. |
| Quick single fact with citations | `exa_answer` | Fastest cited answer ($0.005). Ideal for single factual questions. |
| Structured table / field extraction | `exa_search` | Supply `outputSchema` for fields + `systemPrompt` for keep/drop rules. Read `structuredContent.output`. |
| Reading known URLs / docs | `exa_contents` | Prefer `content: "highlights"` + `highlightsQuery` to save tokens; use `content: "text"` only when full text is needed. Use `subpages` + `subpageTarget` to crawl docs. |
| Competitors / alternatives | `exa_find_similar` | Supply `url` and optional `focus` (e.g. `"open source alternatives"`). |
| Deep multi-step research / lists | `exa_agent_run` | Default `ultra` effort capped at $1/run. Use `mode: "fast"` ($0.012) for cheap runs. Bound arrays with `maxItems`. Poll long runs with `exa_agent_get({ id, wait: true })`. |
| Inspect/switch quality mode | `exa_mode` | Inspect first; change server-wide mode only when the user asks. |
| Key pool health & budget | `exa_keys_status` | Inspect requests, spend, cooldowns; `action: "reset"` only after user fixes a key. |

## 3. Modes & Precedence

1. Explicit call parameter (`type: "deep"`, `effort: "medium"`)
2. Per-call preset (`mode: "fast" | "auto" | "max"`)
3. Saved server mode (`exa_mode`)
4. Startup default (`--mode=` or `EXA_MODE`, default `max`)

When the user says "quick", "fast", or "cepat", pass `mode: "fast"` on that call only—do not alter the server-wide mode.

## 4. Structured Output Pattern

- Put search keywords in `query`.
- Put inclusion/exclusion verification rules in `systemPrompt`.
- Define a concise JSON Schema in `outputSchema` (bound arrays with `maxItems`).

## 5. Free-Tier & Safety Guardrails

- Free keys include **$10/month** credit and **10 QPS** per key (multi-key failover & budget guard are automatic across parallel sessions via shared state in `~/.local/state/exa-ultra-mcp/keys.json`).
- `snapshotAsOf` is an enterprise paid feature and returns `403` on free keys.
- `isError: true` indicates failure—never present error text as factual results.
