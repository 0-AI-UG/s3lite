import type { DistanceMetric, HNSWNode, ScoredResult, MetadataFilter } from "./types";
import { computeNorm, getDistanceFn } from "./distance";
import { matchesFilter } from "./filter";

// Internal node — typed-array neighbor slabs to keep per-node RAM low.
// `neighbors[lc]` is preallocated to maxConn(lc) (M0 for layer 0, M elsewhere);
// `counts[lc]` is the actual number of populated entries.
interface INode {
  key: string;
  vector: Float32Array | null; // null when disk-backed (vectors stored externally)
  norm: number;
  metadata?: Record<string, unknown>;
  layer: number;
  neighbors: Int32Array[];
  counts: Uint16Array;
}

// Min-heap with typed array storage — no branches, no object allocation
class MinHeap {
  s: Float64Array;
  d: Int32Array;
  n = 0;
  private cap: number;

  constructor(initialCap = 256) {
    this.cap = initialCap;
    this.s = new Float64Array(initialCap);
    this.d = new Int32Array(initialCap);
  }

  private grow(): void {
    this.cap *= 2;
    const ns = new Float64Array(this.cap); ns.set(this.s); this.s = ns;
    const nd = new Int32Array(this.cap); nd.set(this.d); this.d = nd;
  }

  push(id: number, score: number): void {
    if (this.n >= this.cap) this.grow();
    let i = this.n++;
    this.s[i] = score;
    this.d[i] = id;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.s[i] < this.s[p]) {
        const ts = this.s[i]; this.s[i] = this.s[p]; this.s[p] = ts;
        const td = this.d[i]; this.d[i] = this.d[p]; this.d[p] = td;
        i = p;
      } else break;
    }
  }

  popDiscard(): void {
    const last = --this.n;
    if (last > 0) {
      this.s[0] = this.s[last];
      this.d[0] = this.d[last];
      let i = 0;
      while (true) {
        let best = i;
        const l = 2 * i + 1, r = l + 1;
        if (l < last && this.s[l] < this.s[best]) best = l;
        if (r < last && this.s[r] < this.s[best]) best = r;
        if (best === i) break;
        const ts = this.s[i]; this.s[i] = this.s[best]; this.s[best] = ts;
        const td = this.d[i]; this.d[i] = this.d[best]; this.d[best] = td;
        i = best;
      }
    }
  }

  clear(): void { this.n = 0; }
}

// Max-heap with typed array storage
class MaxHeap {
  s: Float64Array;
  d: Int32Array;
  n = 0;
  private cap: number;

  constructor(initialCap = 256) {
    this.cap = initialCap;
    this.s = new Float64Array(initialCap);
    this.d = new Int32Array(initialCap);
  }

  private grow(): void {
    this.cap *= 2;
    const ns = new Float64Array(this.cap); ns.set(this.s); this.s = ns;
    const nd = new Int32Array(this.cap); nd.set(this.d); this.d = nd;
  }

  push(id: number, score: number): void {
    if (this.n >= this.cap) this.grow();
    let i = this.n++;
    this.s[i] = score;
    this.d[i] = id;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.s[i] > this.s[p]) {
        const ts = this.s[i]; this.s[i] = this.s[p]; this.s[p] = ts;
        const td = this.d[i]; this.d[i] = this.d[p]; this.d[p] = td;
        i = p;
      } else break;
    }
  }

  popDiscard(): void {
    const last = --this.n;
    if (last > 0) {
      this.s[0] = this.s[last];
      this.d[0] = this.d[last];
      let i = 0;
      while (true) {
        let best = i;
        const l = 2 * i + 1, r = l + 1;
        if (l < last && this.s[l] > this.s[best]) best = l;
        if (r < last && this.s[r] > this.s[best]) best = r;
        if (best === i) break;
        const ts = this.s[i]; this.s[i] = this.s[best]; this.s[best] = ts;
        const td = this.d[i]; this.d[i] = this.d[best]; this.d[best] = td;
        i = best;
      }
    }
  }

  clear(): void { this.n = 0; }
}

