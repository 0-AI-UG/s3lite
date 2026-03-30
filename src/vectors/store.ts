import type {
  VectorIndexConfig,
  CreateIndexOptions,
  PutVectorInput,
  GetVectorResponse,
  QueryOptions,
  QueryResponse,
  QueryResult,
  ListVectorsOptions,
  ListVectorsResponse,
  ListIndexesResponse,
  StoredVectorMeta,
  ScoredResult,
  VectorEventType,
  VectorEventCallback,
  MetadataFilter,
} from "./types";
import { HNSWIndex } from "./hnsw";
import { SparseIndex } from "./sparse";
import { matchesFilter } from "./filter";
import { VectorWAL } from "./wal";

interface IndexEntry {
  config: VectorIndexConfig;
  hnsw: HNSWIndex;
  sparse: SparseIndex | null;
  vectors: Map<string, StoredVectorMeta>;
}

export class VectorStore {
  private indexes: Map<string, IndexEntry> = new Map();
  private wal: VectorWAL | null = null;
  private listeners: Map<VectorEventType, Set<VectorEventCallback>> = new Map();

  constructor(path?: string, syncMode: "full" | "normal" | "off" = "normal") {
    if (path) {
      this.wal = new VectorWAL(path, syncMode);
      this.wal.open(this);
    }
  }

  // === Index Operations ===

  createIndex(opts: CreateIndexOptions): VectorIndexConfig {
    if (this.indexes.has(opts.name)) {
      throw new Error(`Index already exists: ${opts.name}`);
    }

    const M = opts.hnswConfig?.M ?? 16;
    const efConstruction = opts.hnswConfig?.efConstruction ?? 200;
    const distanceMetric = opts.distanceMetric ?? "cosine";
    const sparse = opts.sparse ?? false;

    const config: VectorIndexConfig = {
      name: opts.name,
      dimension: opts.dimension,
      distanceMetric,
      sparse,
      hnswConfig: { M, efConstruction },
      createdAt: new Date(),
    };

    const hnsw = new HNSWIndex(opts.dimension, distanceMetric, M, efConstruction);
    const sparseIdx = sparse ? new SparseIndex() : null;

    this.indexes.set(opts.name, { config, hnsw, sparse: sparseIdx, vectors: new Map() });
    this.wal?.appendCreateIndex(config);
    this.emit("createIndex", opts.name);
    return config;
  }

  // Internal: create index without WAL (used during replay)
  _createIndexInternal(config: VectorIndexConfig): void {
    if (this.indexes.has(config.name)) return;
    const hnsw = new HNSWIndex(config.dimension, config.distanceMetric, config.hnswConfig.M, config.hnswConfig.efConstruction);
    const sparseIdx = config.sparse ? new SparseIndex() : null;
    this.indexes.set(config.name, { config, hnsw, sparse: sparseIdx, vectors: new Map() });
  }

  // Internal: delete index without WAL (used during replay)
  _deleteIndexInternal(name: string): void {
    this.indexes.delete(name);
  }

  getIndex(name: string): VectorIndexConfig | undefined {
    return this.indexes.get(name)?.config;
  }

  deleteIndex(name: string): boolean {
    const existed = this.indexes.delete(name);
    if (existed) {
      this.wal?.appendDeleteIndex(name);
      this.emit("deleteIndex", name);
    }
    return existed;
  }

  listIndexes(): ListIndexesResponse {
    return { indexes: [...this.indexes.values()].map(e => e.config) };
  }

  // === Vector Operations ===

