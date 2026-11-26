---
name: exa-ultra
description: >-
  Install, configure, verify offline, and use the local stdio `exa-ultra-mcp`
  server (`exa_search`, `exa_contents`, `exa_find_similar`, `exa_answer`,
  `exa_agent_run`, `exa_mode`, `exa_keys_status`) with multi-key failover,
  budget guard, and strict private key handling.
license: MIT
metadata:
  author: chocowarsky
  version: "0.3.0"
---

# Exa Ultra MCP (Repository Root Skill Pointer)

The canonical skill specification lives at [skills/exa-ultra/SKILL.md](skills/exa-ultra/SKILL.md), and universal harness setup instructions live at [AGENTS.md](AGENTS.md).

## Quick Local Offline Setup

```bash
npm install
mkdir -p ~/.config/exa-ultra && install -m 600 /dev/null ~/.config/exa-ultra/keys
# User adds Exa API key(s) into ~/.config/exa-ultra/keys (never paste keys in chat)
node dist/index.js --doctor --json
```

Read [skills/exa-ultra/SKILL.md](skills/exa-ultra/SKILL.md) and [AGENTS.md](AGENTS.md) for per-harness MCP registration and tool usage rules.
