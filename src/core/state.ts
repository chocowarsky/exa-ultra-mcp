import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-key counters. Keyed by a sha256 fingerprint, never by the key itself. */
export interface KeyRecord {
  cooldownUntil: number;
  disabledUntil: number;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  month: string; // YYYY-MM (UTC) the counters belong to
  requests: number;
  spend: number; // USD, summed from costDollars
}

export interface Reservation {
  fp: string;
  amount: number;
  until: number;
}

export interface StateData {
  version: 2;
  keys: Record<string, KeyRecord>;
  /** agent run / monitor id -> fp of the key that owns it */
  owners: Record<string, string>;
  /** budget held for agent runs that have not reported their final cost yet */
  reservations: Record<string, Reservation>;
  settings: { mode?: string };
}

const empty = (): StateData => ({ version: 2, keys: {}, owners: {}, reservations: {}, settings: {} });
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function normalize(raw: any): StateData {
  const s = empty();
  if (!raw || typeof raw !== "object") return s;
  if (raw.keys && typeof raw.keys === "object") s.keys = raw.keys;
  if (raw.owners && typeof raw.owners === "object") s.owners = raw.owners;
  if (raw.reservations && typeof raw.reservations === "object") s.reservations = raw.reservations;
  if (raw.settings && typeof raw.settings === "object") s.settings = raw.settings;
  return s;
}

/**
 * JSON state shared by every server process on the machine (one per chat session is common).
 * Writes are read-modify-write under a lock directory, so counters from parallel processes add up
 * instead of overwriting each other. Falls back to memory only when the directory is not writable.
 */
export class StateStore {
  private cache: StateData = empty();
  private mtime = -1;
  private memoryOnly: boolean;
  private lockDir: string;

  constructor(
    private path: string | null,
    private log: (msg: string) => void = () => {},
  ) {
    this.memoryOnly = !path;
    this.lockDir = `${path}.lock`;
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      } catch (e) {
        this.fallback(e);
      }
    }
  }

  private fallback(e: unknown) {
    if (!this.memoryOnly) this.log(`state file not writable (${(e as Error).message}); keeping state in memory only`);
    this.memoryOnly = true;
  }

  /** Current state; re-reads the file only when another process changed it. */
  read(): StateData {
    if (this.memoryOnly) return this.cache;
    try {
      const m = statSync(this.path!).mtimeMs;
      if (m !== this.mtime) {
        this.cache = this.load();
        this.mtime = m;
      }
    } catch {
      /* no file yet */
    }
    return this.cache;
  }

  private load(): StateData {
    try {
      return normalize(JSON.parse(readFileSync(this.path!, "utf8")));
    } catch {
      return empty(); // missing or corrupt: start fresh
    }
  }

  /** Atomic update across processes. */
  update(fn: (s: StateData) => void): StateData {
    if (this.memoryOnly) {
      fn(this.cache);
      return this.cache;
    }
    const locked = this.lock();
    try {
      const s = this.load();
      fn(s);
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      renameSync(tmp, this.path!);
      this.cache = s;
      try {
        this.mtime = statSync(this.path!).mtimeMs;
      } catch {
        this.mtime = -1;
      }
      return s;
    } catch (e) {
      this.fallback(e);
      fn(this.cache);
      return this.cache;
    } finally {
      if (locked) this.unlock();
    }
  }

  private lock(): boolean {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        mkdirSync(this.lockDir);
        return true;
      } catch (e: any) {
        if (e?.code !== "EEXIST") return false;
        try {
          // A crashed process can leave the lock behind.
          if (Date.now() - statSync(this.lockDir).mtimeMs > 5000) rmdirSync(this.lockDir);
        } catch {
          /* raced with the owner */
        }
        if (Date.now() > deadline) return false; // proceed unlocked rather than hang a tool call
        sleepSync(2);
      }
    }
  }

  private unlock() {
    try {
      rmdirSync(this.lockDir);
    } catch {
      /* already gone */
    }
  }
}
