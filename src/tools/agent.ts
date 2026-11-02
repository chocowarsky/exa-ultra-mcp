import { z } from "zod";
import { costOf, ExaError, type CallResult } from "../core/client.js";
import { formatRun } from "../core/format.js";
import { EFFORTS, FIXED_EFFORT_PRICE, isMetered, type Effort } from "../modes.js";
import { fail, invalid, jsonObj, modeArg, modeFor, ok, outShape, prune, type Ctx, type Out, type ToolModule } from "./shared.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RUN_ID = /^[A-Za-z0-9_-]{1,200}$/;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** A run lives in the team of the key that created it. Unknown owner: ask each key until one knows it. */
async function onOwner(ctx: Ctx, id: string, method: string, path: string, signal?: AbortSignal) {
  const pin = ctx.pool.owner(id);
  if (pin) return ctx.exa.request(method, path, undefined, { pin, cost: () => 0, signal });
  let last: unknown;
  for (const k of ctx.pool.keys) {
    try {
      const r = await ctx.exa.request(method, path, undefined, { pin: k.fp, cost: () => 0, signal });
      ctx.pool.setOwner(id, k.fp);
      return r;
    } catch (e) {
      last = e;
      if (!(e instanceof ExaError) || ![401, 403, 404].includes(e.status)) throw e;
    }
  }
  throw last ?? new Error(`Run ${id} not found on any key.`);
}

/** Books a finished run's cost once (across processes) and frees its budget reservation. */
function bookFinal(ctx: Ctx, run: any, fp: string) {
  if (run?.id && TERMINAL.has(run.status)) ctx.pool.bookOnce(run.id, fp, costOf(run));
}

async function waitRun(ctx: Ctx, id: string, seconds: number, signal?: AbortSignal) {
  const until = Date.now() + seconds * 1000;
  let r = await onOwner(ctx, id, "GET", `/agent/runs/${id}`, signal);
  let delay = 2000;
  while (!TERMINAL.has(r.data?.status) && Date.now() + delay < until && !signal?.aborted) {
    await sleep(delay, signal);
    delay = Math.min(8000, Math.round(delay * 1.5));
    r = await onOwner(ctx, id, "GET", `/agent/runs/${id}`, signal);
  }
  bookFinal(ctx, r.data, r.keyFp);
  return r;
}

