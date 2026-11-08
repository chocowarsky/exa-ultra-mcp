import { z } from "zod";
import { costOf } from "../core/client.js";
import { footer, formatResults } from "../core/format.js";
import { SEARCH_TYPES, type ModeName, type SearchType } from "../modes.js";
import {
  buildContents,
  cachedPost,
  contentShape,
  domainOf,
  fail,
  invalid,
  isoDate,
  jsonObj,
  meta,
  modeArg,
  modeFor,
  ok,
  outShape,
  prune,
  snapshotConflict,
  type ContentArgs,
  type Ctx,
  type ToolModule,
} from "./shared.js";

const CATEGORIES = ["company", "people", "publication", "news", "personal site", "financial report"] as const;
const LITE_UNSUPPORTED = ["systemPrompt", "outputSchema", "maxAgeHours", "livecrawlTimeout", "subpages", "subpageTarget", "links", "imageLinks"] as const;

type SearchArgs = ContentArgs & {
  type?: SearchType;
  mode?: ModeName;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  snapshotAsOf?: string;
};

/**
 * Picks the search type. An explicit `type` is used as given (and validated). A type that comes
 * from a mode is adjusted when the call needs features it lacks, so a preset never breaks a call:
 * lite + schema/freshness options -> auto, deep* + Snapshot -> auto.
 */
export function resolveSearchType(ctx: Ctx, a: SearchArgs): { type: SearchType; note?: string } {
  if (a.type) return { type: a.type };
  const m = modeFor(ctx, a.mode);
  let type: SearchType = m.searchType;
  if (type === "lite" && (LITE_UNSUPPORTED.some((k) => (a as any)[k] !== undefined) || a.content === "summary"))
    return { type: "auto", note: `mode ${m.name} uses lite, which lacks the options you set; used auto` };
  if (a.snapshotAsOf && type.startsWith("deep")) return { type: "auto", note: `Snapshot needs auto or lite; used auto instead of ${type}` };
  return { type };
}

export function validateSearch(type: SearchType, a: any): string[] {
  const errs: string[] = [];
  if (type === "lite") {
    const bad: string[] = LITE_UNSUPPORTED.filter((k) => a[k] !== undefined);
    if (a.content === "summary") bad.push("content=summary");
    if (bad.length) errs.push(`type lite does not support ${bad.join(", ")}; use type auto.`);
  }
  if (a.snapshotAsOf && (type === "deep" || type === "deep-reasoning")) errs.push("snapshotAsOf works with type auto or lite only.");
  const sc = snapshotConflict(a);
  if (sc) errs.push(sc);
  if (a.category === "people") {
    const bad = (["excludeDomains", "includeText", "excludeText", "startPublishedDate", "endPublishedDate"] as const).filter((k) => a[k] !== undefined);
    if (bad.length) errs.push(`category people does not support ${bad.join(", ")}; put that logic in the query.`);
  }
  if (a.category === "company") {
    const bad = (["startPublishedDate", "endPublishedDate"] as const).filter((k) => a[k] !== undefined);
    if (bad.length) errs.push(`category company does not support ${bad.join(", ")}.`);
  }
  if (a.startPublishedDate && a.endPublishedDate && Date.parse(a.startPublishedDate) > Date.parse(a.endPublishedDate))
    errs.push("startPublishedDate is after endPublishedDate.");
  for (const f of ["includeText", "excludeText"] as const) {
    const v: string[] | undefined = a[f];
    if (v && (v.length > 1 || v.some((p) => !p.trim() || p.trim().split(/\s+/).length > 5))) errs.push(`${f} takes one phrase of up to 5 words.`);
  }
  return errs;
}

