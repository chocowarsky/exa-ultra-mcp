# OpenBot

Ask your OpenBot agent:

> Install exa-ultra-mcp from https://github.com/chocowarsky/exa-ultra-mcp as an MCP server, and follow its AGENTS.md.

The agent clones and builds the repo. It then opens a secure form for `EXA_API_KEYS`, where you enter your keys comma-separated; they never appear in chat. Finally it registers the server like this:

| Field | Value |
|---|---|
| name | `exa-ultra` |
| transport | `stdio` |
| command | `/usr/bin/node` (output of `which node`) |
| args | `<repo>/dist/index.js`, `--keys-file=<path of the saved EXA_API_KEYS file>` |
| working directory | empty |

Then it calls `openbot.test_mcp_server` and expects `ready` with 9 tools.
