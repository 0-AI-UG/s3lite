// === Distance Metrics ===
export type DistanceMetric = "cosine" | "euclidean" | "dotproduct";

// === HNSW Configuration ===
export interface HNSWConfig {
  M?: number;
  efConstruction?: number;
}

// === Index Configuration ===
export interface VectorIndexConfig {
  name: string;
  dimension: number;
  distanceMetric: DistanceMetric;
  sparse: boolean;
  hnswConfig: { M: number; efConstruction: number };
  createdAt: Date;
}

export interface CreateIndexOptions {
  name: string;
  dimension: number;
  distanceMetric?: DistanceMetric;
  sparse?: boolean;
  hnswConfig?: HNSWConfig;
}

// === Sparse Vectors ===
export interface SparseVector {
  indices: number[];
  values: number[];
}

// === Vector Operations ===
export interface PutVectorInput {
  key: string;
  vector?: number[] | Float32Array;
  sparseVector?: SparseVector;
  metadata?: Record<string, unknown>;
}

export interface GetVectorResponse {
  key: string;
  vector?: Float32Array;
  sparseVector?: SparseVector;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  vector?: number[] | Float32Array;
  sparseVector?: SparseVector;
  topK: number;
  efSearch?: number;
  filter?: MetadataFilter;
  fusionK?: number;
  includeVectors?: boolean;
  includeMetadata?: boolean;
}

export interface QueryResult {
  key: string;
  score: number;
  vector?: Float32Array;
  sparseVector?: SparseVector;
  metadata?: Record<string, unknown>;
}

export interface QueryResponse {
  results: QueryResult[];
}

export interface ListVectorsOptions {
  prefix?: string;
  maxKeys?: number;
  startAfter?: string;
}

export interface ListVectorsResponse {
  keys: string[];
  isTruncated: boolean;
  nextStartAfter?: string;
}

export interface ListIndexesResponse {
  indexes: VectorIndexConfig[];
}

// === Metadata Filtering ===
export type MetadataFilter = {
  [key: string]: FilterValue | FilterOperator;
};

export type FilterValue = string | number | boolean;

export interface FilterOperator {
  $eq?: FilterValue;
  $ne?: FilterValue;
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $in?: FilterValue[];
  $nin?: FilterValue[];
}

// === Stored Vector (internal) ===
export interface StoredVectorMeta {
  key: string;
  metadata?: Record<string, unknown>;
  sparseVector?: SparseVector;
}

// === WAL ===
export const enum VectorWalOp {
  CREATE_INDEX = 1,
  DELETE_INDEX = 2,
  PUT_VECTOR = 3,
  DELETE_VECTOR = 4,
}

export const VECTOR_MAGIC = new Uint8Array([0x56, 0x45, 0x43, 0x54]); // "VECT"
export const VECTOR_FORMAT_VERSION = 2;
export const GRAPH_MARKER = new Uint8Array([0x47, 0x52, 0x50, 0x48]); // "GRPH"

// === Events ===
export type VectorEventType = "putVectors" | "deleteVectors" | "createIndex" | "deleteIndex";
export type VectorEventCallback = (indexName: string, keys?: string[]) => void;

// === Client Options ===
export interface VectorClientOptions {
  path?: string;
  syncMode?: "full" | "normal" | "off";
  /** Open in read-only mode. No file lock is acquired and all write operations throw. */
  readonly?: boolean;
  /** Storage mode: "memory" keeps all vectors in RAM (default), "disk" stores vector data in an internal S3 Store. */
  storage?: "memory" | "disk";
  /** Number of vectors to keep in the LRU cache when using disk storage. Default: 10000. */
  diskCacheSize?: number;
  /** Byte budget for the disk-mode vector LRU cache. When set, evicts by bytes instead of entry count. */
  diskCacheBytes?: number;
}

// === HNSW Internal Types ===
export interface HNSWNode {
  key: string;
  vector: Float32Array | null;
  norm: number;
  metadata?: Record<string, unknown>;
  layer: number;
  neighbors: Set<string>[];
  deleted: boolean;
}

export interface ScoredResult {
  key: string;
  score: number;
}
