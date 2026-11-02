// Live smoke test through a real stdio MCP client. Uses REAL credits (about $0.10).
// Usage: EXA_API_KEYS_FILE=/path/to/keys node test/smoke.mjs
// Never paste keys on the command line or into this file.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.EXA_API_KEYS_FILE && !process.env.EXA_API_KEYS && !process.env.EXA_API_KEY) {
  console.error("Set EXA_API_KEYS_FILE (recommended), EXA_API_KEYS or EXA_API_KEY.");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...process.env, EXA_ENABLE_MONITORS: "1", EXA_MODE: process.env.EXA_MODE ?? "max" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "1" });
await client.connect(transport);
console.log("TOOLS:", (await client.listTools()).tools.map((t) => t.name).join(", "));

const results = [];
async function run(label, name, args, expectError = false) {
  const t0 = Date.now();
  let r;
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  } catch (e) {
    r = { isError: true, content: [{ text: `client error: ${e.message}` }] };
  }
  const text = r.content?.map((c) => c.text).join("\n") ?? "";
  const pass = expectError ? !!r.isError : !r.isError;
  results.push({ label, pass, ms: Date.now() - t0, chars: text.length });
  console.log(`\n===== ${pass ? "PASS" : "FAIL"} ${label} (${Date.now() - t0} ms, ${text.length} chars)\n${text.slice(0, 700)}`);
  return r;
}

const keys = (await client.callTool({ name: "exa_keys_status", arguments: {} })).structuredContent.keys.length;
for (let i = 1; i <= keys; i++) await run(`key check ${i} (fast)`, "exa_search", { query: `exa ai search api ${i}`, mode: "fast", numResults: 1, noCache: true });
await run("search mode max (deep-reasoning)", "exa_search", { query: "latest open source LLM releases", numResults: 3, objective: "Find official announcements of open-weight model releases" });
await run("search mode auto", "exa_search", { query: "latest open source LLM releases", mode: "auto", numResults: 3 });
await run("search outputSchema", "exa_search", {
  query: "Exa AI search API pricing",
  mode: "auto",
  numResults: 3,
  outputSchema: { type: "object", properties: { autoPricePer1k: { type: "string" }, litePricePer1k: { type: "string" } }, required: ["autoPricePer1k"] },
});
await run("contents text", "exa_contents", { urls: ["https://exa.ai/pricing"], maxCharacters: 1500 });
await run("contents subpages+links", "exa_contents", { urls: ["https://exa.ai/docs"], content: "highlights", highlightsQuery: "search endpoint", subpages: 2, subpageTarget: "search", links: 5 });
await run("find similar (auto)", "exa_find_similar", { url: "https://exa.ai", numResults: 3, mode: "auto", focus: "competing web search APIs for AI agents" });
await run("answer", "exa_answer", { query: "What year was Exa AI (formerly Metaphor) founded?" });
await run("agent mode fast (minimal)", "exa_agent_run", { query: "Name 2 web search APIs built for AI agents, with their website.", mode: "fast", waitSeconds: 180 });
await run("guard: lite + outputSchema", "exa_search", { query: "x", type: "lite", outputSchema: { type: "object" } }, true);
await run("guard: budget on fixed effort", "exa_agent_run", { query: "x", effort: "high", maxCostDollars: 2 }, true);
await run("snapshot on free plan → isError, keys stay healthy", "exa_contents", { urls: ["https://exa.ai"], snapshotAsOf: "2026-06-01T00:00:00Z" }, true);
await run("monitor list", "exa_monitor", { action: "list" });
await run("mode show", "exa_mode", {});
const st = await run("keys status", "exa_keys_status", {});
if (st.structuredContent?.keys?.some((k) => !k.healthy)) results.push({ label: "all keys healthy after run", pass: false, ms: 0, chars: 0 });

console.log("\n===== SUMMARY");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.label.padEnd(48)} ${String(r.ms).padStart(6)} ms  ${String(r.chars).padStart(6)} chars`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
await client.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
