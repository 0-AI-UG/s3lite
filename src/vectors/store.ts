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
import { computeNorm } from "./distance";
import { ReadonlyError } from "../types";
import { Store } from "../store";
import { VectorCache } from "./vector-cache";

interface IndexEntry {
  config: VectorIndexConfig;
  hnsw: HNSWIndex;
  sparse: SparseIndex | null;
  vectors: Map<string, StoredVectorMeta>;
  sortedKeysCache: string[] | null;
}

export class VectorStore {
  private indexes: Map<string, IndexEntry> = new Map();
  private wal: VectorWAL | null = null;
  private listeners: Map<VectorEventType, Set<VectorEventCallback>> = new Map();
  private readOnly: boolean;
  private diskMode: boolean;
  private s3Store: Store | null = null;
  private vectorCache: VectorCache | null = null;

  constructor(path?: string, syncMode: "full" | "normal" | "off" = "normal", readOnly = false, storage: "memory" | "disk" = "memory", diskCacheSize = 10_000) {
    this.readOnly = readOnly;
    this.diskMode = storage === "disk";

    if (this.diskMode) {
      if (!path) throw new Error("storage: 'disk' requires a path");
      this.s3Store = new Store(path + "-vdata", syncMode, "memory", readOnly);
      this.vectorCache = new VectorCache(diskCacheSize);
    }

    if (path) {
      this.wal = new VectorWAL(path, syncMode, undefined, readOnly, this.diskMode, this.s3Store);
      this.wal.open(this);

      // In disk mode, set up vector providers for all indexes loaded during WAL replay
      if (this.diskMode) {
        for (const [indexName, entry] of this.indexes) {
          this.setupVectorProvider(indexName, entry);
        }
      }
    }
  }

  /** Set up a disk-backed vector provider for an HNSW index. */
  private setupVectorProvider(indexName: string, entry: IndexEntry): void {
    entry.hnsw.setVectorProvider((id: number) => {
      const node = entry.hnsw.getNodeById(id);
      if (!node) throw new Error(`Node ${id} not found`);
      // If vector is still in memory (e.g. during insert), use it
      if (node.vector) return node.vector;
      return this.getVectorFromDisk(indexName, node.key);
    });
  }

  /** Read a vector from LRU cache or S3 Store. */
  private getVectorFromDisk(indexName: string, key: string): Float32Array {
    // Check cache
    const cached = this.vectorCache!.get(indexName, key);
    if (cached) return cached;

    // Read from S3 Store
    const obj = this.s3Store!.get(indexName, key);
    if (!obj?.data) throw new Error(`Vector data not found in store: ${indexName}/${key}`);
    const vec = new Float32Array(obj.data.buffer, obj.data.byteOffset, obj.data.byteLength / 4);
    this.vectorCache!.set(indexName, key, vec);
    return vec;
  }

  // === Index Operations ===

  createIndex(opts: CreateIndexOptions): VectorIndexConfig {
    if (this.readOnly) throw new ReadonlyError("createIndex");
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

    const entry: IndexEntry = { config, hnsw, sparse: sparseIdx, vectors: new Map(), sortedKeysCache: null };
    this.indexes.set(opts.name, entry);
    if (this.diskMode) this.setupVectorProvider(opts.name, entry);
    this.wal?.appendCreateIndex(config);
    this.emit("createIndex", opts.name);
    return config;
  }

  // Internal: create index without WAL (used during replay)
  _createIndexInternal(config: VectorIndexConfig): void {
    if (this.indexes.has(config.name)) return;
    const hnsw = new HNSWIndex(config.dimension, config.distanceMetric, config.hnswConfig.M, config.hnswConfig.efConstruction);
    const sparseIdx = config.sparse ? new SparseIndex() : null;
    const entry: IndexEntry = { config, hnsw, sparse: sparseIdx, vectors: new Map(), sortedKeysCache: null };
    this.indexes.set(config.name, entry);
    if (this.diskMode) this.setupVectorProvider(config.name, entry);
  }

  // Internal: delete index without WAL (used during replay)
  _deleteIndexInternal(name: string): void {
    this.indexes.delete(name);
  }

  getIndex(name: string): VectorIndexConfig | undefined {
    return this.indexes.get(name)?.config;
  }

