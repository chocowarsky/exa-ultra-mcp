// Test helpers: a programmable mock Exa API and an in-memory MCP client. No real keys, no credits.
import { createServer as http } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { createServer } from "../dist/server.js";

/**
 * Mock Exa. `handler(req)` returns [status, body, headers?] or a Promise of it; default is a
 * successful response per endpoint. Every request is recorded in `calls`.
 */
export async function mockExa() {
  const calls = [];
  const runs = new Map();
  const m = { calls, runs, handler: null, delayMs: 0 };
  const srv = http(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const call = { method: req.method, path: req.url, key: req.headers["x-api-key"], body, at: Date.now() };
    calls.push(call);
    if (m.delayMs) await new Promise((r) => setTimeout(r, m.delayMs));
    let out = m.handler ? await m.handler(call) : undefined;
    if (!out) out = defaultResponse(call, runs);
    const [status, payload, headers = {}] = out;
    if (res.destroyed) return;
    res.writeHead(status, { "content-type": typeof payload === "string" ? "text/html" : "application/json", ...headers });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  m.url = `http://127.0.0.1:${srv.address().port}`;
  m.close = () => new Promise((r) => (srv.closeAllConnections?.(), srv.close(r)));
  m.reset = () => {
    calls.length = 0;
    m.handler = null;
    m.delayMs = 0;
  };
  return m;
}

function defaultResponse(call, runs) {
  const p = call.path.split("?")[0];
  if (p === "/search")
    return [
      200,
      {
        requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
        results: [{ title: `Result for ${call.body?.query}`, url: "https://example.com/a", highlights: ["a highlight"] }],
        costDollars: { total: call.body?.type === "deep-reasoning" ? 0.015 : call.body?.type === "lite" ? 0.004 : 0.007 },
      },
    ];
  if (p === "/contents")
    return [
      200,
      {
        requestId: "req-c",
        results: (call.body?.urls ?? []).map((u) => ({ url: u, title: `Page ${u}`, text: "page text" })),
        statuses: (call.body?.urls ?? []).map((u) => ({ id: u, status: "success" })),
        costDollars: { total: 0.001 * (call.body?.urls?.length ?? 1) },
      },
    ];
  if (p === "/answer") return [200, { requestId: "req-a", answer: "42", citations: [{ title: "T", url: "https://example.com" }], costDollars: { total: 0.005 } }];
  if (p === "/agent/runs" && call.method === "POST") {
    const id = `agent_run_${runs.size + 1}`;
    runs.set(id, { key: call.key, polls: 0, body: call.body });
    return [200, { id, status: "running", effort: call.body?.effort }];
  }
  const g = p.match(/^\/agent\/runs\/([^/]+)$/);
  if (g && call.method === "GET") {
    const run = runs.get(g[1]);
    if (!run || run.key !== call.key) return [404, { error: "not found" }];
    run.polls++;
    if (run.polls < 2) return [200, { id: g[1], status: "running" }];
    return [200, { id: g[1], status: "completed", stopReason: "schema_satisfied", output: { text: "done" }, costDollars: { total: 0.2 } }];
  }
  if (p === "/agent/runs" && call.method === "GET") return [200, { data: [] }];
  return [404, { error: "unknown path" }];
}

/** Counts items by key (Object.groupBy needs Node 21). */
export const countBy = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});

export const tmpState = () => mkdtempSync(join(tmpdir(), "exa-ultra-test-"));

/** Starts an in-memory MCP server + client against the mock. */
export async function connect(mock, env = {}, keys = ["key-1", "key-2", "key-3"]) {
  const config = loadConfig(
    {
      EXA_API_KEYS: keys.join(","),
      EXA_BASE_URL: mock.url,
      EXA_STATE_DIR: env.EXA_STATE_DIR ?? tmpState(),
      EXA_QPS_PER_KEY: "0",
      EXA_TIMEOUT_MS: "3000",
      ...env,
    },
    ["node", "index.js"],
  );
  const { server, ctx } = createServer(config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name, args = {}, opts) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000, ...opts });
    return { ...r, text: r.content?.map((c) => c.text).join("\n") ?? "" };
  };
  return { client, server, ctx, config, call, close: () => client.close() };
}
