// End-to-end tool tests over an in-memory MCP connection against the mock Exa API.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { mockExa, connect, tmpState } from "./helpers.mjs";

const mock = await mockExa();
after(() => mock.close());
beforeEach(() => mock.reset());
const last = (path) => mock.calls.filter((c) => c.path === path && c.method === "POST").at(-1);

test("tool list matches config flags", async () => {
  const s = await connect(mock);
  const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["exa_agent_get", "exa_agent_manage", "exa_agent_run", "exa_answer", "exa_contents", "exa_find_similar", "exa_keys_status", "exa_mode", "exa_search"]);
  await s.close();
  const s2 = await connect(mock, { EXA_ENABLE_AGENT: "0", EXA_ENABLE_MONITORS: "1" });
  const n2 = (await s2.client.listTools()).tools.map((t) => t.name);
  assert.ok(n2.includes("exa_monitor") && !n2.includes("exa_agent_run"));
  await s2.close();
});

test("modes: default max → deep-reasoning / ultra; EXA_MODE=auto → auto / low; fast → lite / minimal", async () => {
  for (const [mode, type, effort] of [
    [undefined, "deep-reasoning", "ultra"],
    ["auto", "auto", "low"],
    ["fast", "lite", "minimal"],
  ]) {
    const s = await connect(mock, mode ? { EXA_MODE: mode } : {});
    await s.call("exa_search", { query: "q" });
    assert.equal(last("/search").body.type, type, `search type for ${mode ?? "default"}`);
    await s.call("exa_agent_run", { query: "q", wait: false });
    assert.equal(last("/agent/runs").body.effort, effort, `agent effort for ${mode ?? "default"}`);
    await s.close();
  }
});

test("mode precedence: explicit type/effort > per-call mode > server mode", async () => {
  const s = await connect(mock);
  await s.call("exa_search", { query: "q", mode: "auto" });
  assert.equal(last("/search").body.type, "auto");
  await s.call("exa_search", { query: "q", mode: "auto", type: "deep" });
  assert.equal(last("/search").body.type, "deep");
  await s.call("exa_agent_run", { query: "q", mode: "fast", effort: "medium", wait: false });
  assert.equal(last("/agent/runs").body.effort, "medium");
  await s.close();
});