  putVectors(indexName: string, inputs: PutVectorInput[]): void {
    const entry = this.getEntry(indexName);
    const keys: string[] = [];

    for (const input of inputs) {
      const vector = input.vector ? toFloat32Array(input.vector) : undefined;

      if (vector && vector.length !== entry.config.dimension) {
        throw new Error(`Vector dimension ${vector.length} does not match index dimension ${entry.config.dimension}`);
      }
      if (input.sparseVector && !entry.sparse) {
        throw new Error(`Index "${indexName}" does not have sparse support enabled`);
      }

      // Store metadata
      entry.vectors.set(input.key, {
        key: input.key,
        metadata: input.metadata,
        sparseVector: input.sparseVector,
      });

      // Insert into HNSW
      if (vector) {
        entry.hnsw.insert(input.key, vector, input.metadata);
      }

      // Insert into sparse index
      if (input.sparseVector && entry.sparse) {
        entry.sparse.insert(input.key, input.sparseVector);
      }

      this.wal?.appendPutVector(indexName, input.key, vector ?? null, input.metadata, input.sparseVector);
      keys.push(input.key);
    }

    this.emit("putVectors", indexName, keys);
  }

  // Internal: put vector without WAL (used during replay)
  _putVectorInternal(indexName: string, key: string, vector: Float32Array | null, metadata?: Record<string, unknown>, sparseVector?: { indices: number[]; values: number[] }, skipHNSW = false): void {
    const entry = this.indexes.get(indexName);
    if (!entry) return;

    entry.vectors.set(key, { key, metadata, sparseVector });
    if (vector && !skipHNSW) entry.hnsw.insert(key, vector, metadata);
    if (sparseVector && entry.sparse) entry.sparse.insert(key, sparseVector);
  }

  // Internal: replace the HNSW index for a given index entry (used after graph deserialization)
  _setHNSW(indexName: string, hnsw: HNSWIndex): void {
    const entry = this.indexes.get(indexName);
    if (!entry) return;
    entry.hnsw = hnsw;
  }

  getVectors(indexName: string, keys: string[]): GetVectorResponse[] {
    const entry = this.getEntry(indexName);
    const results: GetVectorResponse[] = [];

    for (const key of keys) {
      const meta = entry.vectors.get(key);
      if (!meta) continue;

      const node = entry.hnsw.getNode(key);
      const response: GetVectorResponse = {
        key,
        vector: node?.vector,
        metadata: meta.metadata,
        sparseVector: meta.sparseVector,
      };
      results.push(response);
    }

    return results;
  }

  deleteVectors(indexName: string, keys: string[]): number {
    const entry = this.getEntry(indexName);
    let deleted = 0;

    for (const key of keys) {
      if (entry.vectors.delete(key)) {
        entry.hnsw.remove(key);
        entry.sparse?.remove(key);
        this.wal?.appendDeleteVector(indexName, key);
        deleted++;
      }
    }

    if (deleted > 0) {
      this.emit("deleteVectors", indexName, keys);
    }
    return deleted;
  }

  // Internal: delete vector without WAL (used during replay)
  _deleteVectorInternal(indexName: string, key: string): void {
    const entry = this.indexes.get(indexName);
    if (!entry) return;
    entry.vectors.delete(key);
    entry.hnsw.remove(key);
    entry.sparse?.remove(key);
  }

  listVectors(indexName: string, opts?: ListVectorsOptions): ListVectorsResponse {
    const entry = this.getEntry(indexName);
    const prefix = opts?.prefix ?? "";
    const maxKeys = opts?.maxKeys ?? 1000;
    const startAfter = opts?.startAfter;

    let keys = [...entry.vectors.keys()]
      .filter(k => k.startsWith(prefix))
      .sort();

    if (startAfter) {
      keys = keys.filter(k => k > startAfter);
    }

    const isTruncated = keys.length > maxKeys;
    const truncated = keys.slice(0, maxKeys);

    return {
      keys: truncated,
      isTruncated,
      nextStartAfter: isTruncated ? truncated[truncated.length - 1] : undefined,
    };
  }

  // === Query ===

  query(indexName: string, opts: QueryOptions): QueryResponse {
    const entry = this.getEntry(indexName);
    const hasDense = opts.vector !== undefined;
    const hasSparse = opts.sparseVector !== undefined;

    if (!hasDense && !hasSparse) {
      throw new Error("Query must include at least one of vector or sparseVector");
    }

    if (hasDense && hasSparse) {
      return this.hybridQuery(entry, opts);
    } else if (hasDense) {
      return this.denseQuery(entry, opts);
    } else {
      return this.sparseQuery(entry, opts);
    }
  }

