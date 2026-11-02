import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CallResult } from "../core/client.js";
import { fail, invalid, jsonObj, ok, prune, type ToolModule } from "./shared.js";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Exa Monitors: scheduled searches sent to a webhook. Off by default (EXA_ENABLE_MONITORS=1). */
export const registerMonitors: ToolModule = (server, ctx) => {
  server.registerTool(
    "exa_monitor",
    {
      title: "Exa Monitors",
      description:
        "Scheduled recurring Exa searches delivered to a webhook ($15/1k runs). Actions: create, list, get, update, delete, trigger, runs, run. " +
        "The one-time webhookSecret from create is saved to a private file, never shown.",
      inputSchema: {
        action: z.enum(["create", "list", "get", "update", "delete", "trigger", "runs", "run"]),
        id: z.string().regex(ID).optional(),
        runId: z.string().regex(ID).optional(),
        name: z.string().max(200).optional(),
        search: jsonObj.optional().describe("Search payload: { query, numResults?, contents? }."),
        period: z.string().max(20).optional().describe("Interval like 1h, 1d, 7d. Use 'none' on update to remove the schedule."),
        webhookUrl: z.url().optional(),
        outputSchema: jsonObj.optional(),
        status: z.enum(["active", "paused"]).optional(),
      },
    },
    async (a, extra) => {
      const signal = extra.signal;
      try {
        switch (a.action) {
          case "create": {
            if (!a.search || typeof a.search.query !== "string") return invalid("search with a query is required for create.");
            if (!a.webhookUrl) return invalid("webhookUrl is required for create.");
            const body = prune({
              name: a.name,
              search: a.search,
              trigger: a.period && a.period !== "none" ? { type: "interval", period: a.period } : undefined,
              outputSchema: a.outputSchema,
              webhook: { url: a.webhookUrl },
            });
            const r = await ctx.exa.request("POST", "/monitors", body, { signal });
            const m = { ...r.data };
            if (!m.id) return fail(new Error("Exa returned no monitor id."));
            ctx.pool.setOwner(m.id, r.keyFp);
            let note = "";
            if (m.webhookSecret) {
              const dir = join(ctx.config.stateDir, "monitor-secrets");
              mkdirSync(dir, { recursive: true, mode: 0o700 });
              const file = join(dir, `${String(m.id).replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
              writeFileSync(file, m.webhookSecret, { mode: 0o600 });
              note = `\nWebhook secret saved to ${file} (Exa shows it once).`;
              delete m.webhookSecret;
            }
            return ok(`Created monitor ${m.id} (${m.status ?? "active"}) on key ${r.keyAlias}.${note}`, { id: m.id, key: r.keyAlias });
          }
          case "list": {
            const per = await Promise.all(
              ctx.pool.keys.map(async (k) => {
                try {
                  const r = await ctx.exa.request("GET", "/monitors", undefined, { pin: k.fp, signal });
                  return (r.data?.data ?? []).map((m: any) => {
                    if (m?.id) ctx.pool.setOwner(m.id, k.fp);
                    return `- ${m.id} · ${m.status} · ${m.name ?? ""} · ${m.trigger?.period ?? "manual"} (${k.alias})`;
                  });
                } catch (e) {
                  return [`- ${k.alias}: ${(e as Error).message}`];
                }
              }),
            );
            return ok(`## Monitors\n${per.flat().join("\n") || "none"}`);
          }
          default: {
            if (!a.id) return invalid(`id is required for ${a.action}.`);
            const pin = ctx.pool.owner(a.id);
            const base = `/monitors/${a.id}`;
            const req = (m: string, p: string, b?: unknown) => ctx.exa.request(m, p, b, { pin, signal });
            let r: CallResult;
            if (a.action === "get") r = await req("GET", base);
            else if (a.action === "delete") r = await req("DELETE", base);
            else if (a.action === "trigger") r = await req("POST", `${base}/trigger`);
            else if (a.action === "runs") r = await req("GET", `${base}/runs`);
            else if (a.action === "run") {
              if (!a.runId) return invalid("runId is required for run.");
              r = await req("GET", `${base}/runs/${a.runId}`);
            } else {
              r = await req(
                "PATCH",
                base,
                prune({
                  name: a.name,
                  search: a.search,
                  status: a.status,
                  outputSchema: a.outputSchema,
                  webhook: a.webhookUrl ? { url: a.webhookUrl } : undefined,
                  trigger: a.period === "none" ? null : a.period ? { type: "interval", period: a.period } : undefined,
                }),
              );
            }
            const d = typeof r.data === "object" && r.data ? { ...r.data } : { result: r.data };
            delete d.webhookSecret;
            return ok(`\`\`\`json\n${JSON.stringify(d, null, 2).slice(0, 8000)}\n\`\`\``);
          }
        }
      } catch (e) {
        return fail(e);
      }
    },
  );
};
