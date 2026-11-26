# GEMINI.md

Instructions for Antigravity (AGY) and Gemini CLI agents working with `exa-ultra-mcp`.

- **Canonical skill & tool playbook:** [skills/exa-ultra/SKILL.md](skills/exa-ultra/SKILL.md)
- **Universal harness & key rules:** [AGENTS.md](AGENTS.md)
- **Antigravity MCP config template:** [examples/antigravity-mcp.json](examples/antigravity-mcp.json) (`~/.gemini/config/mcp_config.json`)
- **Offline readiness check ($0 credits):** `node dist/index.js --doctor --json`
- **Security rule:** Store Exa API keys only in `~/.config/exa-ultra/keys` (`chmod 600`, auto-discovered) or another private file outside git. Never print, log, commit, or request raw keys in chat.
- **Before commits:** `npm run build && npm test && npm run check:secrets`