  private denseQuery(entry: IndexEntry, opts: QueryOptions): QueryResponse {
    const query = toFloat32Array(opts.vector!);
    const efSearch = opts.efSearch ?? 64;
    const scored = entry.hnsw.search(query, opts.topK, efSearch, opts.filter);
    return this.buildResponse(entry, scored, opts);
  }

  private sparseQuery(entry: IndexEntry, opts: QueryOptions): QueryResponse {
    if (!entry.sparse) {
      throw new Error(`Index "${entry.config.name}" does not have sparse support enabled`);
    }

    const filterFn = opts.filter
      ? (key: string) => matchesFilter(entry.vectors.get(key)?.metadata, opts.filter!)
      : undefined;

    const scored = entry.sparse.search(opts.sparseVector!, opts.topK, filterFn);
    return this.buildResponse(entry, scored, opts);
  }

  private hybridQuery(entry: IndexEntry, opts: QueryOptions): QueryResponse {
    if (!entry.sparse) {
      throw new Error(`Index "${entry.config.name}" does not have sparse support enabled`);
    }

    const fetchK = opts.topK * 2;
    const fusionK = opts.fusionK ?? 60;

    // Dense search
    const query = toFloat32Array(opts.vector!);
    const efSearch = opts.efSearch ?? 64;
    const denseResults = entry.hnsw.search(query, fetchK, efSearch, opts.filter);

    // Sparse search
    const filterFn = opts.filter
      ? (key: string) => matchesFilter(entry.vectors.get(key)?.metadata, opts.filter!)
      : undefined;
    const sparseResults = entry.sparse.search(opts.sparseVector!, fetchK, filterFn);

    // RRF fusion
    const rrfScores = new Map<string, number>();

    for (let i = 0; i < denseResults.length; i++) {
      const key = denseResults[i]!.key;
      rrfScores.set(key, (rrfScores.get(key) ?? 0) + 1 / (fusionK + i + 1));
    }

    for (let i = 0; i < sparseResults.length; i++) {
      const key = sparseResults[i]!.key;
      rrfScores.set(key, (rrfScores.get(key) ?? 0) + 1 / (fusionK + i + 1));
    }

    const fused: ScoredResult[] = [...rrfScores.entries()]
      .map(([key, score]) => ({ key, score: -score })) // negate so lower = better
      .sort((a, b) => a.score - b.score)
      .slice(0, opts.topK);

    return this.buildResponse(entry, fused, opts);
  }

  private buildResponse(entry: IndexEntry, scored: ScoredResult[], opts: QueryOptions): QueryResponse {
    const includeMetadata = opts.includeMetadata !== false;
    const includeVectors = opts.includeVectors === true;

    const results: QueryResult[] = scored.map(s => {
      const result: QueryResult = { key: s.key, score: s.score };

      if (includeMetadata) {
        result.metadata = entry.vectors.get(s.key)?.metadata;
      }
      if (includeVectors) {
        const node = entry.hnsw.getNode(s.key);
        if (node) result.vector = node.vector;
        if (entry.sparse) {
          result.sparseVector = entry.vectors.get(s.key)?.sparseVector;
        }
      }

      return result;
    });

    return { results };
  }

  // === Events ===

  on(event: VectorEventType, callback: VectorEventCallback): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: VectorEventType, callback: VectorEventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: VectorEventType, indexName: string, keys?: string[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) cb(indexName, keys);
    }
  }

  // === Lifecycle ===

  checkpoint(): void {
    this.wal?.checkpoint(this);
  }

  close(): void {
    this.wal?.close(this);
  }

  // === Helpers ===

  private getEntry(indexName: string): IndexEntry {
    const entry = this.indexes.get(indexName);
    if (!entry) throw new Error(`Index not found: ${indexName}`);
    return entry;
  }

  // Used by WAL for checkpointing
  _getAllIndexEntries(): Map<string, IndexEntry> {
    return this.indexes;
  }
}

function toFloat32Array(v: number[] | Float32Array): Float32Array {
  return v instanceof Float32Array ? v : new Float32Array(v);
}