  deleteIndex(name: string): boolean {
    if (this.readOnly) throw new ReadonlyError("deleteIndex");
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
    if (this.readOnly) throw new ReadonlyError("putVectors");
    const entry = this.getEntry(indexName);
    entry.sortedKeysCache = null;
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

      let norm: number | undefined;

      if (this.diskMode && vector) {
        // Disk mode: write vector to S3 Store first
        const data = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        this.s3Store!.put(indexName, input.key, data);
        norm = computeNorm(vector);

        // Insert into HNSW (needs vector temporarily for graph construction)
        entry.hnsw.insert(input.key, vector, input.metadata);
        // Null out in-memory vector, it's on disk now
        entry.hnsw.clearNodeVector(input.key);
        // Cache it (likely to be queried soon)
        this.vectorCache!.set(indexName, input.key, vector);
      } else if (vector) {
        // Memory mode: insert into HNSW as before
        entry.hnsw.insert(input.key, vector, input.metadata);
      }

      // Insert into sparse index
      if (input.sparseVector && entry.sparse) {
        entry.sparse.insert(input.key, input.sparseVector);
      }

      this.wal?.appendPutVector(indexName, input.key, vector ?? null, input.metadata, input.sparseVector, norm);
      keys.push(input.key);
    }

    this.emit("putVectors", indexName, keys);
  }

  // Internal: put vector without WAL (used during replay)
  _putVectorInternal(indexName: string, key: string, vector: Float32Array | null, metadata?: Record<string, unknown>, sparseVector?: { indices: number[]; values: number[] }, skipHNSW = false): void {
    const entry = this.indexes.get(indexName);
    if (!entry) return;

    entry.vectors.set(key, { key, metadata, sparseVector });
    entry.sortedKeysCache = null;

    if (vector && !skipHNSW) {
      entry.hnsw.insert(key, vector, metadata);
      // In disk mode, clear the in-memory vector after HNSW insertion
      if (this.diskMode) {
        entry.hnsw.clearNodeVector(key);
      }
    }
    if (sparseVector && entry.sparse) entry.sparse.insert(key, sparseVector);
  }

  // Internal: replace the HNSW index for a given index entry (used after graph deserialization)
  _setHNSW(indexName: string, hnsw: HNSWIndex): void {
    const entry = this.indexes.get(indexName);
    if (!entry) return;
    entry.hnsw = hnsw;
    if (this.diskMode) this.setupVectorProvider(indexName, entry);
  }

  getVectors(indexName: string, keys: string[]): GetVectorResponse[] {
    const entry = this.getEntry(indexName);
    const results: GetVectorResponse[] = [];

    for (const key of keys) {
      const meta = entry.vectors.get(key);
      if (!meta) continue;

      let vector: Float32Array | undefined;
      if (this.diskMode) {
        try {
          vector = this.getVectorFromDisk(indexName, key);
        } catch {
          // Vector may not have dense data (sparse-only)
        }
      } else {
        const node = entry.hnsw.getNode(key);
        vector = node?.vector ?? undefined;
      }

      const response: GetVectorResponse = {
        key,
        vector,
        metadata: meta.metadata,
        sparseVector: meta.sparseVector,
      };
      results.push(response);
    }

    return results;
  }

  deleteVectors(indexName: string, keys: string[]): number {
    if (this.readOnly) throw new ReadonlyError("deleteVectors");
    const entry = this.getEntry(indexName);
    entry.sortedKeysCache = null;
    let deleted = 0;

    for (const key of keys) {
      if (entry.vectors.delete(key)) {
        entry.hnsw.remove(key);
        entry.sparse?.remove(key);
        if (this.diskMode) {
          this.vectorCache!.delete(indexName, key);
          this.s3Store!.delete(indexName, key);
        }
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
    entry.sortedKeysCache = null;
    entry.hnsw.remove(key);
    entry.sparse?.remove(key);
    if (this.diskMode) {
      this.vectorCache!.delete(indexName, key);
    }
  }

  listVectors(indexName: string, opts?: ListVectorsOptions): ListVectorsResponse {
    const entry = this.getEntry(indexName);
    const prefix = opts?.prefix ?? "";
    const maxKeys = opts?.maxKeys ?? 1000;
    const startAfter = opts?.startAfter;

    if (!entry.sortedKeysCache) {
      entry.sortedKeysCache = [...entry.vectors.keys()].sort();
    }
    let keys = entry.sortedKeysCache.filter(k => k.startsWith(prefix));

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

    // Sparse search — reduce fetch if dense returned fewer than topK
    const sparseFetchK = denseResults.length < opts.topK ? opts.topK : fetchK;
    const filterFn = opts.filter
      ? (key: string) => matchesFilter(entry.vectors.get(key)?.metadata, opts.filter!)
      : undefined;
    const sparseResults = entry.sparse.search(opts.sparseVector!, sparseFetchK, filterFn);

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
        if (this.diskMode) {
          try {
            result.vector = this.getVectorFromDisk(entry.config.name, s.key);
          } catch { /* sparse-only vector */ }
        } else {
          const node = entry.hnsw.getNode(s.key);
          if (node?.vector) result.vector = node.vector;
        }
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
    if (this.readOnly) throw new ReadonlyError("checkpoint");
    this.wal?.checkpoint(this);
  }

  close(): void {
    this.wal?.close(this);
    if (this.s3Store) {
      this.s3Store.close();
    }
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
