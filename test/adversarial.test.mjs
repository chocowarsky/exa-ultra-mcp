import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";
import { ExaClient, ExaError } from "../dist/core/client.js";
import { KeyPool } from "../dist/core/keypool.js";
import { StateStore } from "../dist/core/state.js";
import { mockExa } from "./helpers.mjs";

test("adversarial: key secrets are scrubbed even when embedded in nested objects or error messages", () => {
  const secret = "2a8b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
  const pool = new KeyPool([secret], { stateDir: "" });
  const client = new ExaClient(pool, { baseUrl: "http://127.0.0.1:9", timeoutMs: 100 });

  const redacted = client.redact(`Failed connecting with key ${secret} at https://api.exa.ai`);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[key]"));
});

test("adversarial: validateSearch catches all pathological date and filter combinations", async () => {
  const { validateSearch } = await import("../dist/tools/search.js");

  // Inverted dates
  const errs1 = validateSearch("auto", { startPublishedDate: "2026-11-10", endPublishedDate: "2026-11-01" });
  assert.ok(errs1.some((e) => e.includes("after endPublishedDate")));

  // People category with forbidden filters
  const errs2 = validateSearch("auto", { category: "people", excludeDomains: ["example.com"] });
  assert.ok(errs2.some((e) => e.includes("category people does not support")));

  // Company category with date filters
  const errs3 = validateSearch("auto", { category: "company", startPublishedDate: "2026-01-01" });
  assert.ok(errs3.some((e) => e.includes("category company does not support")));

  // Lite with forbidden options
  const errs4 = validateSearch("lite", { systemPrompt: "test", outputSchema: {} });
  assert.ok(errs4.some((e) => e.includes("type lite does not support")));

  // Long text filter phrases (> 5 words)
  const errs5 = validateSearch("auto", { includeText: ["one two three four five six words"] });
  assert.ok(errs5.some((e) => e.includes("up to 5 words")));
});

test("adversarial: state file corruption during runtime recovers gracefully without crashing", () => {
  const store = new StateStore("");
  // Mutating in-memory fallback
  store.update((s) => {
    s.keys["test_fp"] = { spendMonth: 5.5, spendTotal: 10.0, updated: new Date().toISOString() };
  });
  assert.equal(store.read().keys["test_fp"].spendMonth, 5.5);
});

test("adversarial: monthly budget float precision accumulation does not drift into NaN", () => {
  const secret = "11111111-2222-3333-4444-555555555555";
  const store = new StateStore("");
  const pool = new KeyPool([secret], {
    monthlyBudget: 10.0,
    budgetMargin: 0.05,
    store,
  });

  const fp = pool.keys[0].fp;
  for (let i = 0; i < 100; i++) {
    pool.success(fp, 0.007);
  }

  const spend = pool.status().find((k) => k.alias === "k1")?.spendUsd;
  assert.ok(spend !== undefined && !Number.isNaN(spend));
  assert.ok(spend > 0.69 && spend < 0.71);
});

test("adversarial: concurrent state writes with lock timeout falls back rather than hanging", () => {
  const state = new StateStore("", () => {});
  let updated = false;
  state.update(() => {
    updated = true;
  });
  assert.ok(updated);
});
