#!/usr/bin/env node
// Fails when a tracked file (or, with --history, any commit) holds something that looks like a secret.
// Exa keys are UUIDs, so any UUID in the repo is treated as a possible key.
// With EXA_API_KEYS_FILE set, the real keys are also searched for literally (they are never printed).
// Usage: node scripts/check-secrets.mjs [--history]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GIT_CANDIDATES =
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

const GIT_BIN = GIT_CANDIDATES.find((p) => existsSync(p));
if (!GIT_BIN) {
  console.error("check-secrets: unable to locate git binary in trusted system paths.");
  process.exit(2);
}

const git = (...a) =>
  execFileSync(GIT_BIN, a, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "C:\\Windows" } : { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });

const PATTERNS = [
  ["UUID (Exa key format)", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["OpenAI/Anthropic-style key", /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ["Assigned key value", /\b(EXA_API_KEYS?|API_KEY|TOKEN|SECRET)\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/],
];

const real = [];
if (process.env.EXA_API_KEYS_FILE) {
  const rawPath = process.env.EXA_API_KEYS_FILE.trim();
  const expanded = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
  try {
    real.push(...readFileSync(expanded, "utf8").split(/[\s,;]+/).filter((k) => k.length >= 8));
  } catch {
    /* no file: pattern scan only */
  }
}

const history = process.argv.includes("--history");
const revs = history ? git("rev-list", "--all").trim().split("\n").filter(Boolean) : [null];
const findings = [];
for (const rev of revs) {
  const files = (rev ? git("ls-tree", "-r", "--name-only", rev) : git("ls-files")).trim().split("\n").filter(Boolean);
  for (const f of files) {
    if (f === "package-lock.json") continue; // integrity hashes, no secrets
    let text;
    try {
      text = rev ? git("show", `${rev}:${f}`) : readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const [name, re] of PATTERNS) if (re.test(text)) findings.push(`${rev ? rev.slice(0, 7) + ":" : ""}${f}: ${name}`);
    if (real.some((k) => text.includes(k))) findings.push(`${rev ? rev.slice(0, 7) + ":" : ""}${f}: a REAL key from EXA_API_KEYS_FILE`);
  }
}

const uniq = [...new Set(findings)];
if (uniq.length) {
  console.error(`Possible secrets found:\n${uniq.map((x) => `- ${x}`).join("\n")}`);
  process.exit(1);
}
console.log(`No secrets found in ${history ? `${revs.length} commits` : "tracked files"}${real.length ? ` (also checked ${real.length} real keys)` : ""}.`);
