export interface ByteLruCacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  evictions: number;
}

export class ByteLruCache<V> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private evictions = 0;
  private map = new Map<string, { value: V; bytes: number }>();

  constructor(options: { maxEntries: number; maxBytes: number }) {
    this.maxEntries = positiveInteger(options.maxEntries);
    this.maxBytes = positiveInteger(options.maxBytes);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, bytes: number): boolean {
    const safeBytes = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
    const previous = this.map.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.map.delete(key);
    }

    if (safeBytes > this.maxBytes) return false;

    this.map.set(key, { value, bytes: safeBytes });
    this.bytes += safeBytes;
    this.trim();
    return this.map.has(key);
  }

  delete(key: string): boolean {
    const previous = this.map.get(key);
    if (!previous) return false;
    this.bytes -= previous.bytes;
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
    this.evictions = 0;
  }

  stats(): ByteLruCacheStats {
    return {
      entries: this.map.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      evictions: this.evictions,
    };
  }

  private trim(): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (typeof oldest !== "string") return;
      if (this.delete(oldest)) this.evictions += 1;
    }
  }
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}
