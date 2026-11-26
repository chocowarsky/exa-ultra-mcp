# AGENTS.md — Exa Ultra MCP

Universal instructions for **every AI agent harness** (Antigravity, Claude Code, Claude Desktop, OpenAI Codex, Cursor, Windsurf, VS Code / GitHub Copilot, OpenCode, Cline, Roo Code, Amp, Goose, Hermes, OpenBot) installing, configuring, or using `exa-ultra-mcp`.

`exa-ultra-mcp` is a **100% local, offline-built stdio MCP server** (`node dist/index.js`). There is no remote MCP proxy or third-party relay: queries go directly from the user's machine to `https://api.exa.ai` using the user's own pooled keys.

---

## 1. Hard Key & Security Rules (Non-Negotiable)

1. **Never put an Exa API key in the repo, a commit, a chat message, a tool argument, a log, or a URL.**
2. **Never `cat`, `echo`, or print a key file.** Pass only its file *path* (`--keys-file=...` or `EXA_API_KEYS_FILE`), or let the server auto-discover `~/.config/exa-ultra/keys`.
3. **Private file outside the repo (`chmod 600`):** Default recommended path is `~/.config/exa-ultra/keys` (auto-discovered automatically!). Supported formats:
   - Plain text: one key per line, or comma/semicolon/space separated (`#` comments allowed).
   - JSON: `["key1", "key2"]` or `{"keys": ["key1", "key2"]}`.
   - Placeholder strings (e.g. `YOUR_EXA_KEY`, `REPLACE_ME`) are automatically ignored.
4. **Key discovery precedence:**
   1. `--keys-file=PATH` or `--keys-file PATH` *(supports `~/` expansion)*
   2. `EXA_API_KEYS_FILE` env var *(supports `~/` expansion)*
   3. `EXA_API_KEYS` (comma/newline-separated) or `EXA_API_KEY` env var
   4. Auto-discovered default private files when no explicit source is passed:
      - `$XDG_CONFIG_HOME/exa-ultra/keys` (default `~/.config/exa-ultra/keys`)
      - `$XDG_CONFIG_HOME/exa-ultra/keys.txt`
      - `$XDG_CONFIG_HOME/exa-ultra/keys.json`
5. **If `0` keys are found (`--doctor` returns `"ready": false`):** Never ask the user to paste keys into chat. Instruct the user to place their key(s) from https://dashboard.exa.ai/api-keys into `~/.config/exa-ultra/keys` with `chmod 600 ~/.config/exa-ultra/keys` (or use the harness's native secret store).
6. **Budget discipline:** Do not change the server mode (`exa_mode set=...`), `EXA_AGENT_MAX_COST`, or `EXA_MONTHLY_BUDGET_PER_KEY` unless the user asks. Free keys have $10/month credit; `snapshotAsOf` is paid-only (returns 403 on free keys).
7. **Always run `npm run check:secrets` before committing.**

---

## 2. Universal Local Build & Offline Verification (All Harnesses)

Requires **Node.js >= 20.6** (no `sudo` needed):

```bash
git clone https://github.com/chocowarsky/exa-ultra-mcp.git
cd exa-ultra-mcp
npm install            # installs deps and compiles dist/ via prepare script
```

Create the private key file outside the repo (user edits it directly, never via chat):

```bash
mkdir -p ~/.config/exa-ultra
install -m 600 /dev/null ~/.config/exa-ultra/keys
# User pastes 1 or more Exa API keys (one per line or comma-separated) into ~/.config/exa-ultra/keys
```

Run the **100% offline, $0-credit readiness check** before registering in any MCP client:

```bash
node dist/index.js --doctor --json
```

Expected output when ready: `"ready": true`, `"keyCount": >= 1`, redacted `…last4` aliases only (never raw keys), exit code `0`.

---

## 3. Registering in Every AI Agent Harness

Because `~/.config/exa-ultra/keys` is auto-discovered, `args` only needs `["/ABS/PATH/exa-ultra-mcp/dist/index.js"]` (or pass `"--keys-file=/ABS/PATH/keys"` explicitly to override). Always use the **absolute path** to `dist/index.js` and leave `cwd` / `workingDirectory` empty where possible (OpenCode and some clients skip stdio servers that set a custom working directory).

