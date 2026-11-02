// Key pool, failover and state tests against the mock Exa API.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { KeyPool, parseKeys } from "../dist/core/keypool.js";
import { ExaClient, ExaError } from "../dist/core/client.js";
import { StateStore } from "../dist/core/state.js";
import { countBy, mockExa, tmpState } from "./helpers.mjs";

const mock = await mockExa();
after(() => mock.close());
beforeEach(() => mock.reset());

const mk = (keys, { strategy = "priority", budget = 10, dir = tmpState(), qps = 0, attempts = 5, timeoutMs = 3000 } = {}) => {
  const store = new StateStore(join(dir, "keys.json"));
  const pool = new KeyPool(keys, { strategy, monthlyBudget: budget, budgetMargin: 0.05, store });
  const exa = new ExaClient(pool, { baseUrl: mock.url, timeoutMs, maxAttempts: attempts, qpsPerKey: qps });
  return { pool, exa, store, dir };
};
const byKey = (map) => (c) => map[c.key]?.(c);

test("parseKeys: separators, quotes, comments, dedupe", () => {
  assert.deepEqual(parseKeys(' a, b\nc;a "d" \'e\'\n# comment\n'), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(parseKeys(""), []);
});

test("failover: 401 → 402 → 429 → 503 → 200, with the right penalty per key", async () => {
  mock.handler = byKey({
    k1: () => [401, { error: "Invalid API key" }],
    k2: () => [402, { error: "Insufficient credits" }],
    k3: () => [429, { error: "Rate limit exceeded" }, { "retry-after": "30" }],
    k4: () => [503, { error: "upstream" }],
  });
  const { pool, exa } = mk(["k1", "k2", "k3", "k4", "k5"]);
  const r = await exa.request("POST", "/search", { query: "q" });
  assert.equal(r.keyAlias, "k5");
  assert.deepEqual(r.attempts.map((a) => a.status), [401, 402, 429, 503, 200]);
  const st = pool.status();
  assert.match(st[0].state, /disabled: rejected/);
  assert.match(st[1].state, /credits exhausted/);
  assert.match(st[2].state, /cooldown (29|30)s/);
  assert.match(st[3].state, /cooldown/);
  assert.equal(st[4].spendUsd, 0.007);
  mock.calls.length = 0;
  await exa.request("POST", "/search", {});
  assert.deepEqual(mock.calls.map((c) => c.key), ["k5"], "next call goes straight to the healthy key");
});

test("400 is not retried and is reported as ExaError 400", async () => {
  mock.handler = () => [400, { error: "Invalid type" }];
  const { exa } = mk(["k1", "k2"]);
  await assert.rejects(exa.request("POST", "/search", {}), (e) => e instanceof ExaError && e.status === 400);
  assert.equal(mock.calls.length, 1);
});

test("403 'plan does not include' keeps the key healthy and is not retried", async () => {
  mock.handler = () => [403, { error: "Your current free plan doesn't include Exa Snapshot. Top up to upgrade." }];
  const { pool, exa } = mk(["k1", "k2"]);
  await assert.rejects(exa.request("POST", "/contents", {}), (e) => e.status === 403);
  assert.equal(mock.calls.length, 1);
  assert.ok(pool.status().every((s) => s.healthy));
});

test("timeouts and network errors fail over", async () => {
  mock.handler = (c) => (c.key === "k1" ? new Promise((r) => setTimeout(() => r([200, {}]), 1500)) : undefined);
  const { exa } = mk(["k1", "k2"], { timeoutMs: 300 });
  const r = await exa.request("POST", "/search", {});
  assert.deepEqual(r.attempts.map((a) => a.status), ["timeout", 200]);

  const dead = new ExaClient(mk(["k1"]).pool, { baseUrl: "http://127.0.0.1:1", timeoutMs: 500, maxAttempts: 2, qpsPerKey: 0 });
  await assert.rejects(dead.request("POST", "/search", {}), /Network error/);
});

test("200 with an HTML body is treated as a server fault, not a success", async () => {
  mock.handler = (c) => (c.key === "k1" ? [200, "<html>proxy error</html>"] : undefined);
  const { exa } = mk(["k1", "k2"]);
  const r = await exa.request("POST", "/search", {});
  assert.equal(r.keyAlias, "k2");
});

test("secrets never appear in error messages", async () => {
  mock.handler = (c) => [500, { error: `bad key ${c.key}` }];
  const { exa } = mk(["super-secret-key-1", "super-secret-key-2"]);
  await assert.rejects(exa.request("POST", "/search", {}), (e) => !/super-secret/.test(e.message) && /\[key\]/.test(e.message));
});

test("round-robin spreads load; priority sticks to k1; least-used picks the cheapest", async () => {
  const rr = mk(["k1", "k2", "k3"], { strategy: "round-robin" });
  for (let i = 0; i < 6; i++) await rr.exa.request("POST", "/search", {});
  const counts = countBy(mock.calls, (c) => c.key);
  assert.deepEqual(Object.values(counts), [2, 2, 2]);

  mock.calls.length = 0;
  const pr = mk(["k1", "k2"]);
  for (let i = 0; i < 3; i++) await pr.exa.request("POST", "/search", {});
  assert.deepEqual(mock.calls.map((c) => c.key), ["k1", "k1", "k1"]);

  mock.calls.length = 0;
  const lu = mk(["k1", "k2"], { strategy: "least-used" });
  lu.pool.addSpend(lu.pool.keys[0].fp, 1);
  await lu.exa.request("POST", "/search", {});
  assert.deepEqual(mock.calls.map((c) => c.key), ["k2"]);
});

test("monthly budget: key over budget is skipped; all over budget → clear error, no request", async () => {
  const { pool, exa } = mk(["k1", "k2"], { budget: 1 });
  pool.addSpend(pool.keys[0].fp, 0.99);
  await exa.request("POST", "/search", {});
  assert.deepEqual(mock.calls.map((c) => c.key), ["k2"]);
  pool.addSpend(pool.keys[1].fp, 0.99);
  mock.calls.length = 0;
  await assert.rejects(exa.request("POST", "/search", {}), /No usable Exa key/);
  assert.equal(mock.calls.length, 0, "over-budget keys are never used, even as a last resort");
});

test("need: reservation of an agent run's cap skips keys without room", async () => {
  const { pool, exa } = mk(["k1", "k2"], { budget: 10 });
  pool.addSpend(pool.keys[0].fp, 9.5);
  await exa.request("POST", "/agent/runs", {}, { need: 1, cost: () => 0 });
  assert.deepEqual(mock.calls.map((c) => c.key), ["k2"]);
  pool.reserve("run-x", pool.keys[1].fp, 9);
  await assert.rejects(exa.request("POST", "/agent/runs", {}, { need: 1 }), /budget left/);
  pool.release("run-x");
  await exa.request("POST", "/agent/runs", {}, { need: 1, cost: () => 0 });
});

test("bookOnce books a run's cost exactly once and frees its reservation", () => {
  const { pool } = mk(["k1"]);
  const fp = pool.keys[0].fp;
  pool.reserve("r1", fp, 1);
  assert.equal(pool.status()[0].reservedUsd, 1);
  assert.equal(pool.bookOnce("r1", fp, 0.3), true);
  assert.equal(pool.bookOnce("r1", fp, 0.3), false);
  assert.equal(pool.status()[0].spendUsd, 0.3);
  assert.equal(pool.status()[0].reservedUsd, 0);
});

test("pinned request never leaves its key", async () => {
  mock.handler = (c) => (c.key === "k1" ? [503, {}] : undefined);
  const { pool, exa } = mk(["k1", "k2"]);
  await assert.rejects(exa.request("GET", "/agent/runs/x", undefined, { pin: pool.keys[0].fp }));
  assert.deepEqual(mock.calls.map((c) => c.key), ["k1"]);
});

test("all keys cooling down: tries the one that frees first instead of failing", async () => {
  const { pool, exa } = mk(["k1", "k2"]);
  pool.failure(pool.keys[0].fp, "rate", "x", 60_000);
  pool.failure(pool.keys[1].fp, "rate", "x", 5_000);
  await exa.request("POST", "/search", {});
  assert.deepEqual(mock.calls.map((c) => c.key), ["k2"]);
});

test("state is shared between processes: two pools on one file add up spend", async () => {
  const dir = tmpState();
  const a = mk(["k1"], { dir });
  const b = mk(["k1"], { dir });
  await Promise.all([...Array(20)].map((_, i) => (i % 2 ? a : b).exa.request("POST", "/search", {})));
  const st = a.pool.status()[0];
  assert.equal(st.requests, 20);
  assert.equal(st.spendUsd, 0.14);
  // b sees a's cooldown
  a.pool.failure(a.pool.keys[0].fp, "auth", "x");
  assert.equal(b.pool.status()[0].healthy, false);
});

test("state file: corrupt JSON and old v1 format are handled; keys never written", async () => {
  const dir = tmpState();
  const file = join(dir, "keys.json");
  writeFileSync(file, "{not json");
  const a = mk(["secret-abc-123"], { dir });
  await a.exa.request("POST", "/search", {});
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes("secret-abc-123"));
  assert.equal(JSON.parse(saved).version, 2);

  writeFileSync(file, JSON.stringify({ keys: { [a.pool.keys[0].fp]: { month: new Date().toISOString().slice(0, 7), requests: 3, spend: 0.5 } }, owners: {} }));
  const b = mk(["secret-abc-123"], { dir });
  assert.equal(b.pool.status()[0].spendUsd, 0.5);
});

