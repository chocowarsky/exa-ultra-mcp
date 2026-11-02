export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private ttlMs: number,
    private max = 200,
  ) {}

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return;
    }
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V) {
    if (this.ttlMs <= 0) return;
    this.map.set(k, { v, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}
