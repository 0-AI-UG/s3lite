/**
 * LRU cache for Float32Array vectors, using Map insertion-order semantics.
 * Keyed by composite "indexName/key" string.
 */
export class VectorCache {
  private cache: Map<string, Float32Array>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
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
    this.cache.delete(ck);
    this.cache.set(ck, vector);
    if (this.cache.size > this.maxSize) {
      // Evict oldest (first inserted)
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
  }

  delete(indexName: string, key: string): void {
    this.cache.delete(this.cacheKey(indexName, key));
  }

  clear(): void {
    this.cache.clear();
  }
}
