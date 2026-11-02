#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

const log = (msg: string) => process.stderr.write(`[exa-ultra] ${msg}\n`);

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const config = loadConfig();
for (const w of config.warnings) log(`warning: ${w}`);
if (!config.keys.length) {
  log("No Exa keys. Set EXA_API_KEYS (comma separated), EXA_API_KEY, EXA_API_KEYS_FILE, or pass --keys-file=PATH.");
  process.exit(1);
}

const { server, ctx } = createServer(config, log);

// Exit cleanly when the client goes away, so no orphaned processes stay behind.
const shutdown = () => {
  server.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (e) => log(`unhandled: ${ctx.exa.redact(String((e as Error)?.stack ?? e))}`));

await server.connect(new StdioServerTransport());
log(`v${VERSION} ready · ${ctx.pool.size} keys · mode ${config.mode} · strategy ${config.strategy} · agent ${config.enableAgent} · monitors ${config.enableMonitors}`);
