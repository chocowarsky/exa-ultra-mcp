const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function costLine(data: any): string {
  const c = data?.costDollars;
  const total = typeof c === "number" ? c : c?.total;
  return typeof total === "number" && Number.isFinite(total) ? `$${total.toFixed(4)}` : "n/a";
}

function resultBlock(r: any, i: number, perResult: number): string {
  if (!r || typeof r !== "object") return "";
  const head = [`### [${i + 1}] ${oneLine(r.title || r.url || "Untitled")}`, r.url];
  const meta = [r.publishedDate && `published ${String(r.publishedDate).slice(0, 10)}`, r.author && `by ${oneLine(r.author)}`]
    .filter(Boolean)
    .join(" · ");
  if (meta) head.push(meta);
  const body: string[] = [];
  if (Array.isArray(r.highlights) && r.highlights.length) {
    for (const h of r.highlights) if (h !== null && h !== undefined) body.push(`> ${oneLine(String(h))}`);
  }
  if (r.summary) body.push(`Summary: ${oneLine(String(r.summary))}`);
  if (r.text) body.push(String(r.text).trim());
  let text = body.join("\n");
  if (text.length > perResult) text = clip(text, perResult);
  const extra: string[] = [];
  if (Array.isArray(r.subpages) && r.subpages.length) {
    extra.push(
      `Subpages:\n${r.subpages
        .filter((s: any) => s && typeof s === "object")
        .map((s: any) => `- ${oneLine(s.title || s.url || "Untitled")} — ${s.url ?? ""}${s.highlights?.length ? `\n  > ${clip(oneLine(s.highlights.join(" … ")), 300)}` : s.text ? `\n  > ${clip(oneLine(s.text), 300)}` : ""}`)
        .join("\n")}`,
    );
  }
  if (Array.isArray(r.extras?.links) && r.extras.links.length) extra.push(`Links: ${r.extras.links.slice(0, 20).join(" ")}`);
  if (Array.isArray(r.extras?.imageLinks) && r.extras.imageLinks.length) extra.push(`Images: ${r.extras.imageLinks.slice(0, 10).join(" ")}`);
  return [head.join("\n"), text, ...extra].filter(Boolean).join("\n");
}

export function formatResults(data: any, maxChars: number, title: string): string {
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  const parts: string[] = [`## ${title}`];
  const out = data?.output;
  if (out?.content !== undefined) {
    const c = typeof out.content === "string" ? out.content : JSON.stringify(out.content, null, 2);
    parts.push(`### Output\n${c}`);
    if (Array.isArray(out.grounding) && out.grounding.length) {
      parts.push(
        `### Grounding\n${out.grounding
          .filter((g: any) => g && typeof g === "object")
          .map((g: any) => `- ${g.field ?? "content"}: ${(Array.isArray(g.citations) ? g.citations : []).map((c: any) => c?.url ?? "").filter(Boolean).join(" ")}`)
          .join("\n")}`,
      );
    }
  }
  const budget = Math.max(400, maxChars - parts.join("\n\n").length);
  const perResult = results.length ? Math.max(300, Math.floor(budget / results.length) - 150) : 0;
  results.forEach((r, i) => {
    const block = resultBlock(r, i, perResult);
    if (block) parts.push(block);
  });
  if (!results.length && out?.content === undefined) parts.push("No results.");
  const statuses: any[] = Array.isArray(data?.statuses) ? data.statuses : [];
  const bad = statuses.filter((s: any) => s && s.status && s.status !== "success");
  if (bad.length) {
    parts.push(
      `### Failed URLs\n${bad
        .map((s: any) => {
          const errDetail = s.error?.tag ?? (typeof s.error === "string" ? s.error : s.error?.message ?? (s.error ? JSON.stringify(s.error) : s.status));
          return `- ${s.id ?? "unknown URL"}: ${errDetail}`;
        })
        .join("\n")}`,
    );
  }
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = `${clip(text, maxChars)}\n\n[truncated to ${maxChars} chars; raise maxChars or use raw=true]`;
  return text;
}

export function footer(meta: { keyAlias: string; ms: number; attempts: { key: string; status: number | string }[] }, data: any, cached = false) {
  const tries = Array.isArray(meta?.attempts) && meta.attempts.length > 1 ? ` · failover ${meta.attempts.map((a) => `${a.key}:${a.status}`).join("→")}` : "";
  return `\n\n---\nkey ${meta.keyAlias} · cost ${costLine(data)} · ${cached ? "cached" : `${meta.ms} ms`}${data?.requestId ? ` · req ${data.requestId}` : ""}${tries}`;
}

export function formatAnswer(data: any, maxChars: number): string {
  const ans = typeof data?.answer === "string" ? data.answer : JSON.stringify(data?.answer ?? null, null, 2);
  const cites = (Array.isArray(data?.citations) ? data.citations : [])
    .filter((c: any) => c && typeof c === "object")
    .map((c: any, i: number) => `[${i + 1}] ${oneLine(c.title || c.url || "Untitled")} — ${c.url ?? ""}${c.publishedDate ? ` (${String(c.publishedDate).slice(0, 10)})` : ""}`)
    .join("\n");
  return clip(`## Answer\n${ans}\n\n### Citations\n${cites || "none"}`, maxChars);
}

export function formatRun(run: any, maxChars: number): string {
  run = run ?? {};
  const lines = [`## Agent run ${run.id ?? "unknown"}`, `status: ${run.status ?? "unknown"}${run.stopReason ? ` · stopReason: ${run.stopReason}` : ""}`];
  if (run.effort) lines.push(`effort: ${run.effort}`);
  if (run.error) lines.push(`error: ${typeof run.error === "string" ? run.error : JSON.stringify(run.error)}`);
  const o = run.output;
  if (o?.text) lines.push(`### Text\n${o.text}`);
  if (o?.structured !== undefined && o?.structured !== null) lines.push(`### Structured\n\`\`\`json\n${JSON.stringify(o.structured, null, 2)}\n\`\`\``);
  if (Array.isArray(o?.grounding) && o.grounding.length) {
    lines.push(
      `### Grounding\n${o.grounding
        .filter((g: any) => g && typeof g === "object")
        .slice(0, 50)
        .map((g: any) => `- ${g.field ?? g.path ?? "text"}: ${(Array.isArray(g.citations) ? g.citations : []).map((c: any) => c?.url ?? "").filter(Boolean).join(" ")}`)
        .join("\n")}`,
    );
  }
  return clip(lines.join("\n\n"), maxChars);
}