| Agent Harness | Config File / Command | Example Template |
| :--- | :--- | :--- |
| **Antigravity (AGY)** | `~/.gemini/config/mcp_config.json` | [`examples/antigravity-mcp.json`](examples/antigravity-mcp.json) |
| **Claude Code** | `claude mcp add exa-ultra --scope user -- node /ABS/PATH/dist/index.js` | [`examples/claude-code.sh`](examples/claude-code.sh) |
| **Claude Desktop** | `claude_desktop_config.json` | [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json) |
| **OpenAI Codex** | `~/.codex/config.toml` | [`examples/codex-config.toml`](examples/codex-config.toml) |
| **Cursor** | `~/.cursor/mcp.json` or `.cursor/mcp.json` | [`examples/cursor-mcp.json`](examples/cursor-mcp.json) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | [`examples/windsurf-mcp.json`](examples/windsurf-mcp.json) |
| **VS Code / GitHub Copilot** | `.vscode/mcp.json` | [`examples/vscode-mcp.json`](examples/vscode-mcp.json) |
| **OpenCode** | `opencode.json` (`type: "local"`, array `command`) | [`examples/opencode.json`](examples/opencode.json) |
| **Cline / Roo Code** | `cline_mcp_settings.json` | [`examples/cline-mcp.json`](examples/cline-mcp.json) |
| **OpenBot** | `openbot.request_api_key` (`EXA_API_KEYS`) + `openbot.save_mcp_server` (empty `workingDirectory`) + `openbot.test_mcp_server` | [`examples/openbot.md`](examples/openbot.md) |

### Universal JSON Pattern (Antigravity / Claude Desktop / Cursor / Windsurf / Cline / Roo)

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

*(Pass `"--keys-file=/ABSOLUTE/PATH/private/exa-keys"` as a second arg if not using the auto-discovered `~/.config/exa-ultra/keys`, and optional `"--mode=auto"` to override the default `max` mode.)*

---

## 4. Using the MCP Tools Effectively

| Need | Tool | Tip |
| :--- | :--- | :--- |
| Find pages | `exa_search` | Write `query` like a search box; put the broader goal in `objective` |
| Quick lookup / tight loop | `exa_search` with `mode: "fast"` | Under 1 s (`lite`), $0.004 |
| Structured table/field extraction | `exa_search` + `outputSchema` + `systemPrompt` | Keep schema small; read `structuredContent.output` |
| Read known URLs | `exa_contents` | `content: "highlights"` + `highlightsQuery` saves tokens; `subpages` crawls a site |
| Competitors / similar sites | `exa_find_similar` | Use `focus` to define what "similar" means |
| Single cited fact | `exa_answer` | Fast cited answer ($0.005) |
| Multi-step research / lists | `exa_agent_run` | Bound arrays with `maxItems`. Long runs return an `id`: continue with `exa_agent_get` (`wait: true`) |
| Key health & monthly spend | `exa_keys_status` | `action: "reset"` only after the user fixes a key |
| Inspect/change mode | `exa_mode` | Show before changing; change only when the user asks |

### Quality Modes & Precedence
- `max` *(default)*: `deep-reasoning` search (7–20 s, $0.015) and `ultra` agent runs (capped at `EXA_AGENT_MAX_COST`, default $1).
- `auto`: Exa standard defaults (`auto` search ~2 s, $0.007; agent `low` $0.025).
- `fast`: `lite` search <1 s ($0.004) and agent `minimal` ($0.012).
- Precedence: explicit `type`/`effort` → per-call `mode` → saved server mode (`exa_mode`) → `--mode=` / `EXA_MODE`.
- If the user says "quick", "fast", or "cepat", pass `mode: "fast"` or `"auto"` on that call only—do not mutate the server-wide mode.

### Reading Tool Responses
- `content[0].text` is compact Markdown; `structuredContent` holds typed JSON (`results`, `output`, `costDollars`, `key`, `attempts`, `note`).
- `isError: true` means failure—never report error text as a search answer. Errors starting with `Invalid arguments` are rejected locally with $0 spent.

---

## 5. Development & Verification Commands

- Layout: `src/core/` (HTTP client, keypool, cross-process state, cache, format), `src/tools/` (one module per tool group), `src/modes.ts`, `src/config.ts`, `src/server.ts`, `src/index.ts`.
- Before every commit, run:

```bash
npm run build
npm test
npm run check:secrets
```

For full tool patterns, see [skills/exa-ultra/SKILL.md](skills/exa-ultra/SKILL.md). Exa API docs: https://exa.ai/docs.
