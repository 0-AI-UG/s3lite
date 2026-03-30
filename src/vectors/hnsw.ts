import type { DistanceMetric, HNSWNode, ScoredResult, MetadataFilter } from "./types";
import { computeNorm, getDistanceFn } from "./distance";
import { matchesFilter } from "./filter";

class BinaryHeap {
  private items: ScoredResult[] = [];
  constructor(private cmp: (a: ScoredResult, b: ScoredResult) => number) {}

  get size(): number { return this.items.length; }

  peek(): ScoredResult | undefined { return this.items[0]; }

  push(item: ScoredResult): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): ScoredResult | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(this.items[i]!, this.items[parent]!) < 0) {
        [this.items[i], this.items[parent]] = [this.items[parent]!, this.items[i]!];
        i = parent;
      } else break;
    }
  }

  private siftDown(i: number): void {
    const n = this.items.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.cmp(this.items[left]!, this.items[smallest]!) < 0) smallest = left;
      if (right < n && this.cmp(this.items[right]!, this.items[smallest]!) < 0) smallest = right;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest]!, this.items[i]!];
      i = smallest;
    }
  }
}

export class HNSWIndex {
  private nodes: Map<string, HNSWNode> = new Map();
  private entryPoint: string | null = null;
  private maxLayer = -1;
  private deletedCount = 0;

  readonly M: number;
  readonly M0: number;
  readonly efConstruction: number;
  readonly dimension: number;
  readonly metric: DistanceMetric;

  private mL: number;
  private distanceFn: (a: Float32Array, b: Float32Array, normA?: number, normB?: number) => number;

  constructor(dimension: number, metric: DistanceMetric = "cosine", M = 16, efConstruction = 200) {
    this.dimension = dimension;
    this.metric = metric;
    this.M = M;
    this.M0 = M * 2;
    this.efConstruction = efConstruction;
    this.mL = 1 / Math.log(M);
    this.distanceFn = getDistanceFn(metric);
  }

  get size(): number {
    return this.nodes.size - this.deletedCount;
  }

  private randomLayer(): number {
    const r = Math.random() || Number.MIN_VALUE;
    const raw = Math.floor(-Math.log(r) * this.mL);
    const maxAllowed = Math.max(16, Math.floor(Math.log2(this.nodes.size + 2) * 2));
    return Math.min(raw, maxAllowed);
  }

  private dist(a: Float32Array, b: Float32Array, normA?: number, normB?: number): number {
    return this.distanceFn(a, b, normA, normB);
  }

  getNode(key: string): HNSWNode | undefined {
    return this.nodes.get(key);
  }

  allNodes(): IterableIterator<HNSWNode> {
    return this.nodes.values();
  }

