import type { SparseVector, ScoredResult } from "./types";

export class SparseIndex {
  // inverted index: dimension → Map<vectorKey, value>
  private postings: Map<number, Map<string, number>> = new Map();
  // track which dimensions each key has (for removal)
  private keyDims: Map<string, number[]> = new Map();

  get size(): number {
    return this.keyDims.size;
  }

  insert(key: string, sparse: SparseVector): void {
    // Remove old entry if exists
    this.remove(key);

    const dims: number[] = [];
    for (let i = 0; i < sparse.indices.length; i++) {
      const dim = sparse.indices[i]!;
      const val = sparse.values[i]!;
      dims.push(dim);

      let posting = this.postings.get(dim);
      if (!posting) {
        posting = new Map();
        this.postings.set(dim, posting);
      }
      posting.set(key, val);
    }
    this.keyDims.set(key, dims);
  }

  remove(key: string): boolean {
    const dims = this.keyDims.get(key);
    if (!dims) return false;

    for (const dim of dims) {
      const posting = this.postings.get(dim);
      if (posting) {
        posting.delete(key);
        if (posting.size === 0) this.postings.delete(dim);
      }
    }
    this.keyDims.delete(key);
    return true;
  }

  search(
    query: SparseVector,
    topK: number,
    filterFn?: (key: string) => boolean,
  ): ScoredResult[] {
    // Accumulate dot product scores across shared dimensions
    const scores = new Map<string, number>();

    for (let i = 0; i < query.indices.length; i++) {
      const dim = query.indices[i]!;
      const qVal = query.values[i]!;
      const posting = this.postings.get(dim);
      if (!posting) continue;

      for (const [key, docVal] of posting) {
        scores.set(key, (scores.get(key) ?? 0) + qVal * docVal);
      }
    }

    // Filter and sort
    const results: ScoredResult[] = [];
    for (const [key, score] of scores) {
      if (filterFn && !filterFn(key)) continue;
      results.push({ key, score: -score }); // negate so lower = better (consistent with dense)
    }

    results.sort((a, b) => a.score - b.score);
    return results.slice(0, topK);
  }

  getSparseVector(key: string): SparseVector | undefined {
    const dims = this.keyDims.get(key);
    if (!dims) return undefined;

    const indices: number[] = [];
    const values: number[] = [];
    for (const dim of dims) {
      const posting = this.postings.get(dim);
      if (posting) {
        const val = posting.get(key);
        if (val !== undefined) {
          indices.push(dim);
          values.push(val);
        }
      }
    }
    return { indices, values };
  }
}
