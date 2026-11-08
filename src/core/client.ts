import { KeyPool, type PoolKey } from "./keypool.js";

export class ExaError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
    public keyAlias?: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface Attempt {
  key: string;
  status: number | string;
}

export interface CallResult<T = any> {
  data: T;
  keyAlias: string;
  keyFp: string;
  attempts: Attempt[];
  ms: number;
}

export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  /** Requests per second per key (Exa free plan: 10). 0 = no limit. */
  qpsPerKey: number;
  userAgent?: string;
}

export interface RequestOptions {
  /** Keep the request on the key that owns a run or monitor. */
  pin?: string;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** Cost to book on success. Default: costDollars of the response. */
  cost?: (data: any) => number;
  /** Only use keys with at least this much budget left this month. */
  need?: number;
  /** Cancels the request (the MCP client cancelled the tool call). */
  signal?: AbortSignal;
}

const FEATURE_HINT = /plan doesn'?t include|not (included|available) (in|on) your|upgrade|contact sales|trial/i;
const CREDIT_HINT = /credit|balance|quota|billing|payment|insufficient|exceeded your|limit reached/i;

function retryAfter(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (!v) return;
  const s = Number(v);
  if (!Number.isNaN(s)) return s * 1000;
  const t = Date.parse(v) - Date.now();
  return t > 0 ? t : undefined;
}

export function costOf(data: any): number {
  const c = data?.costDollars;
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (c && typeof c.total === "number" && Number.isFinite(c.total)) return c.total;
  return 0;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let t: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Spaces requests per key so one process never exceeds the per-key QPS. */
class Pacer {
  private next = new Map<string, number>();
  constructor(private gapMs: number) {}
  async wait(fp: string, signal?: AbortSignal) {
    if (this.gapMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.next.get(fp) ?? 0);
    this.next.set(fp, at + this.gapMs);
    if (at > now) await sleep(at - now, signal);
  }
}

export class ExaClient {
  private pacer: Pacer;

  constructor(
    readonly pool: KeyPool,
    private opts: ClientOptions,
  ) {
    this.pacer = new Pacer(opts.qpsPerKey > 0 ? Math.ceil(1000 / opts.qpsPerKey) : 0);
  }

  /** Removes every configured key from a string. */
  redact(s: string) {
    let out = s;
    for (const { secret } of this.pool.keys) if (secret) out = out.split(secret).join("[key]");
    return out;
  }

  /** Sends one Exa request, failing over to the next key on auth, credit, rate, server and network errors. */
  async request<T = any>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<CallResult<T>> {
    const started = Date.now();
    const attempts: Attempt[] = [];
    const tried = new Set<string>();
    let lastErr: ExaError | null = null;

    const url = new URL(path.replace(/^\//, ""), this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : `${this.opts.baseUrl}/`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let i = 0; i < Math.max(1, this.opts.maxAttempts); i++) {
      if (opts.signal?.aborted) throw new ExaError("Cancelled by the client.", 0, null);
      const next: PoolKey | undefined = this.pool.candidates(opts.pin, opts.need).find((k) => !tried.has(k.fp));
      if (!next) break;
      tried.add(next.fp);

      try {
        await this.pacer.wait(next.fp, opts.signal);
      } catch {
        if (opts.signal?.aborted) throw new ExaError("Cancelled by the client.", 0, null, next.alias);
        throw lastErr ?? new ExaError("Pacer aborted", 0, null, next.alias);
      }
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.opts.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method,
          headers: {
            "x-api-key": next.secret,
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": this.opts.userAgent ?? "exa-ultra-mcp",
          },
          body: payload,
          signal,
        });
        text = await res.text();
      } catch (e: any) {
        if (opts.signal?.aborted) throw new ExaError("Cancelled by the client.", 0, null, next.alias);
        const msg = this.redact(String(timeout.aborted ? "request timed out" : (e?.cause?.code ?? e?.message ?? e)));
        attempts.push({ key: next.alias, status: timeout.aborted ? "timeout" : "network" });
        this.pool.failure(next.fp, "server", msg);
        lastErr = new ExaError(`Network error: ${msg}`, 0, null, next.alias, true);
        continue;
      }

      let data: any = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* non-JSON body (proxy error page): keep text */
      }
      attempts.push({ key: next.alias, status: res.status });

      if (res.ok) {
        if (typeof data === "string") {
          // 200 with a non-JSON body: treat like a server fault, try another key.
          this.pool.failure(next.fp, "server", "non-JSON 200 response");
          lastErr = new ExaError(`Exa returned a non-JSON response: ${this.redact(data.slice(0, 200))}`, res.status, null, next.alias, true);
          continue;
        }
        this.pool.success(next.fp, (opts.cost ?? costOf)(data));
        return { data, keyAlias: next.alias, keyFp: next.fp, attempts, ms: Date.now() - started };
      }

      const detail = this.redact(
        typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data?.error ?? data?.message ?? data).slice(0, 500),
      );
      const err = new ExaError(`Exa ${res.status}: ${detail}`, res.status, data, next.alias);

      if (res.status === 403 && FEATURE_HINT.test(detail)) {
        // The plan lacks this feature (e.g. Snapshot on the free plan). The key is fine and every key on
        // the same plan answers the same, so do not disable it and do not try the others.
        throw err;
      } else if (res.status === 401 || res.status === 403) {
        this.pool.failure(next.fp, CREDIT_HINT.test(detail) ? "credits" : "auth", detail);
      } else if (res.status === 402 || (res.status === 429 && CREDIT_HINT.test(detail) && !/rate/i.test(detail))) {
        this.pool.failure(next.fp, "credits", detail);
      } else if (res.status === 429) {
        this.pool.failure(next.fp, "rate", detail, retryAfter(res.headers));
      } else if (res.status >= 500 || res.status === 408) {
        this.pool.failure(next.fp, "server", detail);
      } else {
        // 400, 404, 409, 422: the request itself is wrong; another key will not help.
        throw err;
      }
      err.retryable = true;
      lastErr = err;
    }

    if (lastErr) {
      lastErr.message += ` (tried ${attempts.map((a) => `${a.key}:${a.status}`).join(", ")})`;
      throw lastErr;
    }
    if (opts.pin) throw new ExaError("The key that owns this resource is not configured anymore.", 0, null);
    if (opts.need)
      throw new ExaError(
        `No key has $${opts.need} of monthly budget left for this run. Lower maxCostDollars, use a cheaper effort, or wait for next month. See exa_keys_status.`,
        0,
        null,
      );
    throw new ExaError("No usable Exa key: all keys are disabled, cooling down or over budget. See exa_keys_status.", 0, null);
  }
}
