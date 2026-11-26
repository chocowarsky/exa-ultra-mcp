#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultKeyFileCandidates, loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

const log = (msg: string) => process.stderr.write(`[exa-ultra] ${msg}\n`);

const HELP = `exa-ultra-mcp v${VERSION} — Local offline stdio MCP server for the full Exa API

Usage:
  node dist/index.js [options]

Options:
  --keys-file=PATH    Private file with Exa API keys (plain text or JSON; supports ~/)
  --mode=MODE         Default quality preset: fast | auto | max (default: max)
  --doctor            Run offline readiness & key check (spends $0 credits) and exit
  --json              Format --doctor output as JSON
  --version           Print server version and exit
  --help, -h          Show this help message and exit

Key discovery order (never commit keys to git or paste in chat):
  1. --keys-file=PATH (or --keys-file PATH)
  2. EXA_API_KEYS_FILE env var
  3. EXA_API_KEYS (comma/newline separated) or EXA_API_KEY env var
  4. Auto-discovered private file: ~/.config/exa-ultra/keys (.txt / .json)
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const config = loadConfig();

if (process.argv.includes("--doctor")) {
  const asJson = process.argv.includes("--json");
  const redactedKeys = config.keys.map((secret, i) => ({
    alias: `k${i + 1}`,
    key: `…${secret.slice(-4)}`,
  }));
  const report = {
    name: "exa-ultra-mcp",
    version: VERSION,
    node: process.version,
    transport: "stdio (local/offline)",
    ready: config.keys.length > 0,
    keyCount: config.keys.length,
    keys: redactedKeys,
    keySources: config.keySources,
    defaultKeyFileCandidates: defaultKeyFileCandidates(),
    mode: config.mode,
    strategy: config.strategy,
    monthlyBudgetPerKeyUsd: config.monthlyBudget,
    stateDir: config.stateDir,
    enableAgent: config.enableAgent,
    enableMonitors: config.enableMonitors,
    warnings: config.warnings,
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`exa-ultra-mcp v${VERSION} offline doctor\n`);
    process.stdout.write(`  Node        : ${report.node}\n`);
    process.stdout.write(`  Transport   : ${report.transport}\n`);
    process.stdout.write(`  Keys loaded : ${report.keyCount} (${redactedKeys.map((k) => `${k.alias}:${k.key}`).join(", ") || "none"})\n`);
    process.stdout.write(`  Key sources : ${report.keySources.join(", ") || "none found"}\n`);
    process.stdout.write(`  Mode        : ${report.mode} · strategy ${report.strategy} · budget $${report.monthlyBudgetPerKeyUsd}/key/mo\n`);
    process.stdout.write(`  State dir   : ${report.stateDir}\n`);
    if (report.warnings.length) {
      for (const w of report.warnings) process.stdout.write(`  Warning     : ${w}\n`);
    }
    process.stdout.write(`  Status      : ${report.ready ? "READY" : "MISSING KEYS — create ~/.config/exa-ultra/keys (chmod 600) or pass --keys-file=PATH"}\n`);
  }
  process.exit(report.ready ? 0 : 1);
}

for (const w of config.warnings) log(`warning: ${w}`);
if (!config.keys.length) {
  log(
    "No Exa keys configured. Create ~/.config/exa-ultra/keys (chmod 600), " +
      "set EXA_API_KEYS / EXA_API_KEY / EXA_API_KEYS_FILE, or pass --keys-file=PATH.",
  );
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
