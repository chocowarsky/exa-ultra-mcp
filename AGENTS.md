# AGENTS.md — Exa Ultra MCP

Instructions for AI agents (OpenBot, Claude Code, Codex, Cursor, OpenCode, …) that install, use or change this repo. Humans: see [README.md](README.md).

## Hard rules
- **Never put an Exa API key in the repo, a commit, a chat message, a tool argument, a log or a URL.** Keys live only in a private file outside the repo (`--keys-file=`) or in the MCP client's secret store.
- Never print, `cat` or `echo` a key file. Pass its *path* to the server.
- Run `npm run check:secrets` before every commit. With `EXA_API_KEYS_FILE` set, it also searches for the real keys without printing them.
- Do not change the server mode (`exa_mode set=…`), `EXA_AGENT_MAX_COST` or the monthly budget unless the user asks. These settings spend the user's credits.
- The free plan has $10 of credits per key per month. Snapshot (`snapshotAsOf`) is a paid feature and returns 403 on free keys.

## Install as an OpenBot MCP server
1. `git clone https://github.com/chocowarsky/exa-ultra-mcp.git && cd exa-ultra-mcp && npm install`. `npm install` also builds `dist/`.
2. Keys: in OpenBot, call `openbot.request_api_key` with the name `EXA_API_KEYS`. The user enters the keys, comma-separated, in the secure form, and OpenBot saves them to a private file and returns its `path`. Never ask for keys in chat.
3. Register the server with `openbot.save_mcp_server`:
   - `name`: `exa-ultra`
   - `transport`: `stdio`
   - `command`: absolute path of `node` (`which node`)
   - `args`: `["<repo>/dist/index.js", "--keys-file=<path from step 2>"]`
   - Leave `workingDirectory` **empty**. Some providers (for example OpenCode) skip stdio servers that set one.
4. Check it with `openbot.test_mcp_server` `{ "name": "exa-ultra" }`. The answer should be `ready` with 9 tools. Every agent on that OpenBot server gets the tools from its next turn.
5. Optional: pick a default mode with `--mode=auto` in `args`, or call `exa_mode` later.

Other clients: see `examples/`. The pattern is always `node <repo>/dist/index.js --keys-file=<private path>`.

## Use the tools
| Need | Tool | Tip |
|---|---|---|
| Find pages | `exa_search` | Write the query like a search box entry; put the larger goal in `objective` |
| Quick lookup or tight loop | `exa_search` with `mode: "fast"` | Under 1 s, cached index |
| Fields extracted from pages | `exa_search` + `outputSchema` (+ `systemPrompt` for keep/drop rules) | Keep the schema small; read `output` in `structuredContent` |
| Read known URLs | `exa_contents` | `content: "highlights"` + `highlightsQuery` saves tokens; `subpages` + `subpageTarget` crawl a site |
| Similar sites or papers | `exa_find_similar` | `focus` says what "similar" means |
| One cited fact | `exa_answer` | $0.005 |
| Multi-step research, lists, enrichment | `exa_agent_run` | Bound arrays with `maxItems`. Long runs return an id: continue with `exa_agent_get wait=true` |
| Budget or broken keys | `exa_keys_status` | `action: "reset"` only after the user fixes a key |
| Current mode | `exa_mode` | Show it before you change it; change it only when asked |

### Modes
- `max` (default): `deep-reasoning` search (7–20 s) and `ultra` agent runs (capped, $1 by default). Best quality.
- `auto`: Exa's standard defaults (`auto` search about 2 s, agent `low`).
- `fast`: `lite` search under 1 s, agent `minimal`.
- Order of precedence: an explicit `type`/`effort` → the call's `mode` → the saved server mode → `EXA_MODE`.
- When the user says "quick", "fast" or "cepat", pass `mode: "fast"` or `"auto"` on that call. Do not change the server mode.

### Reading results
- `content[0].text` is compact Markdown for you. `structuredContent` holds the typed data: `results`, `output`, `costDollars`, `key`, `attempts` and `note`.
- `isError: true` means the call failed. Do not report its text as a result. Error text that starts with `Invalid arguments` means nothing was sent to Exa and no credits were spent.
- `note` tells you that the server changed the search type to make the call work, for example "mode fast uses lite…; used auto".

## Change the code
- Layout: `src/core/` (HTTP client, key pool, state, format), `src/tools/` (one module per tool group), `src/modes.ts`, `src/config.ts`, `src/server.ts`.
- New tool: write a `ToolModule` in `src/tools/`, add it to `toolModules()` in `src/tools/index.ts`, and add a test in `test/tools.test.mjs` that uses the mock (`test/helpers.mjs`).
- New mode: add an entry to `MODES` in `src/modes.ts`.
- New Exa parameter: add it to the zod schema, pass it through `prune({...})` so unset fields are not sent, and add a local guard if Exa rejects some combination.
- Before you commit: `npm test`, `npm run stress` and `npm run check:secrets`. Run `npm run smoke` (real credits, about $0.10) only when the user agrees.
- Exa API reference: https://exa.ai/docs and https://exa.ai/docs/llms.txt.