export class HNSWIndex {
  // Dense array indexed by numeric ID — O(1) node access
  private nodes: (INode | undefined)[] = [];
  private keyToId = new Map<string, number>();
  private nextId = 0;
  private freeIds: number[] = [];
  private activeCount = 0;

  private entryPointId = -1;
  private _maxLayer = -1;

  // Visited generation counter — avoids allocating a Set per searchLayer call
  private visitedMark: Uint32Array = new Uint32Array(256);
  private visitedGen = 0;

  // Reusable heaps
  private readonly cHeap = new MinHeap(512);
  private readonly rHeap = new MaxHeap(512);

  // Reusable drain arrays
  private _drainIds: Int32Array = new Int32Array(512);
  private _drainScores: Float64Array = new Float64Array(512);

  readonly M: number;
  readonly M0: number;
  readonly efConstruction: number;
  readonly dimension: number;
  readonly metric: DistanceMetric;

  private mL: number;
  private distFn: (a: Float32Array, b: Float32Array, normA?: number, normB?: number) => number;

  // Pluggable vector access — memory mode reads from INode.vector, disk mode reads from external store
  private getVec: (id: number) => Float32Array;

  constructor(dimension: number, metric: DistanceMetric = "cosine", M = 16, efConstruction = 200) {
    this.dimension = dimension;
    this.metric = metric;
    this.M = M;
    this.M0 = M * 2;
    this.efConstruction = efConstruction;
    this.mL = 1 / Math.log(M);
    this.distFn = getDistanceFn(metric);
    this.getVec = (id) => this.nodes[id]!.vector!;
  }

  setVectorProvider(provider: (id: number) => Float32Array): void {
    this.getVec = provider;
  }

  getNodeById(id: number): INode | undefined {
    return this.nodes[id];
  }

  /** Null out the in-memory vector for a node (used after writing to disk). */
  clearNodeVector(key: string): void {
    const id = this.keyToId.get(key);
    if (id !== undefined && this.nodes[id]) {
      this.nodes[id]!.vector = null;
    }
  }

  get size(): number { return this.activeCount; }

  private allocId(): number {
    return this.freeIds.length > 0 ? this.freeIds.pop()! : this.nextId++;
  }

  private growVisited(): void {
    if (this.nextId > this.visitedMark.length) {
      const newArr = new Uint32Array(Math.max(this.nextId * 2, 256));
      newArr.set(this.visitedMark);
      this.visitedMark = newArr;
    }
  }

  private bumpGen(): number {
    let gen = ++this.visitedGen;
    if (gen === 0) {
      this.visitedMark.fill(0);
      gen = this.visitedGen = 1;
    }
    return gen;
  }

  private ensureDrain(n: number): void {
    if (this._drainIds.length < n) {
      const sz = Math.max(n, this._drainIds.length * 2);
      this._drainIds = new Int32Array(sz);
      this._drainScores = new Float64Array(sz);
    }
  }

  private maxConnAt(lc: number): number {
    return lc === 0 ? this.M0 : this.M;
  }

  private buildNeighborSlabs(layer: number): { neighbors: Int32Array[]; counts: Uint16Array } {
    const layers = layer + 1;
    const neighbors: Int32Array[] = new Array(layers);
    for (let lc = 0; lc < layers; lc++) {
      neighbors[lc] = new Int32Array(this.maxConnAt(lc));
    }
    return { neighbors, counts: new Uint16Array(layers) };
  }

  private pushNbr(node: INode, lc: number, id: number): void {
    const count = node.counts[lc]!;
    const slab = node.neighbors[lc]!;
    if (count < slab.length) {
      slab[count] = id;
      node.counts[lc] = count + 1;
    } else {
      // Should not happen in practice (capacity = maxConn), but guard anyway.
      const grown = new Int32Array(slab.length * 2);
      grown.set(slab);
      grown[count] = id;
      node.neighbors[lc] = grown;
      node.counts[lc] = count + 1;
    }
  }

