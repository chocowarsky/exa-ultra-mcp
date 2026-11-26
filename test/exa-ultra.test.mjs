import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { expandHome, loadConfig } from "../dist/config.js";
import { ExaClient } from "../dist/core/client.js";
import { KeyPool, parseKeys } from "../dist/core/keypool.js";
import { StateStore } from "../dist/core/state.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "index.js");

test("parseKeys supports plain text, comments, JSON array, JSON object, dedupe, and filters placeholders", () => {
  const plain = `
    # comment line
    test-exa-token-alpha-0001, test-exa-token-beta-0002 # inline comment
    test-exa-token-alpha-0001; YOUR_EXA_KEY REPLACE_ME
  `;
  assert.deepEqual(parseKeys(plain), ["test-exa-token-alpha-0001", "test-exa-token-beta-0002"]);

  const jsonArr = JSON.stringify(["test-exa-token-gamma-0003", "PASTE_YOUR_KEY", "test-exa-token-gamma-0003"]);
  assert.deepEqual(parseKeys(jsonArr), ["test-exa-token-gamma-0003"]);

  const jsonObj = JSON.stringify({ keys: ["test-exa-token-delta-0004", "your-placeholder-key"] });
  assert.deepEqual(parseKeys(jsonObj), ["test-exa-token-delta-0004"]);
});

test("expandHome resolves leading tilde paths", () => {
  assert.equal(expandHome("~/.config/exa-ultra/keys", "/tmp/fakehome"), join("/tmp/fakehome", ".config/exa-ultra/keys"));
  assert.equal(expandHome("~", "/tmp/fakehome"), "/tmp/fakehome");
  assert.equal(expandHome("/abs/path/keys", "/tmp/fakehome"), "/abs/path/keys");
});

test("loadConfig supports space-separated args, tilde expansion, auto-discovery, and 0600 warning", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "exa-ultra-home-"));
  try {
    const cfgDir = join(fakeHome, ".config", "exa-ultra");
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    const defaultKeys = join(cfgDir, "keys");
    writeFileSync(defaultKeys, "test-exa-auto-key-1111\n", { mode: 0o600 });

    // 1. Auto-discovery when no explicit env or arg is passed
    const autoCfg = loadConfig({ HOME: fakeHome }, ["node", "dist/index.js"]);
    assert.deepEqual(autoCfg.keys, ["test-exa-auto-key-1111"]);
    assert.ok(autoCfg.keySources.some((s) => s.startsWith("auto:")));
    assert.equal(autoCfg.warnings.length, 0);

    // 2. Explicit space-separated --keys-file ~/... and --mode fast
    const customKeys = join(fakeHome, "custom.json");
    writeFileSync(customKeys, JSON.stringify({ keys: ["test-exa-custom-2222", "test-exa-custom-3333"] }), { mode: 0o644 });
    chmodSync(customKeys, 0o644);
    const argCfg = loadConfig({ HOME: fakeHome }, ["node", "dist/index.js", "--keys-file", "~/custom.json", "--mode", "fast"]);
    assert.deepEqual(argCfg.keys, ["test-exa-custom-2222", "test-exa-custom-3333"]);
    assert.equal(argCfg.mode, "fast");
    if (process.platform !== "win32") {
      assert.ok(argCfg.warnings.some((w) => w.includes("chmod 600")));
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("KeyPool enforces budget guard, failover cooldowns, and bookOnce idempotency", () => {
  const store = new StateStore(null);
  const pool = new KeyPool(["test-exa-pool-1111", "test-exa-pool-2222"], {
    strategy: "priority",
    monthlyBudget: 10,
    budgetMargin: 0.05,
    store,
  });

  const [first, second] = pool.keys;
  assert.equal(pool.candidates()[0].fp, first.fp);

  // Exhaust key 1 via auth failure -> key 2 becomes primary candidate
  pool.failure(first.fp, "auth", "401 unauthorized");
  assert.equal(pool.candidates()[0].fp, second.fp);

  // Reservation + bookOnce bills exactly once
  pool.reserve("run-1", second.fp, 1.0);
  assert.equal(pool.bookOnce("run-1", second.fp, 0.42), true);
  assert.equal(pool.bookOnce("run-1", second.fp, 0.42), false);
  const st = pool.status().find((k) => k.alias === second.alias);
  assert.equal(st?.spendUsd, 0.42);
  assert.equal(st?.reservedUsd, 0);
});

test("ExaClient redacts all configured keys from strings", () => {
  const store = new StateStore(null);
  const secret = "test-exa-supersecret-9999";
  const pool = new KeyPool([secret], { strategy: "priority", monthlyBudget: 10, budgetMargin: 0.05, store });
  const client = new ExaClient(pool, { baseUrl: "https://api.exa.ai", timeoutMs: 5000, maxAttempts: 1, qpsPerKey: 0 });
  const scrubbed = client.redact(`Error with header x-api-key=${secret}`);
  assert.equal(scrubbed.includes(secret), false);
  assert.ok(scrubbed.includes("[key]"));
});

test("CLI --doctor --json works 100% offline and never exposes raw keys", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "exa-ultra-cli-"));
  try {
    // Missing keys -> exit code 1, ready=false
    let missingOut = "";
    let missingCode = 0;
    try {
      execFileSync(process.execPath, [CLI_ENTRY, "--doctor", "--json"], {
        env: { PATH: process.env.PATH, HOME: fakeHome },
        encoding: "utf8",
      });
    } catch (err) {
      missingCode = err.status;
      missingOut = err.stdout;
    }
    assert.equal(missingCode, 1);
    const missingReport = JSON.parse(missingOut);
    assert.equal(missingReport.ready, false);
    assert.equal(missingReport.keyCount, 0);

    // Valid private key file -> exit code 0, ready=true, raw key never appears in output
    const secret = "test-exa-doctor-key-7788";
    const keyFile = join(fakeHome, "keys");
    writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });

    const okOut = execFileSync(process.execPath, [CLI_ENTRY, "--doctor", "--json", `--keys-file=${keyFile}`], {
      env: { PATH: process.env.PATH, HOME: fakeHome },
      encoding: "utf8",
    });
    assert.equal(okOut.includes(secret), false, "raw secret must never be printed by --doctor");
    const okReport = JSON.parse(okOut);
    assert.equal(okReport.ready, true);
    assert.equal(okReport.keyCount, 1);
    assert.equal(okReport.keys[0].key, "…7788");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
