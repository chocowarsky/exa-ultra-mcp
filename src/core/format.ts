const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function costLine(data: any): string {
  const c = data?.costDollars;
  const total = typeof c === "number" ? c : c?.total;
  return typeof total === "number" ? `$${total.toFixed(4)}` : "n/a";
}

function resultBlock(r: any, i: number, perResult: number): string {
  const head = [`### [${i + 1}] ${oneLine(r.title || r.url || "Untitled")}`, r.url];
  const meta = [r.publishedDate && `published ${String(r.publishedDate).slice(0, 10)}`, r.author && `by ${oneLine(r.author)}`]
    .filter(Boolean)
    .join(" · ");
  if (meta) head.push(meta);
  const body: string[] = [];
  if (Array.isArray(r.highlights) && r.highlights.length) {
    for (const h of r.highlights) body.push(`> ${oneLine(String(h))}`);
  }
  if (r.summary) body.push(`Summary: ${oneLine(String(r.summary))}`);
  if (r.text) body.push(String(r.text).trim());
  let text = body.join("\n");
  if (text.length > perResult) text = clip(text, perResult);
  const extra: string[] = [];
  if (Array.isArray(r.subpages) && r.subpages.length) {
    extra.push(
      `Subpages:\n${r.subpages
        .map((s: any) => `- ${oneLine(s.title || s.url)} — ${s.url}${s.highlights?.length ? `\n  > ${clip(oneLine(s.highlights.join(" … ")), 300)}` : s.text ? `\n  > ${clip(oneLine(s.text), 300)}` : ""}`)
        .join("\n")}`,
    );
  }
  if (r.extras?.links?.length) extra.push(`Links: ${r.extras.links.slice(0, 20).join(" ")}`);
  if (r.extras?.imageLinks?.length) extra.push(`Images: ${r.extras.imageLinks.slice(0, 10).join(" ")}`);
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
          .map((g: any) => `- ${g.field ?? "content"}: ${(g.citations ?? []).map((c: any) => c.url).join(" ")}`)
          .join("\n")}`,
      );
    }
  }
  const budget = Math.max(400, maxChars - parts.join("\n\n").length);
  const perResult = results.length ? Math.max(300, Math.floor(budget / results.length) - 150) : 0;
  results.forEach((r, i) => parts.push(resultBlock(r, i, perResult)));
  if (!results.length && out?.content === undefined) parts.push("No results.");
  const statuses: any[] = Array.isArray(data?.statuses) ? data.statuses : [];
  const bad = statuses.filter((s) => s.status && s.status !== "success");
  if (bad.length) parts.push(`### Failed URLs\n${bad.map((s) => `- ${s.id}: ${s.error?.tag ?? s.error ?? s.status}`).join("\n")}`);
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = `${clip(text, maxChars)}\n\n[truncated to ${maxChars} chars; raise maxChars or use raw=true]`;
  return text;
}

export function footer(meta: { keyAlias: string; ms: number; attempts: { key: string; status: number | string }[] }, data: any, cached = false) {
  const tries = meta.attempts.length > 1 ? ` · failover ${meta.attempts.map((a) => `${a.key}:${a.status}`).join("→")}` : "";
  return `\n\n---\nkey ${meta.keyAlias} · cost ${costLine(data)} · ${cached ? "cached" : `${meta.ms} ms`}${data?.requestId ? ` · req ${data.requestId}` : ""}${tries}`;
}

export function formatAnswer(data: any, maxChars: number): string {
  const ans = typeof data?.answer === "string" ? data.answer : JSON.stringify(data?.answer ?? null, null, 2);
  const cites = (Array.isArray(data?.citations) ? data.citations : [])
    .map((c: any, i: number) => `[${i + 1}] ${oneLine(c.title || c.url)} — ${c.url}${c.publishedDate ? ` (${String(c.publishedDate).slice(0, 10)})` : ""}`)
    .join("\n");
  return clip(`## Answer\n${ans}\n\n### Citations\n${cites || "none"}`, maxChars);
}

export function formatRun(run: any, maxChars: number): string {
  run = run ?? {};
  const lines = [`## Agent run ${run.id}`, `status: ${run.status}${run.stopReason ? ` · stopReason: ${run.stopReason}` : ""}`];
  if (run.effort) lines.push(`effort: ${run.effort}`);
  if (run.error) lines.push(`error: ${typeof run.error === "string" ? run.error : JSON.stringify(run.error)}`);
  const o = run.output;
  if (o?.text) lines.push(`### Text\n${o.text}`);
  if (o?.structured !== undefined && o?.structured !== null) lines.push(`### Structured\n\`\`\`json\n${JSON.stringify(o.structured, null, 2)}\n\`\`\``);
  if (Array.isArray(o?.grounding) && o.grounding.length) {
    lines.push(
      `### Grounding\n${o.grounding
        .slice(0, 50)
        .map((g: any) => `- ${g.field ?? g.path ?? "text"}: ${(g.citations ?? []).map((c: any) => c.url).join(" ")}`)
        .join("\n")}`,
    );
  }
  return clip(lines.join("\n\n"), maxChars);
}
