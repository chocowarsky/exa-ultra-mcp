import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExaClient, ExaError, type CallResult } from "../core/client.js";
import { KeyPool } from "../core/keypool.js";
import { TtlCache } from "../core/cache.js";
import { StateStore } from "../core/state.js";
import type { Config } from "../config.js";
import { isMode, MODES, MODE_NAMES, type ModeName } from "../modes.js";

export type Out = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export interface Ctx {
  exa: ExaClient;
  pool: KeyPool;
  cache: TtlCache<CallResult>;
  store: StateStore;
  config: Config;
}

/** A tool module registers its tools on the server. Add a module to `tools/index.ts` to ship it. */
export type ToolModule = (server: McpServer, ctx: Ctx) => void;

/** The server-wide mode: the one saved with exa_mode (shared by every process), else EXA_MODE. */
export function serverMode(ctx: Ctx): ModeName {
  const saved = ctx.store.read().settings.mode;
  return isMode(saved) ? saved : ctx.config.mode;
}

export function modeFor(ctx: Ctx, mode?: ModeName) {
  const name = mode ?? serverMode(ctx);
  return { name, ...MODES[name] };
}

export const modeArg = z
  .enum(MODE_NAMES as [ModeName, ...ModeName[]])
  .optional()
  .describe("Quality preset for this call: fast (lite search, cheapest agent) · auto (Exa standard) · max (highest free-plan quality). Default: the server mode (see exa_mode). An explicit type/effort wins.");

export const jsonObj = z.record(z.string(), z.any());
export const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date or date-time");

export function ok(text: string, structured?: Record<string, unknown>): Out {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

export function fail(e: unknown): Out {
  const msg = e instanceof Error ? e.message : String(e);
  const hint =
    e instanceof ExaError && e.status === 400
      ? "\nExa rejected the request as invalid; fix the arguments (another key will not help)."
      : e instanceof ExaError && e.status === 403 && !e.retryable
        ? "\nThis feature is not included in the Exa plan of these keys."
        : "";
  return { content: [{ type: "text", text: `Error: ${msg}${hint}` }], isError: true };
}

export function invalid(msg: string): Out {
  return { content: [{ type: "text", text: `Invalid arguments: ${msg}` }], isError: true };
}

export function meta(r: CallResult, cached = false) {
  return {
    key: r.keyAlias,
    costDollars: r.data?.costDollars ?? null,
    requestId: r.data?.requestId ?? null,
    ms: cached ? 0 : r.ms,
    cached,
    attempts: r.attempts,
  };
}

/** Drops undefined values and empty objects so only fields the caller set reach Exa. */
export function prune<T>(v: T): T {
  if (Array.isArray(v)) return v.map(prune) as T;
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      const p = prune(val);
      if (p && typeof p === "object" && !Array.isArray(p) && !Object.keys(p).length) continue;
      out[k] = p;
    }
    return out;
  }
  return v;
}

/** Stable JSON (sorted keys) so equal requests share one cache entry. */
function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

const inflight = new Map<string, Promise<CallResult>>();

/** POST with a TTL cache; identical requests that run at the same time share one Exa call. */
export async function cachedPost(ctx: Ctx, path: string, body: any, opts: { noCache?: boolean; signal?: AbortSignal } = {}) {
  const key = `${path}:${stable(body)}`;
  if (!opts.noCache) {
    const hit = ctx.cache.get(key);
    if (hit) return { r: hit, hit: true };
    const running = inflight.get(key);
    if (running) return { r: await running, hit: true };
  }
  // A shared request must not die when only one of its callers cancels, so only unshared calls get the signal.
  const p = ctx.exa.request("POST", path, body, opts.noCache ? { signal: opts.signal } : {});
  if (!opts.noCache) inflight.set(key, p);
  try {
    const r = await p;
    ctx.cache.set(key, r);
    return { r, hit: false };
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

// ---------- shared schemas ----------
export const contentShape = {
  content: z
    .enum(["highlights", "text", "summary", "none"])
    .optional()
    .describe("Page content to return. Pick one. highlights = short query-relevant excerpts (fewest tokens)."),
  highlightsQuery: z.string().optional().describe("Steer which excerpts are picked (highlights mode)."),
  maxCharacters: z.number().int().min(100).max(100_000).optional().describe("Per-page cap for text or highlights. Only for a hard budget."),
  summaryQuery: z.string().optional().describe("What the per-page summary should focus on (summary mode; one LLM call per page)."),
  summarySchema: jsonObj.optional().describe("JSON Schema for a structured per-page summary (summary mode)."),
  maxAgeHours: z.number().int().min(-1).optional().describe("Cache freshness: 0 = always live crawl, -1 = cache only, N = accept cache up to N hours. Not a publish-date filter."),
  livecrawlTimeout: z.number().int().min(1000).max(90000).optional().describe("Live crawl timeout in ms."),
  snapshotAsOf: isoDate.optional().describe("Exa Snapshot: the page as it was at this ISO date-time. Paid plans only. Not with maxAgeHours/livecrawlTimeout/subpages."),
  subpages: z.number().int().min(1).max(20).optional().describe("Also crawl up to N linked subpages per result."),
  subpageTarget: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional().describe("Keywords that pick which subpages to crawl, e.g. 'pricing' or ['docs','api']."),
  links: z.number().int().min(1).max(100).optional().describe("Return up to N links found on each page."),
  imageLinks: z.number().int().min(1).max(100).optional().describe("Return up to N image URLs per page."),
};

export type ContentArgs = { [K in keyof typeof contentShape]?: z.infer<(typeof contentShape)[K]> };

export function buildContents(a: ContentArgs, defaultMode: "highlights" | "text") {
  const mode = a.content ?? defaultMode;
  const c: any = {};
  if (mode === "highlights") {
    c.highlights = a.highlightsQuery || a.maxCharacters ? { query: a.highlightsQuery, maxCharacters: a.maxCharacters } : true;
  } else if (mode === "text") {
    c.text = a.maxCharacters ? { maxCharacters: a.maxCharacters } : true;
  } else if (mode === "summary") {
    c.summary = a.summaryQuery || a.summarySchema ? { query: a.summaryQuery, schema: a.summarySchema } : true;
  }
  c.maxAgeHours = a.maxAgeHours;
  c.livecrawlTimeout = a.livecrawlTimeout;
  c.snapshotAsOf = a.snapshotAsOf;
  c.subpages = a.subpages;
  c.subpageTarget = a.subpageTarget;
  if (a.links || a.imageLinks) c.extras = { links: a.links, imageLinks: a.imageLinks };
  return prune(c);
}

export function snapshotConflict(a: ContentArgs): string | null {
  if (!a.snapshotAsOf) return null;
  const bad = (["maxAgeHours", "livecrawlTimeout", "subpages"] as const).filter((k) => a[k] !== undefined);
  return bad.length ? `snapshotAsOf cannot be combined with ${bad.join(", ")}.` : null;
}

export const outShape = (maxChars: number) => ({
  maxChars: z.number().int().min(500).max(100_000).optional().describe(`Cap on the text returned to you (default ${maxChars}).`),
  raw: z.boolean().optional().describe("Also return the full Exa JSON in structuredContent. Costs many tokens."),
  noCache: z.boolean().optional().describe("Skip the local cache."),
});

export const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};