test("month rollover resets spend and lifts 'credits exhausted'", () => {
  const dir = tmpState();
  const a = mk(["k1"], { dir });
  a.pool.failure(a.pool.keys[0].fp, "credits", "no credits");
  const file = join(dir, "keys.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  const r = s.keys[a.pool.keys[0].fp];
  r.month = "2000-01";
  r.spend = 9.99;
  r.disabledUntil = Date.now() + 1e9;
  writeFileSync(file, JSON.stringify(s));
  const b = mk(["k1"], { dir });
  const st = b.pool.status()[0];
  assert.equal(st.spendUsd, 0);
  assert.equal(st.healthy, true);
});

test("unwritable state dir falls back to memory instead of crashing", async () => {
  const blocker = join(tmpState(), "not-a-dir");
  writeFileSync(blocker, "x"); // a file where the state dir should be → ENOTDIR
  const { pool, exa } = mk(["k1"], { dir: join(blocker, "state") });
  await exa.request("POST", "/search", {});
  assert.equal(pool.status()[0].requests, 1);
});

test("QPS pacing: 10 calls on one key at 20 QPS take ≥ 400 ms", async () => {
  const { exa } = mk(["k1"], { qps: 20 });
  const t = Date.now();
  await Promise.all([...Array(10)].map(() => exa.request("POST", "/search", {})));
  assert.ok(Date.now() - t >= 400, `took ${Date.now() - t} ms`);
});

test("cancellation stops the request and does not penalise the key", async () => {
  mock.delayMs = 1000;
  const { pool, exa } = mk(["k1", "k2"]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(exa.request("POST", "/search", {}, { signal: ac.signal }), /Cancelled/);
  assert.ok(pool.status().every((s) => s.healthy));
});

test("baseUrl with a path prefix is kept", async () => {
  const pool = mk(["k1"]).pool;
  const exa = new ExaClient(pool, { baseUrl: `${mock.url}/prefix`, timeoutMs: 2000, maxAttempts: 1, qpsPerKey: 0 });
  await assert.rejects(exa.request("POST", "/search", {}));
  assert.equal(mock.calls[0].path, "/prefix/search");
});
