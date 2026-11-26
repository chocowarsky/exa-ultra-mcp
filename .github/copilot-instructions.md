# GitHub Copilot Instructions (`exa-ultra-mcp`)

`exa-ultra-mcp` is a local, offline-built stdio MCP server for the full Exa API (`Node >= 20.6`, TypeScript).

- Read `AGENTS.md` and `skills/exa-ultra/SKILL.md` before changing code or configuring MCP clients.
- Never hardcode, print, log, or commit real API keys or UUID-shaped strings (`scripts/check-secrets.mjs` treats any UUID in tracked files as a potential Exa key).
- Keys are loaded from `--keys-file=PATH`, `EXA_API_KEYS_FILE`, `EXA_API_KEYS`/`EXA_API_KEY`, or auto-discovered from `~/.config/exa-ultra/keys` (`chmod 600`).
- Verify offline readiness with `node dist/index.js --doctor --json`.
- Before every commit, run `npm run build && npm test && npm run check:secrets`.