test("exa_mode: set is shared by every session on the machine and survives restarts; reset goes back", async () => {
  const dir = tmpState();
  const a = await connect(mock, { EXA_STATE_DIR: dir });
  const b = await connect(mock, { EXA_STATE_DIR: dir });
  const r = await a.call("exa_mode", { set: "auto" });
  assert.match(r.text, /Mode: auto \(saved/);
  await b.call("exa_search", { query: "q" });
  assert.equal(last("/search").body.type, "auto", "other session follows the saved mode");
  await a.close();
  const c = await connect(mock, { EXA_STATE_DIR: dir });
  assert.match((await c.call("exa_mode")).text, /Mode: auto/);
  await c.call("exa_mode", { reset: true });
  assert.match((await b.call("exa_mode")).text, /Mode: max \(from EXA_MODE/);
  assert.equal((await c.call("exa_mode", { set: "max", reset: true })).isError, true);
  await b.close();
  await c.close();
});

test("mode fallbacks never break a call: fast + outputSchema → auto; max + Snapshot → auto", async () => {
  const s = await connect(mock, { EXA_MODE: "fast" });
  const r = await s.call("exa_search", { query: "q", outputSchema: { type: "object" } });
  assert.equal(last("/search").body.type, "auto");
  assert.match(r.text, /note: mode fast uses lite/);
  await s.close();
  const m = await connect(mock);
  await m.call("exa_search", { query: "q", snapshotAsOf: "2026-01-01T00:00:00Z" });
  assert.equal(last("/search").body.type, "auto");
  await m.close();
});

test("explicit invalid combos are rejected locally, before any request", async () => {
  const s = await connect(mock);
  const cases = [
    ["exa_search", { query: "q", type: "lite", outputSchema: { type: "object" } }],
    ["exa_search", { query: "q", type: "lite", content: "summary" }],
    ["exa_search", { query: "q", type: "deep", snapshotAsOf: "2026-01-01" }],
    ["exa_search", { query: "q", category: "people", excludeDomains: ["a.com"] }],
    ["exa_search", { query: "q", category: "company", startPublishedDate: "2026-01-01" }],
    ["exa_search", { query: "q", startPublishedDate: "2026-02-01", endPublishedDate: "2026-01-01" }],
    ["exa_search", { query: "q", includeText: ["one two three four five six"] }],
    ["exa_search", { query: "q", includeText: ["a", "b"] }],
    ["exa_search", { query: "q", startPublishedDate: "kemarin" }],
    ["exa_search", { query: "   " }],
    ["exa_search", { query: "q", userLocation: "INVALID" }],
    ["exa_search", { query: "q", includeText: ["   "] }],
    ["exa_contents", { urls: ["https://a.com"], snapshotAsOf: "2026-01-01", maxAgeHours: 0 }],
    ["exa_contents", { urls: ["not a url"] }],
    ["exa_contents", { urls: [] }],
    ["exa_agent_run", { query: "q", effort: "high", maxCostDollars: 2 }],
    ["exa_agent_run", { query: "q", effort: "auto", maxDurationSeconds: 600 }],
    ["exa_agent_run", { query: "q", maxCostDollars: 50 }],
    ["exa_agent_get", { id: "../../etc/passwd" }],
    ["exa_keys_status", { action: "reset", alias: "k99" }],
  ];
  for (const [tool, args] of cases) {
    const r = await s.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} should fail: ${r.text}`);
  }
  assert.equal(mock.calls.length, 0, "no credits spent on invalid calls");
  await s.close();
});

test("search output: compact text, structured results, cost, cache hit on repeat and on key order", async () => {
  const s = await connect(mock);
  const a = await s.call("exa_search", { query: "q", numResults: 3, objective: "o" });
  assert.match(a.text, /Result for q/);
  assert.equal(a.structuredContent.results[0].url, "https://example.com/a");
  assert.equal(a.structuredContent.costDollars.total, 0.015);
  const b = await s.call("exa_search", { objective: "o", numResults: 3, query: "q" });
  assert.equal(b.structuredContent.cached, true);
  assert.equal(mock.calls.length, 1);
  await s.call("exa_search", { query: "q", numResults: 3, objective: "o", noCache: true });
  assert.equal(mock.calls.length, 2);
  await s.close();
});

test("concurrent identical searches share one Exa call", async () => {
  mock.delayMs = 200;
  const s = await connect(mock);
  const rs = await Promise.all([...Array(8)].map(() => s.call("exa_search", { query: "same" })));
  assert.equal(mock.calls.length, 1);
  assert.ok(rs.every((r) => !r.isError));
  await s.close();
});

test("one caller cancelling a shared request does not fail the other caller", async () => {
  mock.delayMs = 400;
  const s = await connect(mock);
  const ac = new AbortController();
  const a = s.call("exa_search", { query: "shared" }, { signal: ac.signal });
  const b = s.call("exa_search", { query: "shared" });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(a);
  const rb = await b;
  assert.equal(rb.isError, undefined, rb.text);
  await s.close();
});

test("errors come back as isError with no key in the text", async () => {
  mock.handler = (c) => [500, { error: `boom ${c.key}` }];
  const s = await connect(mock, {}, ["very-secret-1", "very-secret-2"]);
  const r = await s.call("exa_search", { query: "q", mode: "auto" });
  assert.equal(r.isError, true);
  assert.ok(!r.text.includes("very-secret"));
  await s.close();
});

test("contents: all URLs failed → isError; some failed → listed, not an error; duplicates removed", async () => {
  const s = await connect(mock);
  mock.handler = () => [200, { results: [], statuses: [{ id: "https://a.com", status: "error", error: { tag: "CRAWL_NOT_FOUND" } }] }];
  const r = await s.call("exa_contents", { urls: ["https://a.com"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /CRAWL_NOT_FOUND/);
  mock.handler = null;
  const ok = await s.call("exa_contents", { urls: ["https://b.com", "https://b.com"], noCache: true });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(last("/contents").body.urls, ["https://b.com"]);
  await s.close();
});

test("find_similar: unreadable seed still searches; seed domain excluded", async () => {
  mock.handler = (c) => (c.path === "/contents" ? [500, {}] : undefined);
  const s = await connect(mock, { EXA_MAX_ATTEMPTS: "1" });
  const r = await s.call("exa_find_similar", { url: "https://www.seed.com/x", mode: "auto" });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /seed page could not be read/);
  assert.deepEqual(last("/search").body.excludeDomains, ["seed.com"]);
  await s.close();
});

test("agent: ultra sends budget cap, waits, books cost once, frees reservation", async () => {
  const s = await connect(mock, { EXA_AGENT_MAX_COST: "2" });
  const r = await s.call("exa_agent_run", { query: "research", waitSeconds: 30 });
  assert.equal(r.structuredContent.status, "completed", r.text);
  assert.deepEqual(last("/agent/runs").body.budget, { maxCostDollars: 2 });
  await s.call("exa_agent_get", { id: r.structuredContent.id });
  const st = (await s.call("exa_keys_status")).structuredContent;
  assert.equal(st.totalSpendUsd, 0.2, "cost booked once even after a second get");
  assert.ok(st.keys.every((k) => k.reservedUsd === 0));
  await s.close();
});

test("agent: wait=false reserves the cap; get on an unknown owner finds the right key", async () => {
  const dir = tmpState();
  const s = await connect(mock, { EXA_STATE_DIR: dir });
  const r = await s.call("exa_agent_run", { query: "q", wait: false });
  const st = (await s.call("exa_keys_status")).structuredContent;
  assert.equal(st.keys.reduce((n, k) => n + k.reservedUsd, 0), 1);
  // A fresh state dir knows no owner: the run must be found by probing keys.
  const t = await connect(mock, {});
  const g = await t.call("exa_agent_get", { id: r.structuredContent.id, wait: true, waitSeconds: 20 });
  assert.equal(g.structuredContent.status, "completed", g.text);
  await s.close();
  await t.close();
});

test("agent follow-up stays on the key that owns the previous run", async () => {
  const s = await connect(mock, { EXA_MODE: "auto" });
  const r = await s.call("exa_agent_run", { query: "q", wait: false });
  const owner = mock.calls.at(-1).key;
  for (let i = 0; i < 3; i++) await s.call("exa_agent_run", { query: "follow", previousRunId: r.structuredContent.id, wait: false });
  assert.ok(mock.calls.filter((c) => c.body?.previousRunId).every((c) => c.key === owner));
  await s.close();
});

test("agent cancellation by the client returns promptly", async () => {
  mock.handler = (c) => (c.method === "GET" && c.path.startsWith("/agent/runs/") ? [200, { id: c.path.split("/").pop(), status: "running" }] : undefined);
  const s = await connect(mock);
  const ac = new AbortController();
  const t = Date.now();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(s.call("exa_agent_run", { query: "q", waitSeconds: 600 }, { signal: ac.signal }));
  assert.ok(Date.now() - t < 3000);
  await s.close();
});

test("config: bad values fall back with warnings; missing keys file is a warning, not a crash", () => {
  const c = loadConfig({ EXA_API_KEYS: "a", EXA_MODE: "turbo", EXA_TIMEOUT_MS: "abc", EXA_KEY_STRATEGY: "random", EXA_API_KEYS_FILE: "/nope" }, ["node", "x"]);
  assert.equal(c.mode, "max");
  assert.equal(c.timeoutMs, 60000);
  assert.equal(c.strategy, "round-robin");
  assert.equal(c.warnings.length, 4);
  assert.equal(loadConfig({ EXA_API_KEYS: "a" }, ["node", "x", "--mode=fast"]).mode, "fast");
});

test("keys_status and resources never expose a key", async () => {
  const s = await connect(mock, {}, ["abcdefgh-secret-0001", "abcdefgh-secret-0002"]);
  const r = await s.call("exa_keys_status");
  assert.ok(!r.text.includes("abcdefgh-secret"));
  assert.match(r.text, /…0001/);
  const res = await s.client.readResource({ uri: "exa://keys/status" });
  assert.ok(!res.contents[0].text.includes("abcdefgh-secret"));
  const modes = await s.client.readResource({ uri: "exa://modes" });
  assert.equal(JSON.parse(modes.contents[0].text).current, "max");
  await s.close();
});

test("malformed API responses are formatted safely without crashing", async () => {
  const s = await connect(mock);
  mock.handler = () => [
    200,
    {
      results: [null, { title: "Valid Result", url: "https://example.com/ok", extras: { links: "not-an-array" } }],
      statuses: [
        { id: "https://fail.com", status: "error", error: { message: "Upstream failure", code: 502 } }
      ],
      output: {
        content: "test output",
        grounding: [{ field: "summary", citations: null }]
      },
      costDollars: { total: NaN }
    }
  ];
  const r = await s.call("exa_search", { query: "malformed test", noCache: true });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /Valid Result/);
  assert.match(r.text, /Upstream failure/);
  assert.ok(!r.text.includes("[object Object]"));
  assert.match(r.text, /cost n\/a/);
  await s.close();
});

test("errors preserve diagnostic context in structuredContent", async () => {
  mock.handler = () => [400, { error: "Query syntax invalid" }];
  const s = await connect(mock);
  const r = await s.call("exa_search", { query: "bad syntax", noCache: true });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.status, 400);
  assert.equal(r.structuredContent.error, true);
  assert.ok(r.structuredContent.message.includes("Query syntax invalid"));
  await s.close();
});
