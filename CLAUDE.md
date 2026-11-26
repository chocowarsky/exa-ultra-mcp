# CLAUDE.md

Read [AGENTS.md](AGENTS.md) and [skills/exa-ultra/SKILL.md](skills/exa-ultra/SKILL.md) for full setup, key rules, and tool patterns.

## Key Rules & Quick Commands
- **Local offline stdio MCP server:** `node /ABSOLUTE/PATH/exa-ultra-mcp/dist/index.js`
- **Register in Claude Code:** `claude mcp add exa-ultra --scope user -- node /ABSOLUTE/PATH/exa-ultra-mcp/dist/index.js`
- **Keys:** Auto-discovered from `~/.config/exa-ultra/keys` (`chmod 600`), or pass `--keys-file=PATH` / `EXA_API_KEYS_FILE`. Never commit, print, or ask for keys in chat.
- **Offline readiness check ($0 credits):** `node dist/index.js --doctor --json`
- **Before commits:** `npm run build && npm test && npm run check:secrets`