function runOut(r: CallResult, maxChars: number, raw?: boolean): Out {
  const run = r.data ?? {};
  let text = formatRun(run, maxChars);
  if (!TERMINAL.has(run.status)) text += `\n\nStill running. Call exa_agent_get with id ${run.id} and wait=true to keep waiting.`;
  else if (run.status !== "completed") text += `\n\nThe run ended without results (${run.status}).`;
  text += `\n\n---\nkey ${r.keyAlias} · cost ${costOf(run) ? `$${costOf(run).toFixed(4)}` : "n/a"}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      id: run.id ?? null,
      status: run.status ?? null,
      stopReason: run.stopReason ?? null,
      output: run.output ?? null,
      costDollars: run.costDollars ?? null,
      key: r.keyAlias,
      ...(raw ? { raw: run } : {}),
    },
    ...(run.status === "failed" ? { isError: true } : {}),
  };
}

export const registerAgent: ToolModule = (server, ctx) => {
  const out = outShape(ctx.config.maxChars);
  const cap = ctx.config.agentMaxCost;
  const wait = ctx.config.agentWaitSeconds;

  server.registerTool(
    "exa_agent_run",
    {
      title: "Exa Agent research run",
      description:
        "Async multi-step Exa Agent run (deep research): list-building, enrichment of rows, multi-hop research, structured JSON with citations. Not for simple lookups (use exa_search or exa_answer). " +
        `Effort comes from the mode unless you set it: fast = minimal ($0.012) · auto = low ($0.025) · max = ultra (usage-based, capped at $${cap}/run). ` +
        `Waits up to waitSeconds (default ${wait}); if still running, returns the run id for exa_agent_get.`,
      inputSchema: {
        query: z.string().trim().min(1).max(10_000).describe("The research task in natural language."),
        mode: modeArg,
        effort: z.enum(EFFORTS).optional().describe("Overrides the mode. ultra = exhaustive · auto = sized to the task (both usage-based, capped by maxCostDollars) · fixed: minimal $0.012 · low $0.025 · medium $0.10 · high $0.50 · xhigh $1.00."),
        outputSchema: jsonObj.optional().describe("JSON Schema for output.structured. Bound arrays with maxItems."),
        inputData: z.array(jsonObj).max(1000).optional().describe("Existing rows to research or enrich."),
        exclude: z.array(jsonObj).max(1000).optional().describe("Entities the agent must not return again."),
        previousRunId: z.string().regex(RUN_ID).optional().describe("Continue from a completed run (follow-up question)."),
        maxCostDollars: z.number().min(1).max(100).optional().describe(`Spend ceiling for auto/ultra (default ${cap}). A free key has $10/month in total.`),
        maxDurationSeconds: z.number().int().min(300).max(10800).optional().describe("ultra only."),
        wait: z.boolean().optional().describe("Wait for the result (default true)."),
        waitSeconds: z.number().int().min(5).max(600).optional(),
        ...out,
      },
    },
    async (a, extra) => {
      const m = modeFor(ctx, a.mode);
      const effort: Effort = a.effort ?? m.agentEffort;
      const metered = isMetered(effort);
      if (!metered && a.maxCostDollars !== undefined) return invalid(`maxCostDollars only applies to effort auto or ultra (effort is ${effort}).`);
      if (effort !== "ultra" && a.maxDurationSeconds !== undefined) return invalid("maxDurationSeconds only applies to effort ultra.");
      const budget = metered ? (a.maxCostDollars ?? cap) : undefined;
      if (budget !== undefined && budget > ctx.pool.budget) return invalid(`maxCostDollars ${budget} is above the monthly budget of one key ($${ctx.pool.budget}).`);
      const body = prune({
        query: a.query,
        effort,
        outputSchema: a.outputSchema,
        input: a.inputData?.length || a.exclude?.length ? { data: a.inputData, exclusion: a.exclude } : undefined,
        previousRunId: a.previousRunId,
        budget: metered ? { maxCostDollars: budget, maxDurationSeconds: a.maxDurationSeconds } : undefined,
      });
      try {
        // A follow-up must run on the key that owns the previous run.
        const pin = a.previousRunId ? ctx.pool.owner(a.previousRunId) : undefined;
        // Worst-case cost of the run; only keys with that much budget left are used, and it stays reserved until the run is billed.
        const need = budget ?? FIXED_EFFORT_PRICE[effort] ?? 0;
        const created = await ctx.exa.request("POST", "/agent/runs", body, { pin, cost: () => 0, need: pin ? undefined : need, signal: extra.signal });
        const id = created.data?.id;
        if (typeof id !== "string" || !RUN_ID.test(id)) return fail(new Error(`Exa returned no run id: ${JSON.stringify(created.data).slice(0, 300)}`));
        ctx.pool.setOwner(id, created.keyFp);
        ctx.pool.reserve(id, created.keyFp, need);
        if (a.wait === false) return runOut(created, a.maxChars ?? ctx.config.maxChars, a.raw);
        const r = await waitRun(ctx, id, a.waitSeconds ?? wait, extra.signal);
        return runOut(r, a.maxChars ?? ctx.config.maxChars, a.raw);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "exa_agent_get",
    {
      title: "Exa Agent run status/result",
      description: "Get an Exa Agent run by id; with wait=true, keep polling until it finishes or waitSeconds pass.",
      inputSchema: {
        id: z.string().regex(RUN_ID),
        wait: z.boolean().optional(),
        waitSeconds: z.number().int().min(5).max(600).optional(),
        ...out,
      },
    },
    async (a, extra) => {
      try {
        const r = a.wait ? await waitRun(ctx, a.id, a.waitSeconds ?? wait, extra.signal) : await onOwner(ctx, a.id, "GET", `/agent/runs/${a.id}`, extra.signal);
        bookFinal(ctx, r.data, r.keyFp);
        return runOut(r, a.maxChars ?? ctx.config.maxChars, a.raw);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "exa_agent_manage",
    {
      title: "Exa Agent runs: list, events, cancel, delete",
      description: "list = recent runs on every key · events = lifecycle events of a run · cancel = stop a running run · delete = remove a run.",
      inputSchema: {
        action: z.enum(["list", "events", "cancel", "delete"]),
        id: z.string().regex(RUN_ID).optional().describe("Run id (events, cancel, delete)."),
        cursor: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (a, extra) => {
      try {
        if (a.action === "list") {
          // All keys in parallel; one failing key does not hide the others.
          const per = await Promise.all(
            ctx.pool.keys.map(async (k) => {
              try {
                const r = await ctx.exa.request("GET", "/agent/runs", undefined, { pin: k.fp, query: { limit: a.limit ?? 10, cursor: a.cursor }, cost: () => 0, signal: extra.signal });
                const runs: any[] = r.data?.data ?? r.data?.runs ?? r.data?.results ?? [];
                for (const run of runs) if (run?.id) ctx.pool.setOwner(run.id, k.fp);
                return runs.map((run) => `- ${run.id} · ${run.status} · ${run.effort ?? ""} · ${String(run.createdAt ?? "").slice(0, 19)} · ${String(run.query ?? "").slice(0, 80)} (${k.alias})`);
              } catch (e) {
                return [`- ${k.alias}: ${(e as Error).message}`];
              }
            }),
          );
          return ok(`## Agent runs\n${per.flat().join("\n") || "none"}`);
        }
        if (!a.id) return invalid(`id is required for ${a.action}.`);
        if (a.action === "events") {
          const r = await onOwner(ctx, a.id, "GET", `/agent/runs/${a.id}/events`, extra.signal);
          const ev: any[] = r.data?.data ?? r.data?.events ?? [];
          const text = ev.length
            ? ev.map((e) => `- ${e.createdAt ?? ""} ${e.type ?? e.event ?? ""} ${JSON.stringify(e.data ?? e.payload ?? "").slice(0, 200)}`).join("\n")
            : JSON.stringify(r.data).slice(0, 4000);
          return ok(`## Events of ${a.id}\n${text}`);
        }
        if (a.action === "cancel") {
          const r = await onOwner(ctx, a.id, "POST", `/agent/runs/${a.id}/cancel`, extra.signal);
          bookFinal(ctx, r.data, r.keyFp);
          return ok(`Cancel requested for ${a.id}: status ${r.data?.status ?? "unknown"}.`);
        }
        await onOwner(ctx, a.id, "DELETE", `/agent/runs/${a.id}`, extra.signal);
        ctx.pool.release(a.id);
        return ok(`Deleted run ${a.id}.`);
      } catch (e) {
        return fail(e);
      }
    },
  );
};
