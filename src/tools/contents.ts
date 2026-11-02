import { z } from "zod";
import { footer, formatAnswer, formatResults } from "../core/format.js";
import { buildContents, cachedPost, contentShape, fail, invalid, jsonObj, meta, ok, outShape, prune, snapshotConflict, type ToolModule } from "./shared.js";

/** exa_contents (known URLs) and exa_answer (cited answer). */
export const registerContents: ToolModule = (server, ctx) => {
  const out = outShape(ctx.config.maxChars);

  server.registerTool(
    "exa_contents",
    {
      title: "Exa get page contents",
      description:
        "Get clean content of known URLs (no search). Default returns page text. Supports live crawl (maxAgeHours 0), subpage crawling, link/image extraction, and Exa Snapshot (paid plans). Failed URLs are listed; the call fails only when every URL failed.",
      inputSchema: {
        urls: z.array(z.url()).min(1).max(100),
        ...contentShape,
        ...out,
      },
    },
    async (a, extra) => {
      const sc = snapshotConflict(a);
      if (sc) return invalid(sc);
      const urls = [...new Set(a.urls)];
      const body = prune({ urls, ...buildContents(a, "text") });
      try {
        const { r, hit } = await cachedPost(ctx, "/contents", body, { noCache: a.noCache, signal: extra.signal });
        const max = a.maxChars ?? ctx.config.maxChars;
        const statuses: any[] = r.data?.statuses ?? [];
        const results: any[] = r.data?.results ?? [];
        const allFailed = !results.length && statuses.length > 0 && statuses.every((s) => s.status !== "success");
        const text = formatResults(r.data, max, `Exa contents (${urls.length} URL${urls.length > 1 ? "s" : ""})`) + footer(r, r.data, hit);
        return {
          ...ok(text, { ...meta(r, hit), statuses, ...(a.raw ? { raw: r.data } : {}) }),
          ...(allFailed ? { isError: true } : {}),
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "exa_answer",
    {
      title: "Exa grounded answer",
      description:
        "Ask a question; Exa searches and writes a short cited answer itself ($0.005). Good for quick facts. For research where you read the sources yourself, use exa_search.",
      inputSchema: {
        query: z.string().trim().min(1).max(2000),
        systemPrompt: z.string().max(8000).optional(),
        outputSchema: jsonObj.optional().describe("JSON Schema for a structured answer."),
        text: z.boolean().optional().describe("Include full source text in citations (large)."),
        userLocation: z.string().length(2).optional(),
        ...out,
      },
    },
    async (a, extra) => {
      const body = prune({ query: a.query, systemPrompt: a.systemPrompt, outputSchema: a.outputSchema, text: a.text, userLocation: a.userLocation?.toUpperCase() });
      try {
        const { r, hit } = await cachedPost(ctx, "/answer", body, { noCache: a.noCache, signal: extra.signal });
        const text = formatAnswer(r.data, a.maxChars ?? ctx.config.maxChars) + footer(r, r.data, hit);
        return ok(text, {
          ...meta(r, hit),
          answer: r.data?.answer ?? null,
          citations: (r.data?.citations ?? []).map((c: any) => ({ title: c.title ?? null, url: c.url })),
          ...(a.raw ? { raw: r.data } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
};
