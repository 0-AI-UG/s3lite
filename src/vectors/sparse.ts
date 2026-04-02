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

    // Collect top-K using a bounded max-heap (heap root = worst score kept)
    // Scores are negated so lower = better (consistent with dense distances)
    const heapKeys: string[] = [];
    const heapScores: number[] = [];
    let heapSize = 0;

    for (const [key, score] of scores) {
      if (filterFn && !filterFn(key)) continue;
      const negScore = -score;

      if (heapSize < topK) {
        // Push into heap
        heapKeys.push(key);
        heapScores.push(negScore);
        heapSize++;
        // Sift up
        let i = heapSize - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heapScores[parent]! >= heapScores[i]!) break;
          // swap
          const tk = heapKeys[i]!; heapKeys[i] = heapKeys[parent]!; heapKeys[parent] = tk;
          const ts = heapScores[i]!; heapScores[i] = heapScores[parent]!; heapScores[parent] = ts;
          i = parent;
        }
      } else if (negScore < heapScores[0]!) {
        // Replace root (worst in heap) with better score
        heapKeys[0] = key;
        heapScores[0] = negScore;
        // Sift down
        let i = 0;
        while (true) {
          let largest = i;
          const l = 2 * i + 1, r = 2 * i + 2;
          if (l < heapSize && heapScores[l]! > heapScores[largest]!) largest = l;
          if (r < heapSize && heapScores[r]! > heapScores[largest]!) largest = r;
          if (largest === i) break;
          const tk = heapKeys[i]!; heapKeys[i] = heapKeys[largest]!; heapKeys[largest] = tk;
          const ts = heapScores[i]!; heapScores[i] = heapScores[largest]!; heapScores[largest] = ts;
          i = largest;
        }
      }
    }

    // Extract sorted results from heap
    const results: ScoredResult[] = new Array(heapSize);
    for (let i = heapSize - 1; i >= 0; i--) {
      results[i] = { key: heapKeys[0]!, score: heapScores[0]! };
      // Move last element to root and sift down
      heapSize--;
      if (heapSize > 0) {
        heapKeys[0] = heapKeys[heapSize]!;
        heapScores[0] = heapScores[heapSize]!;
        let j = 0;
        while (true) {
          let largest = j;
          const l = 2 * j + 1, r = 2 * j + 2;
          if (l < heapSize && heapScores[l]! > heapScores[largest]!) largest = l;
          if (r < heapSize && heapScores[r]! > heapScores[largest]!) largest = r;
          if (largest === j) break;
          const tk = heapKeys[j]!; heapKeys[j] = heapKeys[largest]!; heapKeys[largest] = tk;
          const ts = heapScores[j]!; heapScores[j] = heapScores[largest]!; heapScores[largest] = ts;
          j = largest;
        }
      }
    }
    return results;
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
