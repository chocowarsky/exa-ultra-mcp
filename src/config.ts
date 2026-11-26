import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseKeys, type Strategy } from "./core/keypool.js";
import { isMode, MODE_NAMES, type ModeName } from "./modes.js";

export interface Config {
  keys: string[];
  /** Source labels/paths where keys were loaded from (never raw secrets). */
  keySources: string[];
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

/** Expands a leading `~` or `~/` to the user's home directory. */
export function expandHome(filePath: string, home: string = homedir()): string {
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

/** Default private key file locations checked automatically when no explicit key source is configured. */
export function defaultKeyFileCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const configBase = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : join(home, ".config");
  const dir = join(configBase, "exa-ultra");
  return [join(dir, "keys"), join(dir, "keys.txt"), join(dir, "keys.json")];
}

function readArg(argv: string[], name: string): string | undefined {
  const eqPrefix = `--${name}=`;
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith(eqPrefix)) return a.slice(eqPrefix.length);
    const next = argv[i + 1];
    if (a === flag && next !== undefined && !next.startsWith("--")) {
      return next;
    }
  }
  return undefined;
}

/** Reads config from environment variables, argv (`--keys-file=PATH`, `--keys-file PATH`, `--mode=max`), and default private key files. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): Config {
  const warnings: string[] = [];
  const keySources: string[] = [];
  const keysAcc: string[] = [];
  const home = env.HOME || env.USERPROFILE || homedir();

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

  const addKeysFromFile = (rawPath: string, labelPrefix: string) => {
    const resolved = expandHome(rawPath.trim(), home);
    try {
      if (process.platform !== "win32") {
        const st = statSync(resolved);
        if ((st.mode & 0o077) !== 0) {
          warnings.push(`keys file ${resolved} is accessible by group/others; run: chmod 600 "${resolved}"`);
        }
      }
      const parsed = parseKeys(readFileSync(resolved, "utf8"));
      if (parsed.length) {
        keysAcc.push(...parsed);
        keySources.push(`${labelPrefix}:${resolved}`);
      } else {
        warnings.push(`keys file ${resolved} contained no usable keys (blank or placeholder only).`);
      }
    } catch (e) {
      warnings.push(`cannot read keys file ${resolved}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  };

  if (env.EXA_API_KEYS) {
    const parsed = parseKeys(env.EXA_API_KEYS);
    if (parsed.length) {
      keysAcc.push(...parsed);
      keySources.push("env:EXA_API_KEYS");
    }
  }
  if (env.EXA_API_KEY) {
    const parsed = parseKeys(env.EXA_API_KEY);
    if (parsed.length) {
      keysAcc.push(...parsed);
      keySources.push("env:EXA_API_KEY");
    }
  }

  const explicitFiles = [
    env.EXA_API_KEYS_FILE ? { path: env.EXA_API_KEYS_FILE, label: "env:EXA_API_KEYS_FILE" } : null,
    readArg(argv, "keys-file") ? { path: readArg(argv, "keys-file")!, label: "arg:--keys-file" } : null,
  ].filter((x): x is { path: string; label: string } => Boolean(x));

  const seenPaths = new Set<string>();
  for (const item of explicitFiles) {
    const expanded = expandHome(item.path.trim(), home);
    if (seenPaths.has(expanded)) continue;
    seenPaths.add(expanded);
    addKeysFromFile(item.path, item.label);
  }

  // Auto-discover default private key files when no explicit source was supplied
  if (!keysAcc.length && !explicitFiles.length) {
    for (const candidate of defaultKeyFileCandidates(env, home)) {
      if (existsSync(candidate)) {
        addKeysFromFile(candidate, "auto");
        break;
      }
    }
  }

  const strategy = (env.EXA_KEY_STRATEGY || "round-robin") as Strategy;
  if (!STRATEGIES.includes(strategy)) warnings.push(`EXA_KEY_STRATEGY=${strategy} is unknown; using round-robin.`);
  const mode = readArg(argv, "mode") ?? env.EXA_MODE ?? "max";
  if (!isMode(mode)) warnings.push(`mode ${mode} is unknown (use ${MODE_NAMES.join(", ")}); using max.`);

  const stateBase = env.XDG_STATE_HOME ? expandHome(env.XDG_STATE_HOME, home) : join(home, ".local", "state");

  return {
    keys: [...new Set(keysAcc)],
    keySources,
    warnings,
    baseUrl: env.EXA_BASE_URL || "https://api.exa.ai",
    strategy: STRATEGIES.includes(strategy) ? strategy : "round-robin",
    monthlyBudget: num("EXA_MONTHLY_BUDGET_PER_KEY", 10, 0.01, 1e6),
    budgetMargin: num("EXA_BUDGET_MARGIN", 0.05, 0, 1e6),
    stateDir: env.EXA_STATE_DIR ? expandHome(env.EXA_STATE_DIR, home) : join(stateBase, "exa-ultra-mcp"),
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
