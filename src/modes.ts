/**
 * Modes are named bundles of defaults. A call's explicit `type` / `effort` always wins over its mode,
 * and a call's `mode` wins over the server mode (EXA_MODE or the exa_mode tool).
 */
export const SEARCH_TYPES = ["auto", "lite", "deep-lite", "deep", "deep-reasoning"] as const;
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "auto", "ultra"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export type Effort = (typeof EFFORTS)[number];

export interface ModeDefaults {
  /** exa_search and exa_find_similar */
  searchType: SearchType;
  /** exa_agent_run */
  agentEffort: Effort;
  summary: string;
}

export const MODES = {
  fast: {
    searchType: "lite",
    agentEffort: "minimal",
    summary: "Lowest latency and cost: lite search (<1 s, $0.004), agent effort minimal ($0.012).",
  },
  auto: {
    searchType: "auto",
    agentEffort: "low",
    summary: "Exa's standard defaults: auto search (~2 s, $0.007), agent effort low ($0.025).",
  },
  max: {
    searchType: "deep-reasoning",
    agentEffort: "ultra",
    summary: "Highest quality the free plan allows: deep-reasoning search (7-20 s, $0.015), agent effort ultra (capped by EXA_AGENT_MAX_COST, default $1/run).",
  },
} as const satisfies Record<string, ModeDefaults>;

export type ModeName = keyof typeof MODES;
export const MODE_NAMES = Object.keys(MODES) as ModeName[];

export const isMode = (v: unknown): v is ModeName => typeof v === "string" && v in MODES;

/** Flat per-run price of fixed agent efforts (USD). auto/ultra are metered and capped by budget. */
export const FIXED_EFFORT_PRICE: Partial<Record<Effort, number>> = { minimal: 0.012, low: 0.025, medium: 0.1, high: 0.5, xhigh: 1 };
export const isMetered = (e: Effort) => e === "auto" || e === "ultra";

export function modesHelp(): string {
  return MODE_NAMES.map((m) => `${m}: ${MODES[m].summary}`).join(" · ");
}