  private removeNbr(node: INode, lc: number, id: number): void {
    const slab = node.neighbors[lc]!;
    const count = node.counts[lc]!;
    for (let i = 0; i < count; i++) {
      if (slab[i] === id) {
        slab[i] = slab[count - 1]!;
        node.counts[lc] = count - 1;
        return;
      }
    }
  }

  private randomLayer(): number {
    const r = Math.random() || Number.MIN_VALUE;
    const raw = Math.floor(-Math.log(r) * this.mL);
    const maxAllowed = Math.max(16, Math.floor(Math.log2(this.activeCount + 2) * 2));
    return Math.min(raw, maxAllowed);
  }

  hasKey(key: string): boolean {
    return this.keyToId.has(key);
  }

  getNode(key: string): HNSWNode | undefined {
    const id = this.keyToId.get(key);
    if (id === undefined) return undefined;
    const n = this.nodes[id];
    if (!n) return undefined;
    return {
      key: n.key, vector: n.vector ?? this.getVec(id), norm: n.norm, metadata: n.metadata,
      layer: n.layer, deleted: false,
      neighbors: this.neighborKeySets(n),
    };
  }

  private neighborKeySets(n: INode): Set<string>[] {
    const layers = n.neighbors.length;
    const out: Set<string>[] = new Array(layers);
    for (let lc = 0; lc < layers; lc++) {
      const s = new Set<string>();
      const slab = n.neighbors[lc]!;
      const count = n.counts[lc]!;
      for (let i = 0; i < count; i++) {
        const nb = this.nodes[slab[i]!];
        if (nb) s.add(nb.key);
      }
      out[lc] = s;
    }
    return out;
  }

  /** Iterate nodes yielding only metadata (no vector access). Used for disk-mode checkpointing. */
  *allNodeMeta(): IterableIterator<{ key: string; norm: number; metadata?: Record<string, unknown> }> {
    for (let i = 0; i < this.nextId; i++) {
      const n = this.nodes[i];
      if (!n) continue;
      yield { key: n.key, norm: n.norm, metadata: n.metadata };
    }
  }

  *allNodes(): IterableIterator<HNSWNode> {
    for (let i = 0; i < this.nextId; i++) {
      const n = this.nodes[i];
      if (!n) continue;
      yield {
        key: n.key, vector: n.vector ?? this.getVec(i), norm: n.norm, metadata: n.metadata,
        layer: n.layer, deleted: false,
        neighbors: this.neighborKeySets(n),
      };
    }
  }

