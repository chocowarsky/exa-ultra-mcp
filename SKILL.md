---
name: exa-ultra
description: "Use Exa Ultra MCP tools (exa_search, exa_contents, exa_find_similar, exa_answer, exa_agent_run, exa_mode, exa_keys_status) for high-performance AI web search, neural content extraction, cited answers, competitor discovery, and multi-step research runs with multi-key failover and budget control."
---

# Exa Ultra

Guidance for using the `exa-ultra` MCP server effectively.

## When to Use Which Tool

| Task | Preferred Tool | Configuration |
|---|---|---|
| General search / fact finding | `exa_search` | Default `mode: "max"` uses `deep-reasoning` (7–20 s, $0.015). For fast answers (<1 s), pass `mode: "fast"` (lite) or `mode: "auto"`. |
| Quick single fact with citations | `exa_answer` | Fastest cited answer ($0.005). Good for "what year...", "how much is...". |
| Structured data / table extraction | `exa_search` | Use `outputSchema` for fields + `systemPrompt` for inclusion/exclusion criteria. Results appear in `structuredContent.output`. |
| Reading known URLs / documentation | `exa_contents` | Use `content: "highlights"` to save tokens, or `content: "text"` for full page. Set `subpages: N` + `subpageTarget` to crawl subpages. |
| Competitors / alternative products | `exa_find_similar` | Supply `url` and optional `focus` (e.g. "open source alternatives", "direct competitors"). |
| Deep research / autonomous list-building | `exa_agent_run` | Default uses `ultra` effort capped at $1/run. For fast/cheap runs, use `mode: "fast"` ($0.012). Long runs return run ID; poll with `exa_agent_get`. |
| Server mode inspection & switching | `exa_mode` | Check active mode (`fast`, `auto`, `max`) or change it if the user requests. |
| Key pool health & budget check | `exa_keys_status` | View request counts, spend, and health across all pooled keys. |

## Modes

The server supports three quality presets:
- **`max` (default):** `deep-reasoning` search and `ultra` agent effort. Delivers the deepest reasoning and synthesis possible on the free tier.
- **`auto`:** Standard Exa defaults (`auto` search ~2 s, $0.007; agent `low` $0.025).
- **`fast`:** Lowest latency and token cost (`lite` search <1 s, $0.004; agent `minimal` $0.012).

### Mode Precedence
1. Explicit argument (`type: "deep"`, `effort: "medium"`)
2. Per-call preset (`mode: "fast" | "auto" | "max"`)
3. Server-wide saved mode (`exa_mode`)
4. Environment default (`EXA_MODE`)

## Structured Output Pattern

When extracting specific columns from pages, pass `outputSchema` and guide extraction with `systemPrompt`:
- Do NOT clutter `query` with filter commands like "only with author".
- Put retrieval keywords in `query`.
- Put keep/drop and verification rules in `systemPrompt`.
- Define the JSON schema in `outputSchema`.

Example:
```json
{
  "query": "vector database benchmark 2026",
  "systemPrompt": "Include only benchmarks that tested latency and throughput. Omit unverified vendor claims.",
  "outputSchema": {
    "type": "object",
    "properties": {
      "benchmarks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "database": { "type": "string" },
            "qps": { "type": "number" },
            "p99LatencyMs": { "type": "number" }
          },
          "required": ["database"]
        }
      }
    },
    "required": ["benchmarks"]
  }
}
```

## Agent API Patterns (`exa_agent_run`)
- Best for multi-step research, comprehensive market mapping, and list building.
- Bound array outputs in `outputSchema` with `maxItems` to prevent unbounded spend.
- Metered efforts (`auto`, `ultra`) are capped by `maxCostDollars` (default $1, max $10).
- If `wait: true` times out (default 120 s), read the returned `id` and poll with `exa_agent_get({ id, wait: true })`.
- Continue research on the same key using `previousRunId`.

## Free Tier Best Practices
- **Snapshot:** Exa Snapshot (`snapshotAsOf`) is a paid enterprise feature and will fail with 403 on free keys. Do not request historical snapshots unless the user has upgraded.
- **Token Efficiency:** Prefer `content: "highlights"` over `content: "text"` unless the complete document is strictly needed.
- **Key Health:** If all keys report exhausted or cooling down, check `exa_keys_status` to inspect spend per key.
