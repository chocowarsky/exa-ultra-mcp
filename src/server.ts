import { join } from "node:path";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { TtlCache } from "./core/cache.js";
import { ExaClient, type CallResult } from "./core/client.js";
import { KeyPool } from "./core/keypool.js";
import { StateStore } from "./core/state.js";
import { MODES } from "./modes.js";
import { registerTools } from "./tools/index.js";
import { serverMode, type Ctx } from "./tools/shared.js";

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

/** Builds a ready-to-connect MCP server from a config. Used by the CLI and by the tests. */
export function createServer(config: Config, log: (msg: string) => void = () => {}): { server: McpServer; ctx: Ctx } {
  const store = new StateStore(join(config.stateDir, "keys.json"), log);
  const pool = new KeyPool(config.keys, {
    strategy: config.strategy,
    monthlyBudget: config.monthlyBudget,
    budgetMargin: config.budgetMargin,
    store,
  });
  const exa = new ExaClient(pool, {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    qpsPerKey: config.qpsPerKey,
    userAgent: `exa-ultra-mcp/${VERSION}`,
  });
  const cache = new TtlCache<CallResult>(config.cacheTtlMs, config.cacheMax);
  const ctx: Ctx = { exa, pool, cache, store, config };

  const server = new McpServer(
    { name: "exa-ultra", version: VERSION },
    {
      instructions:
        `Exa Ultra: the Exa API (search, contents, similar, answer${config.enableAgent ? ", agent runs" : ""}${config.enableMonitors ? ", monitors" : ""}) over ${pool.size} pooled keys with automatic failover. ` +
        `Quality modes: fast · auto · max (default: ${config.mode}; check exa_mode). Pass mode=fast for quick lookups. ` +
        "Use exa_search first (highlights), exa_contents for known URLs, exa_answer for a quick cited fact, exa_agent_run for multi-step research or list-building.",
    },
  );

  registerTools(server, ctx);

  server.registerResource(
    "keys-status",
    "exa://keys/status",
    { title: "Exa key pool status", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ mode: serverMode(ctx), keys: pool.status() }, null, 2) }],
    }),
  );

  server.registerResource(
    "modes",
    "exa://modes",
    { title: "Exa Ultra quality modes", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ current: serverMode(ctx), modes: MODES }, null, 2) }],
    }),
  );

  server.registerPrompt(
    "exa_research",
    {
      title: "Research a topic with Exa",
      description: "Search, read the best sources, and write a cited brief.",
      argsSchema: { topic: z.string(), mode: z.string().optional() },
    },
    ({ topic, mode }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Research: ${topic}\n\n1. Call exa_search with a clear query and an objective${mode ? ` and mode=${mode}` : ""}.\n` +
              "2. Read the 2-3 most relevant URLs with exa_contents if highlights are not enough.\n" +
              "3. Write a concise brief with inline [n] citations to the URLs. Say what is uncertain.",
          },
        },
      ],
    }),
  );

  return { server, ctx };
}