export const registerSearch: ToolModule = (server, ctx) => {
  const out = outShape(ctx.config.maxChars);

  server.registerTool(
    "exa_search",
    {
      title: "Exa web search",
      description:
        "Search the live web with Exa; returns ranked pages with query-relevant highlights (10 results). " +
        "Search type comes from the mode unless you set `type`: fast = lite (<1 s) · auto = auto (~2 s) · max = deep-reasoning (7-20 s, best quality). See exa_mode for the current server mode. " +
        "Put recency and source preferences in the query text; use filters only when they must be enforced. " +
        "Use outputSchema (+ systemPrompt for keep/drop rules) to get fields extracted from the pages.",
      inputSchema: {
        query: z.string().trim().min(1).max(2000).describe("What to retrieve, phrased like a search box entry."),
        objective: z.string().max(4096).optional().describe("The larger goal this search serves: what should rank first, what to exclude, which facts to pull."),
        mode: modeArg,
        type: z.enum(SEARCH_TYPES).optional().describe("Overrides the mode. deep-reasoning = strongest · deep = several searches, wide schemas · deep-lite · auto · lite = fastest, cached only."),
        numResults: z.number().int().min(1).max(100).optional().describe("Default 10. Results above 10 cost $0.001 each."),
        category: z.enum(CATEGORIES).optional().describe("Only when results must come from that index. Not for list-building (use exa_agent_run)."),
        includeDomains: z.array(z.string().min(1)).max(1200).optional().describe("Hard allowlist, e.g. ['openai.com/blog','*.substack.com']."),
        excludeDomains: z.array(z.string().min(1)).max(1200).optional().describe("Hard blocklist."),
        includeText: z.array(z.string().min(1)).optional().describe("Pages must contain this phrase (1 phrase, up to 5 words)."),
        excludeText: z.array(z.string().min(1)).optional().describe("Pages must not contain this phrase (1 phrase, up to 5 words)."),
        startPublishedDate: isoDate.optional().describe("Hard filter; drops undated pages. Only for a stated date window."),
        endPublishedDate: isoDate.optional(),
        userLocation: z.string().regex(/^[A-Za-z]{2}$/, "must be a 2-letter country code (e.g. US, ID)").optional().describe("Two-letter ISO country code, e.g. ID."),
        systemPrompt: z.string().max(8000).optional().describe("Rules for synthesized output: keep/drop, source preference, what to do with unverifiable fields."),
        outputSchema: jsonObj.optional().describe("JSON Schema for synthesized output in output.content. Keep it small."),
        ...contentShape,
        ...out,
      },
    },
    async (a, extra) => {
      const { type, note } = resolveSearchType(ctx, a);
      const errs = validateSearch(type, a);
      if (errs.length) return invalid(errs.join(" "));
      const body = prune({
        query: a.query,
        type,
        objective: a.objective,
        numResults: a.numResults,
        category: a.category,
        includeDomains: a.includeDomains,
        excludeDomains: a.excludeDomains,
        includeText: a.includeText,
        excludeText: a.excludeText,
        startPublishedDate: a.startPublishedDate,
        endPublishedDate: a.endPublishedDate,
        userLocation: a.userLocation?.toUpperCase(),
        systemPrompt: a.systemPrompt,
        outputSchema: a.outputSchema,
        contents: a.content === "none" && !a.subpages && !a.links && !a.imageLinks ? undefined : buildContents(a, "highlights"),
      });
      try {
        const { r, hit } = await cachedPost(ctx, "/search", body, { noCache: a.noCache, signal: extra.signal });
        const max = a.maxChars ?? ctx.config.maxChars;
        const text = formatResults(r.data, max, `Exa search: "${a.query}" (${type})`) + footer(r, r.data, hit) + (note ? `\nnote: ${note}` : "");
        return ok(text, {
          ...meta(r, hit),
          searchType: type,
          ...(note ? { note } : {}),
          output: r.data?.output ?? null,
          results: (r.data?.results ?? []).map((x: any) => ({ title: x?.title ?? null, url: x?.url, publishedDate: x?.publishedDate ?? null, author: x?.author ?? null })),
          ...(a.raw ? { raw: r.data } : {}),
        });
      } catch (e) {
        return fail(e, ctx);
      }
    },
  );

  server.registerTool(
    "exa_find_similar",
    {
      title: "Exa find similar pages",
      description:
        "Find pages similar to a seed URL (competitors, alternatives, related papers). Reads the seed page, then runs a semantic search built from it. Replaces Exa's deprecated /findSimilar. Search type follows the mode like exa_search.",
      inputSchema: {
        url: z.url(),
        focus: z.string().max(500).optional().describe("What 'similar' means here, e.g. 'competing products' or 'papers on the same method'."),
        mode: modeArg,
        type: z.enum(SEARCH_TYPES).optional(),
        numResults: z.number().int().min(1).max(100).optional(),
        excludeSourceDomain: z.boolean().optional().describe("Drop results from the seed's own domain (default true)."),
        content: z.enum(["highlights", "text", "summary", "none"]).optional(),
        ...out,
      },
    },
    async (a, extra) => {
      const { type, note } = resolveSearchType(ctx, { type: a.type, mode: a.mode, content: a.content });
      try {
        // A seed that cannot be read still works: the search falls back to the URL itself.
        let title = "";
        let snippet = "";
        let seedCost = 0;
        try {
          const seed = await cachedPost(ctx, "/contents", { urls: [a.url], text: { maxCharacters: 1500 } }, { signal: extra.signal });
          const page = seed.r.data?.results?.[0];
          title = page?.title ?? "";
          snippet = String(page?.text ?? "").replace(/\s+/g, " ").slice(0, 600);
          seedCost = seed.hit ? 0 : costOf(seed.r.data);
        } catch (e) {
          if (extra.signal.aborted) throw e;
        }
        const query = title ? `${title}${a.focus ? ` — ${a.focus}` : ""}` : `${a.focus ?? "pages like"} ${a.url}`;
        const objective =
          `Find pages similar to ${a.url}${a.focus ? ` in this sense: ${a.focus}` : ""}. ` +
          (snippet ? `The seed page is about: ${snippet}` : "") +
          (a.excludeSourceDomain === false ? "" : " Rank other sites first; skip the seed page itself.");
        const dom = domainOf(a.url);
        const body = prune({
          query: query.slice(0, 2000),
          type,
          objective: objective.slice(0, 4096),
          numResults: a.numResults,
          excludeDomains: a.excludeSourceDomain === false || !dom ? undefined : [dom],
          contents: a.content === "none" ? undefined : buildContents({ content: a.content }, "highlights"),
        });
        const { r, hit } = await cachedPost(ctx, "/search", body, { noCache: a.noCache, signal: extra.signal });
        const text =
          `Seed: ${title || a.url}${title ? "" : " (seed page could not be read)"}\n\n` +
          formatResults(r.data, a.maxChars ?? ctx.config.maxChars, `Similar to ${a.url} (${type})`) +
          footer(r, r.data, hit) +
          ` · seed read $${seedCost.toFixed(4)}` +
          (note ? `\nnote: ${note}` : "");
        return ok(text, {
          ...meta(r, hit),
          searchType: type,
          seed: { url: a.url, title: title || null },
          results: (r.data?.results ?? []).map((x: any) => ({ title: x?.title ?? null, url: x?.url })),
          ...(a.raw ? { raw: r.data } : {}),
        });
      } catch (e) {
        return fail(e, ctx);
      }
    },
  );
};