  insert(key: string, vector: Float32Array, metadata?: Record<string, unknown>): void {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension ${vector.length} does not match index dimension ${this.dimension}`);
    }

    if (this.keyToId.has(key)) {
      this.remove(key);
    }

    const norm = computeNorm(vector);
    const layer = this.randomLayer();
    const id = this.allocId();
    const slabs = this.buildNeighborSlabs(layer);
    const node: INode = {
      key, vector, norm, metadata, layer,
      neighbors: slabs.neighbors,
      counts: slabs.counts,
    };

    this.nodes[id] = node;
    this.keyToId.set(key, id);
    this.activeCount++;
    this.growVisited();

    if (this.entryPointId === -1) {
      this.entryPointId = id;
      this._maxLayer = layer;
      return;
    }

    const distFn = this.distFn;
    const nodesArr = this.nodes;
    const getVec = this.getVec;
    let currentId = this.entryPointId;
    let currentDist = distFn(vector, getVec(currentId), norm, nodesArr[currentId]!.norm);

    // Greedy descent through layers above insertion layer
    for (let lc = this._maxLayer; lc > layer; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const cn = nodesArr[currentId]!;
        if (lc < cn.neighbors.length) {
          const nbrs = cn.neighbors[lc]!;
          const nLen = cn.counts[lc]!;
          for (let ni = 0; ni < nLen; ni++) {
            const nbrId = nbrs[ni]!;
            const nbrNode = nodesArr[nbrId];
            if (!nbrNode) continue;
            const d = distFn(vector, getVec(nbrId), norm, nbrNode.norm);
            if (d < currentDist) {
              currentId = nbrId;
              currentDist = d;
              changed = true;
            }
          }
        }
      }
    }

    // Insert at each layer
    const candidates = this.cHeap;
    const results = this.rHeap;
    const ef = this.efConstruction;

    for (let lc = Math.min(layer, this._maxLayer); lc >= 0; lc--) {
      // --- searchLayer inlined ---
      candidates.clear();
      results.clear();
      const gen = this.bumpGen();
      const visited = this.visitedMark;

      visited[currentId] = gen;
      const epDist = distFn(vector, getVec(currentId), norm, nodesArr[currentId]!.norm);
      candidates.push(currentId, epDist);
      results.push(currentId, epDist);

      while (candidates.n > 0) {
        const cScore = candidates.s[0];
        if (cScore > results.s[0] && results.n >= ef) break;
        const cId = candidates.d[0];
        candidates.popDiscard();

        const cNode = nodesArr[cId];
        if (!cNode || lc >= cNode.neighbors.length) continue;

        const nbrs = cNode.neighbors[lc]!;
        const nLen = cNode.counts[lc]!;
        for (let ni = 0; ni < nLen; ni++) {
          const nbrId = nbrs[ni]!;
          if (visited[nbrId] === gen) continue;
          visited[nbrId] = gen;

          const nbrNode = nodesArr[nbrId];
          if (!nbrNode) continue;

          const d = distFn(vector, getVec(nbrId), norm, nbrNode.norm);

          if (d < results.s[0] || results.n < ef) {
            candidates.push(nbrId, d);
            results.push(nbrId, d);
            if (results.n > ef) results.popDiscard();
          }
        }
      }

      // Drain max-heap to sorted arrays (ascending by score)
      const numResults = results.n;
      this.ensureDrain(numResults);
      const rIds = this._drainIds;
      const rScores = this._drainScores;
      for (let ri = numResults - 1; ri >= 0; ri--) {
        rScores[ri] = results.s[0];
        rIds[ri] = results.d[0];
        results.popDiscard();
      }
      // --- end searchLayer ---

      // Select neighbors
      const maxConn = lc === 0 ? this.M0 : this.M;
      const selectedIds = this.selectNeighborIds(vector, norm, rIds, rScores, numResults, maxConn);

      // Connect bidirectionally
      for (let si = 0, sLen = selectedIds.length; si < sLen; si++) {
        const nId = selectedIds[si]!;
        this.pushNbr(node, lc, nId);
        const nNode = nodesArr[nId]!;
        if (lc < nNode.neighbors.length) {
          this.pushNbr(nNode, lc, id);
          if (nNode.counts[lc]! > maxConn) {
            this.pruneConnections(nNode, lc, maxConn);
          }
        }
      }

      if (numResults > 0) {
        currentId = rIds[0]!;
      }
    }

    if (layer > this._maxLayer) {
      this._maxLayer = layer;
      this.entryPointId = id;
    }
  }

  private selectNeighborIds(
    query: Float32Array,
    queryNorm: number,
    candidateIds: Int32Array | number[],
    candidateScores: Float64Array | number[],
    count: number,
    M: number,
  ): number[] {
    if (count <= M) {
      const out: number[] = new Array(count);
      for (let i = 0; i < count; i++) out[i] = candidateIds[i]!;
      return out;
    }

    const distFn = this.distFn;
    const nodesArr = this.nodes;
    const getVec = this.getVec;

    // candidates are already sorted ascending by score
    const selected: number[] = [];
    const selVecs: Float32Array[] = [];
    const selNorms: number[] = [];

    for (let i = 0; i < count; i++) {
      if (selected.length >= M) break;
      const cId = candidateIds[i]!;
      const cNode = nodesArr[cId];
      if (!cNode) continue;
      const cScore = candidateScores[i]!;
      const cVec = getVec(cId);

      // Keep if closer to query than to any already-selected neighbor
      let tooClose = false;
      for (let j = 0, sLen = selected.length; j < sLen; j++) {
        if (distFn(cVec, selVecs[j]!, cNode.norm, selNorms[j]!) < cScore) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        selected.push(cId);
        selVecs.push(cVec);
        selNorms.push(cNode.norm);
      }
    }

    // Fill remaining slots with closest candidates
    if (selected.length < M) {
      const selectedSet = new Set(selected);
      for (let i = 0; i < count && selected.length < M; i++) {
        if (!selectedSet.has(candidateIds[i]!)) {
          selected.push(candidateIds[i]!);
        }
      }
    }

    return selected;
  }

  private pruneConnections(node: INode, layer: number, maxConn: number): void {
    const nbrs = node.neighbors[layer]!;
    const len = node.counts[layer]!;
    if (len <= maxConn) return;

    const distFn = this.distFn;
    const nodesArr = this.nodes;
    const getVec = this.getVec;
    const nodeId = this.keyToId.get(node.key)!;
    const nodeVec = getVec(nodeId);

    // Score all neighbors by distance, keep closest maxConn
    const scores: number[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const nbrId = nbrs[i]!;
      const nNode = nodesArr[nbrId];
      scores[i] = nNode ? distFn(nodeVec, getVec(nbrId), node.norm, nNode.norm) : Infinity;
    }

    const indices: number[] = new Array(len);
    for (let i = 0; i < len; i++) indices[i] = i;
    indices.sort((a, b) => scores[a]! - scores[b]!);

    // Rewrite slab in place; capacity stays at maxConnAt(layer).
    const kept = new Int32Array(maxConn);
    for (let i = 0; i < maxConn; i++) kept[i] = nbrs[indices[i]!]!;
    nbrs.set(kept);
    // Zero the tail so stale entries can't be read.
    for (let i = maxConn; i < nbrs.length; i++) nbrs[i] = 0;
    node.counts[layer] = maxConn;
  }

  remove(key: string): boolean {
    const id = this.keyToId.get(key);
    if (id === undefined) return false;
    const node = this.nodes[id];
    if (!node) return false;

    for (let lc = 0; lc < node.neighbors.length; lc++) {
      const nbrs = node.neighbors[lc]!;
      const len = node.counts[lc]!;
      for (let i = 0; i < len; i++) {
        const nId = nbrs[i]!;
        const nNode = this.nodes[nId];
        if (nNode && lc < nNode.neighbors.length) {
          this.removeNbr(nNode, lc, id);
        }
      }
    }

    this.nodes[id] = undefined;
    this.keyToId.delete(key);
    this.freeIds.push(id);
    this.activeCount--;

    if (this.entryPointId === id) {
      this.entryPointId = -1;
      this._maxLayer = -1;
      for (let i = 0; i < this.nextId; i++) {
        const n = this.nodes[i];
        if (n && n.layer > this._maxLayer) {
          this.entryPointId = i;
          this._maxLayer = n.layer;
        }
      }
    }

    return true;
  }

  search(
    query: Float32Array,
    topK: number,
    efSearch = 64,
    filter?: MetadataFilter,
  ): ScoredResult[] {
    if (this.entryPointId === -1) return [];
    if (query.length !== this.dimension) {
      throw new Error(`Query dimension ${query.length} does not match index dimension ${this.dimension}`);
    }

    const queryNorm = computeNorm(query);
    const distFn = this.distFn;
    const nodesArr = this.nodes;
    const getVec = this.getVec;
    let currentId = this.entryPointId;
    let currentDist = distFn(query, getVec(currentId), queryNorm, nodesArr[currentId]!.norm);

    // Greedy descent through upper layers
    for (let lc = this._maxLayer; lc > 0; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const cn = nodesArr[currentId]!;
        if (lc < cn.neighbors.length) {
          const nbrs = cn.neighbors[lc]!;
          const nLen = cn.counts[lc]!;
          for (let ni = 0; ni < nLen; ni++) {
            const nbrId = nbrs[ni]!;
            const nbrNode = nodesArr[nbrId];
            if (!nbrNode) continue;
            const d = distFn(query, getVec(nbrId), queryNorm, nbrNode.norm);
            if (d < currentDist) {
              currentId = nbrId;
              currentDist = d;
              changed = true;
            }
          }
        }
      }
    }

    // Beam search at layer 0
    const ef = Math.max(efSearch, topK);
    const candidates = this.cHeap;
    const results = this.rHeap;
    candidates.clear();
    results.clear();

    const gen = this.bumpGen();
    this.growVisited();
    const visited = this.visitedMark;
    visited[currentId] = gen;

    const epDist = distFn(query, getVec(currentId), queryNorm, nodesArr[currentId]!.norm);
    candidates.push(currentId, epDist);
    results.push(currentId, epDist);

    while (candidates.n > 0) {
      const cScore = candidates.s[0];
      if (cScore > results.s[0] && results.n >= ef) break;
      const cId = candidates.d[0];
      candidates.popDiscard();

      const cNode = nodesArr[cId];
      if (!cNode || cNode.neighbors.length === 0) continue;

      const nbrs = cNode.neighbors[0]!;
      const nLen = cNode.counts[0]!;
      for (let ni = 0; ni < nLen; ni++) {
        const nbrId = nbrs[ni]!;
        if (visited[nbrId] === gen) continue;
        visited[nbrId] = gen;

        const nbrNode = nodesArr[nbrId];
        if (!nbrNode) continue;

        const d = distFn(query, getVec(nbrId), queryNorm, nbrNode.norm);

        if (d < results.s[0] || results.n < ef) {
          candidates.push(nbrId, d);
          results.push(nbrId, d);
          if (results.n > ef) results.popDiscard();
        }
      }
    }

    // Drain max-heap to sorted array, apply filter
    const numResults = results.n;
    this.ensureDrain(numResults);
    const tempIds = this._drainIds;
    const tempScores = this._drainScores;
    for (let i = numResults - 1; i >= 0; i--) {
      tempScores[i] = results.s[0];
      tempIds[i] = results.d[0];
      results.popDiscard();
    }

    const out: ScoredResult[] = [];
    for (let i = 0; i < numResults; i++) {
      const n = nodesArr[tempIds[i]!];
      if (!n) continue;
      if (filter && !matchesFilter(n.metadata, filter)) continue;
      out.push({ key: n.key, score: tempScores[i]! });
      if (out.length >= topK) break;
    }

    return out;
  }

  getEntryPoint(): string | null {
    if (this.entryPointId === -1) return null;
    return this.nodes[this.entryPointId]?.key ?? null;
  }

  getMaxLayer(): number {
    return this._maxLayer;
  }

  // Serialization kept backward-compatible (string-based neighbor keys)
  serialize(): Uint8Array {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    const epKey = this.getEntryPoint();
    const epBytes = epKey ? encoder.encode(epKey) : new Uint8Array(0);
    const epHeader = new Uint8Array(2);
    new DataView(epHeader.buffer).setUint16(0, epBytes.byteLength, true);
    parts.push(epHeader, epBytes);

    parts.push(new Uint8Array([this._maxLayer + 128]));

    const countBuf = new Uint8Array(4);
    new DataView(countBuf.buffer).setUint32(0, this.activeCount, true);
    parts.push(countBuf);

    for (let i = 0; i < this.nextId; i++) {
      const node = this.nodes[i];
      if (!node) continue;

      const keyBytes = encoder.encode(node.key);
      const keyHeader = new Uint8Array(2);
      new DataView(keyHeader.buffer).setUint16(0, keyBytes.byteLength, true);
      parts.push(keyHeader, keyBytes);

      parts.push(new Uint8Array([node.neighbors.length]));

      for (let lc = 0; lc < node.neighbors.length; lc++) {
        const nbrs = node.neighbors[lc]!;
        const len = node.counts[lc]!;
        // Count valid neighbors first
        let validCount = 0;
        for (let ni = 0; ni < len; ni++) {
          if (this.nodes[nbrs[ni]!]) validCount++;
        }
        const nCountBuf = new Uint8Array(2);
        new DataView(nCountBuf.buffer).setUint16(0, validCount, true);
        parts.push(nCountBuf);

        for (let ni = 0; ni < len; ni++) {
          const nNode = this.nodes[nbrs[ni]!];
          if (!nNode) continue;
          const nKeyBytes = encoder.encode(nNode.key);
          const nKeyHeader = new Uint8Array(2);
          new DataView(nKeyHeader.buffer).setUint16(0, nKeyBytes.byteLength, true);
          parts.push(nKeyHeader, nKeyBytes);
        }
      }
    }

    let totalLen = 0;
    for (const p of parts) totalLen += p.byteLength;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      result.set(p, offset);
      offset += p.byteLength;
    }
    return result;
  }

  static deserialize(
    data: Uint8Array,
    offset: number,
    nodesMap: Map<string, { vector: Float32Array | null; norm: number; metadata?: Record<string, unknown>; layer?: number }>,
    dimension: number,
    metric: DistanceMetric,
    M: number,
    efConstruction: number,
  ): { index: HNSWIndex; bytesRead: number } {
    const decoder = new TextDecoder();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const startOffset = offset;

    const index = new HNSWIndex(dimension, metric, M, efConstruction);

    const epLen = view.getUint16(offset, true); offset += 2;
    const entryPointKey = epLen > 0 ? decoder.decode(data.subarray(offset, offset + epLen)) : null;
    offset += epLen;

    const maxLayer = data[offset]! - 128; offset += 1;

    const nodeCount = view.getUint32(offset, true); offset += 4;

    // First pass: create nodes and store neighbor keys
    const nodeIndices: number[] = []; // maps sequential index to internal ID
    const tempNbrKeys: string[][][] = [];

    for (let i = 0; i < nodeCount; i++) {
      const keyLen = view.getUint16(offset, true); offset += 2;
      const key = decoder.decode(data.subarray(offset, offset + keyLen)); offset += keyLen;

      const layerCount = data[offset]!; offset += 1;

      const nbrKeys: string[][] = [];
      for (let lc = 0; lc < layerCount; lc++) {
        const nCount = view.getUint16(offset, true); offset += 2;
        const layerNbrs: string[] = [];
        for (let n = 0; n < nCount; n++) {
          const nKeyLen = view.getUint16(offset, true); offset += 2;
          layerNbrs.push(decoder.decode(data.subarray(offset, offset + nKeyLen)));
          offset += nKeyLen;
        }
        nbrKeys.push(layerNbrs);
      }

      const nodeData = nodesMap.get(key);
      if (nodeData) {
        const id = index.allocId();
        const slabs = index.buildNeighborSlabs(layerCount - 1);
        index.nodes[id] = {
          key,
          vector: nodeData.vector,
          norm: nodeData.norm,
          metadata: nodeData.metadata,
          layer: layerCount - 1,
          neighbors: slabs.neighbors,
          counts: slabs.counts,
        };
        index.keyToId.set(key, id);
        index.activeCount++;
        nodeIndices.push(id);
        tempNbrKeys.push(nbrKeys);
      } else {
        tempNbrKeys.push(nbrKeys);
      }
    }

    // Second pass: resolve neighbor keys to IDs
    for (let ni = 0; ni < nodeIndices.length; ni++) {
      const id = nodeIndices[ni]!;
      const node = index.nodes[id]!;
      const nbrKeys = tempNbrKeys[ni]!;
      for (let lc = 0; lc < nbrKeys.length; lc++) {
        const layerKeys = nbrKeys[lc]!;
        const slab = node.neighbors[lc]!;
        let count = 0;
        for (let k = 0; k < layerKeys.length; k++) {
          const nId = index.keyToId.get(layerKeys[k]!);
          if (nId !== undefined && count < slab.length) {
            slab[count++] = nId;
          }
        }
        node.counts[lc] = count;
      }
    }

    if (entryPointKey !== null) {
      const epId = index.keyToId.get(entryPointKey);
      if (epId !== undefined) index.entryPointId = epId;
    }
    index._maxLayer = maxLayer;
    index.growVisited();

    return { index, bytesRead: offset - startOffset };
  }
}
