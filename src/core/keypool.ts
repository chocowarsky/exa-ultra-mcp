import { createHash } from "node:crypto";
import { StateStore, type KeyRecord, type StateData } from "./state.js";

export type Strategy = "round-robin" | "priority" | "least-used";
export type FailureKind = "auth" | "credits" | "rate" | "server";

export interface PoolOptions {
  strategy: Strategy;
  /** USD per key per month (Exa free plan: 10). */
  monthlyBudget: number;
  /** Stop using a key this many USD before the budget. */
  budgetMargin: number;
  store: StateStore;
}

export interface PoolKey {
  alias: string;
  fp: string;
  last4: string;
  secret: string;
}

export interface KeyStatus {
  alias: string;
  key: string;
  healthy: boolean;
  state: string;
  month: string;
  requests: number;
  spendUsd: number;
  reservedUsd: number;
  budgetUsd: number;
  lastError: string | null;
}

const MAX_OWNERS = 2000;
const month = () => new Date().toISOString().slice(0, 7);
const fingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 12);

/** Splits a comma, semicolon, space or newline separated list; trims and dedupes. */
export function parseKeys(raw: string): string[] {
  const keys = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join(",")
    .split(/[\s,;]+/)
    .map((k) => k.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return [...new Set(keys)];
}

const fresh = (): KeyRecord => ({
  cooldownUntil: 0,
  disabledUntil: 0,
  disabledReason: null,
  consecutiveFailures: 0,
  lastError: null,
  month: month(),
  requests: 0,
  spend: 0,
});

/**
 * A pool of Exa keys. State (spend, cooldowns, owners, reservations) lives in a StateStore shared
 * by all server processes, so parallel chat sessions see the same budget and the same dead keys.
 */
export class KeyPool {
  readonly keys: PoolKey[];
  private cursor = Math.floor(Math.random() * 1000);

  constructor(
    secrets: string[],
    private opts: PoolOptions,
  ) {
    if (!secrets.length) throw new Error("No Exa API keys configured.");
    this.keys = secrets.map((secret, i) => ({ alias: `k${i + 1}`, fp: fingerprint(secret), last4: secret.slice(-4), secret }));
  }

  get size() {
    return this.keys.length;
  }

  get budget() {
    return this.opts.monthlyBudget;
  }

  /** Record for one key with the month rolled over; does not write. */
  private rec(s: StateData, fp: string): KeyRecord {
    const r = s.keys[fp] ?? fresh();
    if (r.month !== month()) {
      r.month = month();
      r.requests = 0;
      r.spend = 0;
      if (r.disabledReason === "credits exhausted") {
        r.disabledUntil = 0;
        r.disabledReason = null;
      }
    }
    s.keys[fp] = r;
    return r;
  }

  private reserved(s: StateData, fp: string, now: number) {
    let n = 0;
    for (const r of Object.values(s.reservations)) if (r.fp === fp && r.until > now) n += r.amount;
    return n;
  }

  private usable(s: StateData, fp: string, now: number, need = 0) {
    const r = this.rec(s, fp);
    if (r.disabledUntil > now || r.cooldownUntil > now) return false;
    return r.spend + this.reserved(s, fp, now) + need < this.opts.monthlyBudget - this.opts.budgetMargin;
  }

  /** Ordered candidate keys for one request. `pin` returns only that key; `need` skips keys without that much budget left. */
  candidates(pin?: string, need = 0): PoolKey[] {
    if (pin) return this.keys.filter((k) => k.fp === pin);
    const s = this.opts.store.read();
    const now = Date.now();
    const list = this.keys.filter((k) => this.usable(s, k.fp, now, need));
    if (!list.length) {
      if (need > 0) return [];
      // Everything cooling down: try the key that frees up first; never hard-disabled or over-budget keys.
      return this.keys
        .filter((k) => {
          const r = this.rec(s, k.fp);
          return r.disabledUntil <= now && r.spend + this.reserved(s, k.fp, now) < this.opts.monthlyBudget - this.opts.budgetMargin;
        })
        .sort((a, b) => this.rec(s, a.fp).cooldownUntil - this.rec(s, b.fp).cooldownUntil)
        .slice(0, 1);
    }
    if (this.opts.strategy === "least-used") {
      return [...list].sort((a, b) => {
        const ra = this.rec(s, a.fp);
        const rb = this.rec(s, b.fp);
        return ra.spend - rb.spend || ra.requests - rb.requests;
      });
    }
    if (this.opts.strategy === "priority") return list;
    const start = this.cursor++ % list.length;
    return [...list.slice(start), ...list.slice(0, start)];
  }

  success(fp: string, cost: number) {
    this.opts.store.update((s) => {
      const r = this.rec(s, fp);
      r.requests++;
      r.spend += cost > 0 ? cost : 0;
      r.consecutiveFailures = 0;
      r.lastError = null;
      r.cooldownUntil = 0;
      if (r.disabledReason && r.disabledUntil <= Date.now()) r.disabledReason = null;
    });
  }

  addSpend(fp: string, cost: number) {
    if (!(cost > 0)) return;
    this.opts.store.update((s) => {
      this.rec(s, fp).spend += cost;
    });
  }

  failure(fp: string, kind: FailureKind, detail: string, retryAfterMs?: number) {
    this.opts.store.update((s) => {
      const r = this.rec(s, fp);
      const now = Date.now();
      r.requests++;
      r.consecutiveFailures++;
      r.lastError = detail.slice(0, 200);
      if (kind === "auth") {
        r.disabledUntil = now + 6 * 3600_000;
        r.disabledReason = "rejected by Exa (401/403)";
      } else if (kind === "credits") {
        const d = new Date();
        r.disabledUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        r.disabledReason = "credits exhausted";
      } else if (kind === "rate") {
        r.cooldownUntil = now + Math.min(120_000, retryAfterMs ?? 2_000 * 2 ** Math.min(6, r.consecutiveFailures - 1));
      } else {
        r.cooldownUntil = now + Math.min(120_000, 5_000 * 2 ** Math.min(5, r.consecutiveFailures - 1));
      }
    });
  }

  /** Holds `amount` USD of a key's budget until released or `ttlMs` passes (agent runs bill at the end). */
  reserve(id: string, fp: string, amount: number, ttlMs = 6 * 3600_000) {
    if (!(amount > 0)) return;
    this.opts.store.update((s) => {
      s.reservations[id] = { fp, amount, until: Date.now() + ttlMs };
    });
  }

  moveReservation(from: string, to: string) {
    this.opts.store.update((s) => {
      const r = s.reservations[from];
      if (!r) return;
      delete s.reservations[from];
      s.reservations[to] = r;
    });
  }

  release(id: string) {
    this.opts.store.update((s) => {
      delete s.reservations[id];
      const now = Date.now();
      for (const [k, r] of Object.entries(s.reservations)) if (r.until <= now) delete s.reservations[k];
    });
  }

  /**
   * Books the final cost of a run exactly once across all processes and frees its reservation.
   * Returns false when it was already booked.
   */
  bookOnce(id: string, fp: string, cost: number): boolean {
    let booked = false;
    this.opts.store.update((s) => {
      const flag = `booked:${id}`;
      delete s.reservations[id];
      if (s.owners[flag]) return;
      if (cost > 0) this.rec(s, fp).spend += cost;
      s.owners[flag] = "1";
      booked = true;
      this.trimOwners(s);
    });
    return booked;
  }

  setOwner(id: string, fp: string) {
    this.opts.store.update((s) => {
      s.owners[id] = fp;
      this.trimOwners(s);
    });
  }

  owner(id: string): string | undefined {
    const fp = this.opts.store.read().owners[id];
    return fp && this.keys.some((k) => k.fp === fp) ? fp : undefined;
  }

  private trimOwners(s: StateData) {
    const ids = Object.keys(s.owners);
    if (ids.length > MAX_OWNERS) for (const id of ids.slice(0, ids.length - MAX_OWNERS)) delete s.owners[id];
  }

  byAlias(alias: string) {
    return this.keys.find((k) => k.alias === alias);
  }

  status(): KeyStatus[] {
    const s = this.opts.store.read();
    const now = Date.now();
    return this.keys.map((k) => {
      const r = this.rec(s, k.fp);
      const reserved = this.reserved(s, k.fp, now);
      const over = r.spend + reserved >= this.opts.monthlyBudget - this.opts.budgetMargin;
      return {
        alias: k.alias,
        key: `…${k.last4}`,
        healthy: this.usable(s, k.fp, now),
        state:
          r.disabledUntil > now
            ? `disabled: ${r.disabledReason} until ${new Date(r.disabledUntil).toISOString()}`
            : r.cooldownUntil > now
              ? `cooldown ${Math.ceil((r.cooldownUntil - now) / 1000)}s`
              : over
                ? "monthly budget reached"
                : "ok",
        month: r.month,
        requests: r.requests,
        spendUsd: Number(r.spend.toFixed(4)),
        reservedUsd: Number(reserved.toFixed(4)),
        budgetUsd: this.opts.monthlyBudget,
        lastError: r.lastError,
      };
    });
  }

  /** Clears cooldowns and disables (all keys, or one alias). Returns false for an unknown alias. */
  reset(alias?: string): boolean {
    if (alias && !this.byAlias(alias)) return false;
    this.opts.store.update((s) => {
      for (const k of this.keys) {
        if (alias && k.alias !== alias) continue;
        const r = this.rec(s, k.fp);
        r.cooldownUntil = 0;
        r.disabledUntil = 0;
        r.disabledReason = null;
        r.consecutiveFailures = 0;
      }
    });
    return true;
  }
}