  insert(key: string, vector: Float32Array, metadata?: Record<string, unknown>): void {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension ${vector.length} does not match index dimension ${this.dimension}`);
    }

    // If key already exists, remove old entry first
    if (this.nodes.has(key)) {
      this.remove(key);
    }

    const norm = computeNorm(vector);
    const layer = this.randomLayer();
    const node: HNSWNode = {
      key,
      vector,
      norm,
      metadata,
      layer,
      neighbors: Array.from({ length: layer + 1 }, () => new Set<string>()),
      deleted: false,
    };

    this.nodes.set(key, node);

    if (this.entryPoint === null) {
      this.entryPoint = key;
      this.maxLayer = layer;
      return;
    }

    const ep = this.nodes.get(this.entryPoint)!;
    let currentKey = this.entryPoint;
    let currentDist = this.dist(vector, ep.vector, norm, ep.norm);

    // Greedy descent through layers above insertion layer
    for (let lc = this.maxLayer; lc > layer; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const currentNode = this.nodes.get(currentKey)!;
        if (lc < currentNode.neighbors.length) {
          for (const neighborKey of currentNode.neighbors[lc]!) {
            const neighbor = this.nodes.get(neighborKey);
            if (!neighbor || neighbor.deleted) continue;
            const d = this.dist(vector, neighbor.vector, norm, neighbor.norm);
            if (d < currentDist) {
              currentKey = neighborKey;
              currentDist = d;
              changed = true;
            }
          }
        }
      }
    }

    // Insert at each layer from min(layer, maxLayer) down to 0
    for (let lc = Math.min(layer, this.maxLayer); lc >= 0; lc--) {
      const candidates = this.searchLayer(vector, norm, currentKey, this.efConstruction, lc);
      const neighbors = this.selectNeighbors(vector, norm, candidates, lc === 0 ? this.M0 : this.M);

      // Connect node to selected neighbors (bidirectional)
      for (const { key: nKey } of neighbors) {
        node.neighbors[lc]!.add(nKey);
        const nNode = this.nodes.get(nKey)!;
        if (lc < nNode.neighbors.length) {
          nNode.neighbors[lc]!.add(key);
          // Prune if over capacity
          const maxConn = lc === 0 ? this.M0 : this.M;
          if (nNode.neighbors[lc]!.size > maxConn) {
            this.pruneConnections(nNode, lc, maxConn);
          }
        }
      }

      if (candidates.length > 0) {
        currentKey = candidates[0]!.key;
      }
    }

    if (layer > this.maxLayer) {
      this.maxLayer = layer;
      this.entryPoint = key;
    }
  }

  private searchLayer(
    query: Float32Array,
    queryNorm: number,
    entryKey: string,
    ef: number,
    layer: number,
  ): ScoredResult[] {
    const entryNode = this.nodes.get(entryKey);
    if (!entryNode) return [];

    const visited = new Set<string>([entryKey]);
    const entryDist = this.dist(query, entryNode.vector, queryNorm, entryNode.norm);

    const candidates = new BinaryHeap((a, b) => a.score - b.score);  // min-heap
    const results = new BinaryHeap((a, b) => b.score - a.score);     // max-heap
    candidates.push({ key: entryKey, score: entryDist });
    results.push({ key: entryKey, score: entryDist });

    while (candidates.size > 0) {
      const current = candidates.pop()!;
      const worstDist = results.peek()!.score;

      if (current.score > worstDist && results.size >= ef) break;

      const currentNode = this.nodes.get(current.key);
      if (!currentNode || layer >= currentNode.neighbors.length) continue;

      for (const neighborKey of currentNode.neighbors[layer]!) {
        if (visited.has(neighborKey)) continue;
        visited.add(neighborKey);

        const neighbor = this.nodes.get(neighborKey);
        if (!neighbor || neighbor.deleted) continue;

        const d = this.dist(query, neighbor.vector, queryNorm, neighbor.norm);
        const worstResult = results.peek()!.score;

        if (d < worstResult || results.size < ef) {
          candidates.push({ key: neighborKey, score: d });
          results.push({ key: neighborKey, score: d });
          if (results.size > ef) results.pop();
        }
      }
    }

    // Drain max-heap into sorted array (ascending)
    const out: ScoredResult[] = [];
    while (results.size > 0) out.push(results.pop()!);
    out.reverse();
    return out;
  }

  private selectNeighbors(
    query: Float32Array,
    queryNorm: number,
    candidates: ScoredResult[],
    M: number,
  ): ScoredResult[] {
    if (candidates.length <= M) return candidates;

    // Heuristic: prefer diverse neighbors
    const selected: ScoredResult[] = [];
    const remaining = [...candidates];
    remaining.sort((a, b) => a.score - b.score);

    for (const candidate of remaining) {
      if (selected.length >= M) break;

      const cNode = this.nodes.get(candidate.key);
      if (!cNode || cNode.deleted) continue;

      // Keep if closer to query than to any already-selected neighbor
      let tooClose = false;
      for (const s of selected) {
        const sNode = this.nodes.get(s.key)!;
        const distBetween = this.dist(cNode.vector, sNode.vector, cNode.norm, sNode.norm);
        if (distBetween < candidate.score) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        selected.push(candidate);
      }
    }

    // If heuristic didn't fill M slots, add closest remaining
    if (selected.length < M) {
      const selectedKeys = new Set(selected.map(s => s.key));
      for (const c of remaining) {
        if (selected.length >= M) break;
        if (!selectedKeys.has(c.key)) {
          selected.push(c);
        }
      }
    }

    return selected;
  }

  private pruneConnections(node: HNSWNode, layer: number, maxConn: number): void {
    const neighbors = node.neighbors[layer]!;
    if (neighbors.size <= maxConn) return;

    // Score all neighbors by distance to node
    const scored: ScoredResult[] = [];
    for (const nKey of neighbors) {
      const nNode = this.nodes.get(nKey);
      if (!nNode || nNode.deleted) continue;
      scored.push({ key: nKey, score: this.dist(node.vector, nNode.vector, node.norm, nNode.norm) });
    }

    const selected = this.selectNeighbors(node.vector, node.norm, scored, maxConn);
    const keep = new Set(selected.map(s => s.key));

    for (const nKey of [...neighbors]) {
      if (!keep.has(nKey)) {
        neighbors.delete(nKey);
      }
    }
  }

  remove(key: string): boolean {
    const node = this.nodes.get(key);
    if (!node || node.deleted) return false;

    node.deleted = true;
    this.deletedCount++;

    // Remove from neighbors' adjacency lists
    for (let lc = 0; lc < node.neighbors.length; lc++) {
      for (const nKey of node.neighbors[lc]!) {
        const nNode = this.nodes.get(nKey);
        if (nNode && lc < nNode.neighbors.length) {
          nNode.neighbors[lc]!.delete(key);
        }
      }
    }

    // If entry point was deleted, find a new one
    if (this.entryPoint === key) {
      this.entryPoint = null;
      for (const [k, n] of this.nodes) {
        if (!n.deleted) {
          if (this.entryPoint === null || n.layer > this.nodes.get(this.entryPoint)!.layer) {
            this.entryPoint = k;
          }
        }
      }
      this.maxLayer = this.entryPoint !== null ? this.nodes.get(this.entryPoint)!.layer : -1;
    }

    // Clean up fully
    this.nodes.delete(key);
    this.deletedCount--;

    return true;
  }

  search(
    query: Float32Array,
    topK: number,
    efSearch = 64,
    filter?: MetadataFilter,
  ): ScoredResult[] {
    if (this.entryPoint === null) return [];
    if (query.length !== this.dimension) {
      throw new Error(`Query dimension ${query.length} does not match index dimension ${this.dimension}`);
    }

    const queryNorm = computeNorm(query);
    let currentKey = this.entryPoint;
    const ep = this.nodes.get(currentKey)!;
    let currentDist = this.dist(query, ep.vector, queryNorm, ep.norm);

    // Greedy descent through upper layers
    for (let lc = this.maxLayer; lc > 0; lc--) {
      let changed = true;
      while (changed) {
        changed = false;
        const currentNode = this.nodes.get(currentKey)!;
        if (lc < currentNode.neighbors.length) {
          for (const neighborKey of currentNode.neighbors[lc]!) {
            const neighbor = this.nodes.get(neighborKey);
            if (!neighbor || neighbor.deleted) continue;
            const d = this.dist(query, neighbor.vector, queryNorm, neighbor.norm);
            if (d < currentDist) {
              currentKey = neighborKey;
              currentDist = d;
              changed = true;
            }
          }
        }
      }
    }

    // Beam search at layer 0
    const candidates = this.searchLayer(query, queryNorm, currentKey, Math.max(efSearch, topK), 0);

    // Apply filter and collect topK
    const results: ScoredResult[] = [];
    for (const c of candidates) {
      const node = this.nodes.get(c.key);
      if (!node || node.deleted) continue;
      if (filter && !matchesFilter(node.metadata, filter)) continue;
      results.push(c);
      if (results.length >= topK) break;
    }

    return results;
  }

  getEntryPoint(): string | null {
    return this.entryPoint;
  }

  getMaxLayer(): number {
    return this.maxLayer;
  }

  serialize(): Uint8Array {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    // Entry point
    const epBytes = this.entryPoint ? encoder.encode(this.entryPoint) : new Uint8Array(0);
    const epHeader = new Uint8Array(2);
    new DataView(epHeader.buffer).setUint16(0, epBytes.byteLength, true);
    parts.push(epHeader, epBytes);

    // Max layer
    parts.push(new Uint8Array([this.maxLayer + 128])); // offset by 128 to handle -1

    // Node count
    const countBuf = new Uint8Array(4);
    new DataView(countBuf.buffer).setUint32(0, this.nodes.size, true);
    parts.push(countBuf);

    // Each node: key + layer count + neighbor lists
    for (const [key, node] of this.nodes) {
      const keyBytes = encoder.encode(key);
      const keyHeader = new Uint8Array(2);
      new DataView(keyHeader.buffer).setUint16(0, keyBytes.byteLength, true);
      parts.push(keyHeader, keyBytes);

      // Layer count
      parts.push(new Uint8Array([node.neighbors.length]));

      for (let lc = 0; lc < node.neighbors.length; lc++) {
        const neighbors = node.neighbors[lc]!;
        const nCountBuf = new Uint8Array(2);
        new DataView(nCountBuf.buffer).setUint16(0, neighbors.size, true);
        parts.push(nCountBuf);

        for (const nKey of neighbors) {
          const nKeyBytes = encoder.encode(nKey);
          const nKeyHeader = new Uint8Array(2);
          new DataView(nKeyHeader.buffer).setUint16(0, nKeyBytes.byteLength, true);
          parts.push(nKeyHeader, nKeyBytes);
        }
      }
    }

    // Concatenate
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
    nodesMap: Map<string, { vector: Float32Array; norm: number; metadata?: Record<string, unknown>; layer?: number }>,
    dimension: number,
    metric: DistanceMetric,
    M: number,
    efConstruction: number,
  ): { index: HNSWIndex; bytesRead: number } {
    const decoder = new TextDecoder();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const startOffset = offset;

    const index = new HNSWIndex(dimension, metric, M, efConstruction);

    // Entry point
    const epLen = view.getUint16(offset, true);
    offset += 2;
    const entryPoint = epLen > 0 ? decoder.decode(data.subarray(offset, offset + epLen)) : null;
    offset += epLen;

    // Max layer
    const maxLayer = data[offset]! - 128;
    offset += 1;

    // Node count
    const nodeCount = view.getUint32(offset, true);
    offset += 4;

    // Rebuild nodes with topology
    for (let i = 0; i < nodeCount; i++) {
      const keyLen = view.getUint16(offset, true);
      offset += 2;
      const key = decoder.decode(data.subarray(offset, offset + keyLen));
      offset += keyLen;

      const layerCount = data[offset]!;
      offset += 1;

      const neighbors: Set<string>[] = [];
      for (let lc = 0; lc < layerCount; lc++) {
        const nCount = view.getUint16(offset, true);
        offset += 2;
        const neighborSet = new Set<string>();
        for (let n = 0; n < nCount; n++) {
          const nKeyLen = view.getUint16(offset, true);
          offset += 2;
          const nKey = decoder.decode(data.subarray(offset, offset + nKeyLen));
          offset += nKeyLen;
          neighborSet.add(nKey);
        }
        neighbors.push(neighborSet);
      }

      // Get vector data from nodesMap
      const nodeData = nodesMap.get(key);
      if (nodeData) {
        const node: HNSWNode = {
          key,
          vector: nodeData.vector,
          norm: nodeData.norm,
          metadata: nodeData.metadata,
          layer: layerCount - 1,
          neighbors,
          deleted: false,
        };
        index.nodes.set(key, node);
      }
    }

    index.entryPoint = entryPoint;
    index.maxLayer = maxLayer;

    return { index, bytesRead: offset - startOffset };
  }
}
