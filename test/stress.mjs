// Stress test against the mock Exa API (no real keys, no credits).
// 1) N concurrent tool calls in one process with random 429/5xx/timeouts/HTML errors.
// 2) P real server processes (stdio) sharing one state file, to check that spend adds up.
// Usage: npm run stress   (env: STRESS_CALLS=1000 STRESS_PROCS=4)
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { countBy, mockExa, connect, tmpState } from "./helpers.mjs";

const N = Number(process.env.STRESS_CALLS ?? 1000);
const P = Number(process.env.STRESS_PROCS ?? 4);
const mock = await mockExa();
const keys = ["key-a", "key-b", "key-c", "key-d", "key-e"];
const pct = (a, p) => a.sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];

// ---------- 1. one process, chaos ----------
let n = 0;
mock.handler = (c) => {
  const r = (++n * 7919) % 100; // deterministic pseudo-random
  if (r < 8) return [429, { error: "Rate limit exceeded" }, { "retry-after": "0" }];
  if (r < 14) return [503, { error: "upstream" }];
  if (r < 17) return [200, "<html>bad gateway</html>"];
  if (r < 19) return new Promise((res) => setTimeout(() => res([200, {}]), 4000)); // > timeout
  return undefined;
};
const s = await connect(mock, { EXA_TIMEOUT_MS: "1500", EXA_MAX_ATTEMPTS: "5", EXA_MODE: "auto" }, keys);
const mem0 = process.memoryUsage().rss;
const lat = [];
let errors = 0;
const t0 = Date.now();
await Promise.all(
  [...Array(N)].map(async (_, i) => {
    const t = Date.now();
    const r = await s.call("exa_search", { query: `stress query ${i % 300}`, noCache: i % 3 === 0 });
    lat.push(Date.now() - t);
    if (r.isError) errors++;
    assert.ok(!keys.some((k) => r.text.includes(k)), "key leaked into output");
  }),
);
const wall = Date.now() - t0;
const st = (await s.call("exa_keys_status")).structuredContent;
const exaCalls = mock.calls.length;
console.log(
  `[1] ${N} calls in ${wall} ms · ${errors} errors (${((errors / N) * 100).toFixed(1)}%) · Exa requests ${exaCalls} · p50 ${pct(lat, 0.5)} ms · p99 ${pct(lat, 0.99)} ms · RSS +${((process.memoryUsage().rss - mem0) / 1e6).toFixed(1)} MB · cache ${st.keys ? "ok" : "?"}`,
);
assert.ok(errors / N < 0.02, `error rate too high: ${errors}`);
const perKey = countBy(mock.calls, (c) => c.key);
console.log(`    requests per key: ${keys.map((k) => `${k.slice(-1)}=${perKey[k] ?? 0}`).join(" ")}`);
await s.close();

// ---------- 2. P processes sharing one state file ----------
mock.reset();
const dir = tmpState();
const procs = await Promise.all(
  [...Array(P)].map(async () => {
    const c = new Client({ name: "stress", version: "1" });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../dist/index.js", import.meta.url).pathname],
        env: { PATH: process.env.PATH, EXA_API_KEYS: keys.join(","), EXA_BASE_URL: mock.url, EXA_STATE_DIR: dir, EXA_MODE: "auto", EXA_QPS_PER_KEY: "0" },
        stderr: "ignore",
      }),
    );
    return c;
  }),
);
const per = 100;
const t1 = Date.now();
await Promise.all(procs.flatMap((c, p) => [...Array(per)].map((_, i) => c.callTool({ name: "exa_search", arguments: { query: `p${p} q${i}`, noCache: true } }))));
const st2 = (await procs[0].callTool({ name: "exa_keys_status", arguments: {} })).structuredContent;
const total = st2.keys.reduce((a, k) => a + k.requests, 0);
console.log(`[2] ${P} processes × ${per} calls in ${Date.now() - t1} ms · tracked requests ${total}/${P * per} · tracked spend $${st2.totalSpendUsd} (expected $${(P * per * 0.007).toFixed(3)})`);
assert.equal(total, P * per, "requests lost between processes");
assert.equal(st2.totalSpendUsd, Number((P * per * 0.007).toFixed(4)));
await Promise.all(procs.map((c) => c.close()));

await mock.close();
console.log("stress OK");
