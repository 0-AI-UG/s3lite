/**
 * LRU cache for Float32Array vectors with an optional byte budget.
 * When `maxBytes` is set, eviction is driven by total bytes held.
 * Otherwise, falls back to an entry-count limit (back-compat with `maxSize`).
 * Keyed by composite "indexName/key" string.
 */
export class VectorCache {
  private cache: Map<string, Float32Array>;
  private maxSize: number;
  private maxBytes: number;
  private bytes = 0;

  constructor(opts: { maxSize?: number; maxBytes?: number } | number) {
    this.cache = new Map();
    if (typeof opts === "number") {
      this.maxSize = opts;
      this.maxBytes = 0;
    } else {
      this.maxSize = opts.maxSize ?? 0;
      this.maxBytes = opts.maxBytes ?? 0;
    }
  }

  private cacheKey(indexName: string, key: string): string {
    return indexName + "/" + key;
  }

  get(indexName: string, key: string): Float32Array | undefined {
    const ck = this.cacheKey(indexName, key);
    const vec = this.cache.get(ck);
    if (vec === undefined) return undefined;
    // Move to end (most recently used)
    this.cache.delete(ck);
    this.cache.set(ck, vec);
    return vec;
  }

  set(indexName: string, key: string, vector: Float32Array): void {
    const ck = this.cacheKey(indexName, key);
    const prev = this.cache.get(ck);
    if (prev) this.bytes -= prev.byteLength;
    this.cache.delete(ck);
    this.cache.set(ck, vector);
    this.bytes += vector.byteLength;
    this.evict();
  }

  private evict(): void {
    if (this.maxBytes > 0) {
      while (this.bytes > this.maxBytes && this.cache.size > 1) {
        const first = this.cache.keys().next().value;
        if (first === undefined) break;
        const v = this.cache.get(first);
        this.cache.delete(first);
        if (v) this.bytes -= v.byteLength;
      }
    }
    if (this.maxSize > 0) {
      while (this.cache.size > this.maxSize) {
        const first = this.cache.keys().next().value;
        if (first === undefined) break;
        const v = this.cache.get(first);
        this.cache.delete(first);
        if (v) this.bytes -= v.byteLength;
      }
    }
  }

  delete(indexName: string, key: string): void {
    const ck = this.cacheKey(indexName, key);
    const v = this.cache.get(ck);
    if (v) {
      this.bytes -= v.byteLength;
      this.cache.delete(ck);
    }
  }

  clear(): void {
    this.cache.clear();
    this.bytes = 0;
  }
}
