import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseKeys, type Strategy } from "./core/keypool.js";
import { isMode, MODE_NAMES, type ModeName } from "./modes.js";

export interface Config {
  keys: string[];
  /** Problems found while reading the config; logged to stderr at start. */
  warnings: string[];
  baseUrl: string;
  strategy: Strategy;
  monthlyBudget: number;
  budgetMargin: number;
  stateDir: string;
  timeoutMs: number;
  maxAttempts: number;
  qpsPerKey: number;
  maxChars: number;
  cacheTtlMs: number;
  cacheMax: number;
  mode: ModeName;
  agentMaxCost: number;
  agentWaitSeconds: number;
  enableAgent: boolean;
  enableMonitors: boolean;
}

const STRATEGIES: Strategy[] = ["round-robin", "priority", "least-used"];

/** Reads config from environment variables and argv (`--keys-file=PATH`, `--mode=max`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): Config {
  const warnings: string[] = [];
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const num = (name: string, d: number, min: number, max: number) => {
    const v = env[name];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      warnings.push(`${name}=${v} is invalid (expected ${min}-${max}); using ${d}.`);
      return d;
    }
    return n;
  };
  const bool = (name: string, d: boolean) => {
    const v = env[name];
    if (v === undefined || v === "") return d;
    return /^(1|true|yes|on)$/i.test(v);
  };

  const raw: string[] = [];
  if (env.EXA_API_KEYS) raw.push(env.EXA_API_KEYS);
  if (env.EXA_API_KEY) raw.push(env.EXA_API_KEY);
  for (const f of [env.EXA_API_KEYS_FILE, arg("keys-file")]) {
    if (!f) continue;
    try {
      raw.push(readFileSync(f, "utf8"));
    } catch (e) {
      warnings.push(`cannot read keys file ${f}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }

  const strategy = (env.EXA_KEY_STRATEGY || "round-robin") as Strategy;
  if (!STRATEGIES.includes(strategy)) warnings.push(`EXA_KEY_STRATEGY=${strategy} is unknown; using round-robin.`);
  const mode = arg("mode") ?? env.EXA_MODE ?? "max";
  if (!isMode(mode)) warnings.push(`mode ${mode} is unknown (use ${MODE_NAMES.join(", ")}); using max.`);

  return {
    keys: parseKeys(raw.join(",")),
    warnings,
    baseUrl: env.EXA_BASE_URL || "https://api.exa.ai",
    strategy: STRATEGIES.includes(strategy) ? strategy : "round-robin",
    monthlyBudget: num("EXA_MONTHLY_BUDGET_PER_KEY", 10, 0.01, 1e6),
    budgetMargin: num("EXA_BUDGET_MARGIN", 0.05, 0, 1e6),
    stateDir: env.EXA_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "exa-ultra-mcp"),
    timeoutMs: num("EXA_TIMEOUT_MS", 60_000, 1000, 600_000),
    maxAttempts: num("EXA_MAX_ATTEMPTS", 5, 1, 50),
    qpsPerKey: num("EXA_QPS_PER_KEY", 10, 0, 1000),
    maxChars: num("EXA_MAX_CHARS", 8_000, 500, 1_000_000),
    cacheTtlMs: num("EXA_CACHE_TTL_SECONDS", 600, 0, 86_400) * 1000,
    cacheMax: num("EXA_CACHE_MAX", 200, 0, 100_000),
    mode: isMode(mode) ? mode : "max",
    agentMaxCost: num("EXA_AGENT_MAX_COST", 1, 1, 100),
    agentWaitSeconds: num("EXA_AGENT_WAIT_SECONDS", 120, 5, 600),
    enableAgent: bool("EXA_ENABLE_AGENT", true),
    enableMonitors: bool("EXA_ENABLE_MONITORS", false),
  };
}
