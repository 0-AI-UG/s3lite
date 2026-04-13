import { existsSync } from "node:fs";
import {
  readFileSync as nodeReadFileSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
  renameSync,
} from "node:fs";
import {
  VECTOR_MAGIC,
  VECTOR_FORMAT_VERSION,
  GRAPH_MARKER,
  VectorWalOp,
  type VectorIndexConfig,
  type SparseVector,
  type DistanceMetric,
} from "./types";
import { HNSWIndex } from "./hnsw";
import { computeNorm } from "./distance";
import { crc32 } from "../utils";
import { ReadonlyError } from "../types";
import type { Store } from "../store";

// Forward reference to avoid circular imports
interface VectorStoreInterface {
  _createIndexInternal(config: VectorIndexConfig): void;
  _deleteIndexInternal(name: string): void;
  _putVectorInternal(indexName: string, key: string, vector: Float32Array | null, metadata?: Record<string, unknown>, sparseVector?: SparseVector, skipHNSW?: boolean): void;
  _deleteVectorInternal(indexName: string, key: string): void;
  _setHNSW(indexName: string, hnsw: HNSWIndex): void;
  _getAllIndexEntries(): Map<string, {
    config: VectorIndexConfig;
    hnsw: {
      serialize(): Uint8Array;
      allNodes(): IterableIterator<{ key: string; vector: Float32Array | null; metadata?: Record<string, unknown> }>;
      allNodeMeta(): IterableIterator<{ key: string; norm: number; metadata?: Record<string, unknown> }>;
      hasKey(key: string): boolean;
      getNode(key: string): { key: string; vector: Float32Array | null; metadata?: Record<string, unknown> } | undefined;
    };
    sparse: { getSparseVector(key: string): SparseVector | undefined } | null;
    vectors: Map<string, { key: string; metadata?: Record<string, unknown>; sparseVector?: SparseVector }>;
  }>;
}

interface ParsedRecord {
  op: VectorWalOp;
  indexName: string;
  key: string;
  metadata: Record<string, unknown>;
  data: Uint8Array | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeRecord(
  op: VectorWalOp,
  indexName: string,
  key: string,
  metadata: Record<string, unknown> | null,
  data: Uint8Array | null,
): Uint8Array {
  const indexBytes = encoder.encode(indexName);
  const keyBytes = encoder.encode(key);
  const metaBytes = encoder.encode(metadata ? JSON.stringify(metadata) : "{}");
  const dataLen = data ? data.byteLength : 0;

  const payloadSize =
    1 + 2 + indexBytes.byteLength + 2 + keyBytes.byteLength + 4 + metaBytes.byteLength + 4 + dataLen;
  const buf = new Uint8Array(payloadSize + 4); // +4 for CRC
  const view = new DataView(buf.buffer);
  let offset = 0;

  buf[offset++] = op;

  view.setUint16(offset, indexBytes.byteLength, true);
  offset += 2;
  buf.set(indexBytes, offset);
  offset += indexBytes.byteLength;

  view.setUint16(offset, keyBytes.byteLength, true);
  offset += 2;
  buf.set(keyBytes, offset);
  offset += keyBytes.byteLength;

  view.setUint32(offset, metaBytes.byteLength, true);
  offset += 4;
  buf.set(metaBytes, offset);
  offset += metaBytes.byteLength;

  view.setUint32(offset, dataLen, true);
  offset += 4;
  if (data && dataLen > 0) {
    buf.set(data, offset);
    offset += dataLen;
  }

  const checksum = crc32(buf.subarray(0, offset));
  view.setUint32(offset, checksum, true);

  return buf;
}

function readRecords(data: Uint8Array, startOffset: number): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = startOffset;

  while (offset < data.byteLength) {
    const recordStart = offset;

    if (offset + 1 > data.byteLength) break;
    const op = data[offset++] as VectorWalOp;
    if (op < VectorWalOp.CREATE_INDEX || op > VectorWalOp.DELETE_VECTOR) break;

    if (offset + 2 > data.byteLength) break;
    const indexLen = view.getUint16(offset, true);
    offset += 2;
    if (offset + indexLen > data.byteLength) break;
    const indexName = decoder.decode(data.subarray(offset, offset + indexLen));
    offset += indexLen;

    if (offset + 2 > data.byteLength) break;
    const keyLen = view.getUint16(offset, true);
    offset += 2;
    if (offset + keyLen > data.byteLength) break;
    const key = decoder.decode(data.subarray(offset, offset + keyLen));
    offset += keyLen;

    if (offset + 4 > data.byteLength) break;
    const metaLen = view.getUint32(offset, true);
    offset += 4;
    if (offset + metaLen > data.byteLength) break;
    const metaStr = decoder.decode(data.subarray(offset, offset + metaLen));
    offset += metaLen;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(metaStr);
    } catch {
      break;
    }

    if (offset + 4 > data.byteLength) break;
    const dataLen = view.getUint32(offset, true);
    offset += 4;
    if (offset + dataLen > data.byteLength) break;
    const recordData = dataLen > 0 ? data.slice(offset, offset + dataLen) : null;
    offset += dataLen;

    if (offset + 4 > data.byteLength) break;
    const storedCrc = view.getUint32(offset, true);
    const payloadEnd = offset;
    offset += 4;

    const computedCrc = crc32(data.subarray(recordStart, payloadEnd));
    if (computedCrc !== storedCrc) break;

    records.push({ op, indexName, key, metadata, data: recordData });
  }

  return records;
}

function applyRecords(store: VectorStoreInterface, records: ParsedRecord[], skipHNSW = false): void {
  for (const rec of records) {
    switch (rec.op) {
      case VectorWalOp.CREATE_INDEX: {
        const config: VectorIndexConfig = {
          name: rec.indexName,
          dimension: rec.metadata.dimension as number,
          distanceMetric: rec.metadata.distanceMetric as "cosine" | "euclidean" | "dotproduct",
          sparse: rec.metadata.sparse as boolean,
          hnswConfig: rec.metadata.hnswConfig as { M: number; efConstruction: number },
          createdAt: new Date(rec.metadata.createdAt as string),
        };
        store._createIndexInternal(config);
        break;
      }
      case VectorWalOp.DELETE_INDEX:
        store._deleteIndexInternal(rec.indexName);
        break;
      case VectorWalOp.PUT_VECTOR: {
        const vector = rec.data ? new Float32Array(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength / 4) : null;
        const sparseVector = rec.metadata.sparseVector as SparseVector | undefined;
        const vectorMeta = rec.metadata.vectorMetadata as Record<string, unknown> | undefined;
        store._putVectorInternal(rec.indexName, rec.key, vector, vectorMeta, sparseVector, skipHNSW);
        break;
      }
      case VectorWalOp.DELETE_VECTOR:
        store._deleteVectorInternal(rec.indexName, rec.key);
        break;
    }
  }
}

function collectVectors(
  records: ParsedRecord[],
  out: Map<string, Map<string, { vector: Float32Array; norm: number; metadata?: Record<string, unknown> }>>,
): void {
  for (const rec of records) {
    if (rec.op === VectorWalOp.PUT_VECTOR && rec.data) {
      let indexMap = out.get(rec.indexName);
      if (!indexMap) {
        indexMap = new Map();
        out.set(rec.indexName, indexMap);
      }
      const vector = new Float32Array(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength / 4);
      const vectorMeta = rec.metadata.vectorMetadata as Record<string, unknown> | undefined;
      indexMap.set(rec.key, { vector, norm: computeNorm(vector), metadata: vectorMeta });
    } else if (rec.op === VectorWalOp.DELETE_VECTOR) {
      const indexMap = out.get(rec.indexName);
      if (indexMap) indexMap.delete(rec.key);
    } else if (rec.op === VectorWalOp.DELETE_INDEX) {
      out.delete(rec.indexName);
    }
  }
}

/** Disk mode: collect norms from WAL records (no vector data in records). */
function collectNorms(
  records: ParsedRecord[],
  out: Map<string, Map<string, { vector: null; norm: number; metadata?: Record<string, unknown> }>>,
): void {
  for (const rec of records) {
    if (rec.op === VectorWalOp.PUT_VECTOR) {
      let indexMap = out.get(rec.indexName);
      if (!indexMap) {
        indexMap = new Map();
        out.set(rec.indexName, indexMap);
      }
      const norm = rec.metadata.norm as number | undefined;
      if (norm !== undefined) {
        const vectorMeta = rec.metadata.vectorMetadata as Record<string, unknown> | undefined;
        indexMap.set(rec.key, { vector: null, norm, metadata: vectorMeta });
      }
    } else if (rec.op === VectorWalOp.DELETE_VECTOR) {
      const indexMap = out.get(rec.indexName);
      if (indexMap) indexMap.delete(rec.key);
    } else if (rec.op === VectorWalOp.DELETE_INDEX) {
      out.delete(rec.indexName);
    }
  }
}

function readFileBytes(path: string): Uint8Array {
  const buf = nodeReadFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

type SyncMode = "full" | "normal" | "off";

export class VectorWAL {
  private mainPath: string;
  private walPath: string;
  private walFd: number | null = null;
  private walSize = 0;
  private checkpointThreshold: number;
  private syncMode: SyncMode;
  private dirtyGraphs = new Set<string>();
  private cachedGraphData = new Map<string, Uint8Array>();
  private readOnly: boolean;
  private diskMode: boolean;
  private s3Store: Store | null;

  constructor(path: string, syncMode: SyncMode = "normal", checkpointThreshold = 10 * 1024 * 1024, readOnly = false, diskMode = false, s3Store: Store | null = null) {
    this.mainPath = path;
    this.walPath = path + "-wal";
    this.checkpointThreshold = checkpointThreshold;
    this.syncMode = syncMode;
    this.readOnly = readOnly;
    this.diskMode = diskMode;
    this.s3Store = s3Store;
  }

  open(store: VectorStoreInterface): void {
    if (existsSync(this.mainPath)) {
      const buf = readFileBytes(this.mainPath);
      if (buf.byteLength >= 8) {
        const magicOk =
          buf[0] === VECTOR_MAGIC[0] &&
          buf[1] === VECTOR_MAGIC[1] &&
          buf[2] === VECTOR_MAGIC[2] &&
          buf[3] === VECTOR_MAGIC[3];

        if (magicOk) {
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const version = view.getUint32(4, true);
          if (version === VECTOR_FORMAT_VERSION || version === 1) {
            const records = readRecords(buf, 8);
            const graphOffset = this.findGraphMarker(buf, 8, records);
            const hasGraph = graphOffset >= 0;

            if (hasGraph) {
              // Phase 1: Apply records, skip HNSW inserts, collect vectors/norms
              applyRecords(store, records, true);

              if (this.diskMode) {
                // Disk mode: collect norms only (vectors are in S3 Store)
                const normsMap = new Map<string, Map<string, { vector: null; norm: number; metadata?: Record<string, unknown> }>>();
                collectNorms(records, normsMap);
                this.deserializeGraphs(buf, graphOffset + 4, store, normsMap);
              } else {
                const vectorsMap = new Map<string, Map<string, { vector: Float32Array; norm: number; metadata?: Record<string, unknown> }>>();
                collectVectors(records, vectorsMap);
                this.deserializeGraphs(buf, graphOffset + 4, store, vectorsMap);
              }
            } else {
              if (this.diskMode) {
                // v1 format in disk mode: apply records, reading vectors from S3 Store
                applyRecords(store, records, true);
                this.replayRecordsDiskMode(store, records);
              } else {
                // v1 or no graph section: fall back to insert-based rebuild
                applyRecords(store, records);
              }
            }
          }
        }
      }
    }

    // Replay WAL records (post-checkpoint ops)
    if (existsSync(this.walPath)) {
      const walBuf = readFileBytes(this.walPath);
      if (walBuf.byteLength > 0) {
        const records = readRecords(walBuf, 0);
        if (this.diskMode) {
          // Disk mode: WAL records have no vector data, read from S3 Store
          this.replayRecordsDiskMode(store, records);
        } else {
          applyRecords(store, records);
        }
      }
      this.walSize = walBuf.byteLength;
    }

    // Open persistent WAL fd — skip in read-only mode
    if (!this.readOnly) {
      this.walFd = openSync(this.walPath, existsSync(this.walPath) ? "a" : "w");
    }
  }

  /** Replay WAL records in disk mode: read vectors from S3 Store for HNSW inserts. */
  private replayRecordsDiskMode(store: VectorStoreInterface, records: ParsedRecord[]): void {
    for (const rec of records) {
      switch (rec.op) {
        case VectorWalOp.CREATE_INDEX: {
          const config: VectorIndexConfig = {
            name: rec.indexName,
            dimension: rec.metadata.dimension as number,
            distanceMetric: rec.metadata.distanceMetric as "cosine" | "euclidean" | "dotproduct",
            sparse: rec.metadata.sparse as boolean,
            hnswConfig: rec.metadata.hnswConfig as { M: number; efConstruction: number },
            createdAt: new Date(rec.metadata.createdAt as string),
          };
          store._createIndexInternal(config);
          break;
        }
        case VectorWalOp.DELETE_INDEX:
          store._deleteIndexInternal(rec.indexName);
          break;
        case VectorWalOp.PUT_VECTOR: {
          // Read vector from S3 Store
          let vector: Float32Array | null = null;
          if (this.s3Store) {
            const obj = this.s3Store.get(rec.indexName, rec.key);
            if (obj?.data) {
              vector = new Float32Array(obj.data.buffer, obj.data.byteOffset, obj.data.byteLength / 4);
            }
          }
          const sparseVector = rec.metadata.sparseVector as SparseVector | undefined;
          const vectorMeta = rec.metadata.vectorMetadata as Record<string, unknown> | undefined;
          store._putVectorInternal(rec.indexName, rec.key, vector, vectorMeta, sparseVector, false);
          break;
        }
        case VectorWalOp.DELETE_VECTOR:
          store._deleteVectorInternal(rec.indexName, rec.key);
          break;
      }
    }
  }

  private findGraphMarker(buf: Uint8Array, headerSize: number, records: ParsedRecord[]): number {
    // Skip past all records to find where they end
    let offset = headerSize;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    for (let i = 0; i < records.length; i++) {
      if (offset + 1 > buf.byteLength) return -1;
      offset++; // op

      if (offset + 2 > buf.byteLength) return -1;
      const indexLen = view.getUint16(offset, true);
      offset += 2 + indexLen;

      if (offset + 2 > buf.byteLength) return -1;
      const keyLen = view.getUint16(offset, true);
      offset += 2 + keyLen;

      if (offset + 4 > buf.byteLength) return -1;
      const metaLen = view.getUint32(offset, true);
      offset += 4 + metaLen;

      if (offset + 4 > buf.byteLength) return -1;
      const dataLen = view.getUint32(offset, true);
      offset += 4 + dataLen;

      offset += 4; // CRC
    }

    // Check for GRPH marker
    if (offset + 4 <= buf.byteLength &&
        buf[offset] === GRAPH_MARKER[0] &&
        buf[offset + 1] === GRAPH_MARKER[1] &&
        buf[offset + 2] === GRAPH_MARKER[2] &&
        buf[offset + 3] === GRAPH_MARKER[3]) {
      return offset;
    }

    return -1;
  }

  private deserializeGraphs(
    buf: Uint8Array,
    offset: number,
    store: VectorStoreInterface,
    vectorsMap: Map<string, Map<string, { vector: Float32Array | null; norm: number; metadata?: Record<string, unknown> }>>,
  ): void {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const decoder = new TextDecoder();
    const entries = store._getAllIndexEntries();

    // Read index count
    if (offset + 4 > buf.byteLength) return;
    const indexCount = view.getUint32(offset, true);
    offset += 4;

    for (let i = 0; i < indexCount; i++) {
      if (offset + 2 > buf.byteLength) return;
      const nameLen = view.getUint16(offset, true);
      offset += 2;
      if (offset + nameLen > buf.byteLength) return;
      const indexName = decoder.decode(buf.subarray(offset, offset + nameLen));
      offset += nameLen;

      // Read graph data length
      if (offset + 4 > buf.byteLength) return;
      const graphDataLen = view.getUint32(offset, true);
      offset += 4;
      if (offset + graphDataLen > buf.byteLength) return;

      const entry = entries.get(indexName);
      const nodesMap = vectorsMap.get(indexName);

      if (entry && nodesMap && graphDataLen > 0) {
        const { index } = HNSWIndex.deserialize(
          buf,
          offset,
          nodesMap,
          entry.config.dimension,
          entry.config.distanceMetric as DistanceMetric,
          entry.config.hnswConfig.M,
          entry.config.hnswConfig.efConstruction,
        );
        store._setHNSW(indexName, index);
      }

      offset += graphDataLen;
    }
  }

  private writeRecord(record: Uint8Array): void {
    writeSync(this.walFd!, record, 0, record.byteLength);
    this.walSize += record.byteLength;
    if (this.syncMode === "full") {
      fsyncSync(this.walFd!);
    }
  }

  private guardReadonly(): void {
    if (this.readOnly) throw new ReadonlyError("write");
  }

  appendCreateIndex(config: VectorIndexConfig): void {
    this.guardReadonly();
    const metadata: Record<string, unknown> = {
      dimension: config.dimension,
      distanceMetric: config.distanceMetric,
      sparse: config.sparse,
      hnswConfig: config.hnswConfig,
      createdAt: config.createdAt.toISOString(),
    };
    this.dirtyGraphs.add(config.name);
    this.writeRecord(encodeRecord(VectorWalOp.CREATE_INDEX, config.name, "", metadata, null));
  }

  appendDeleteIndex(indexName: string): void {
    this.guardReadonly();
    this.dirtyGraphs.delete(indexName);
    this.cachedGraphData.delete(indexName);
    this.writeRecord(encodeRecord(VectorWalOp.DELETE_INDEX, indexName, "", null, null));
  }

  appendPutVector(
    indexName: string,
    key: string,
    vector: Float32Array | null,
    metadata?: Record<string, unknown>,
    sparseVector?: SparseVector,
    norm?: number,
  ): void {
    this.guardReadonly();
    const meta: Record<string, unknown> = {};
    if (metadata) meta.vectorMetadata = metadata;
    if (sparseVector) meta.sparseVector = sparseVector;

    this.dirtyGraphs.add(indexName);

    if (this.diskMode) {
      // Disk mode: store norm in metadata, no vector data in WAL
      if (norm !== undefined) meta.norm = norm;
      this.writeRecord(encodeRecord(VectorWalOp.PUT_VECTOR, indexName, key, meta, null));
    } else {
      const data = vector ? new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength) : null;
      this.writeRecord(encodeRecord(VectorWalOp.PUT_VECTOR, indexName, key, meta, data));
    }
  }

  appendDeleteVector(indexName: string, key: string): void {
    this.guardReadonly();
    this.dirtyGraphs.add(indexName);
    this.writeRecord(encodeRecord(VectorWalOp.DELETE_VECTOR, indexName, key, null, null));
  }

  shouldCheckpoint(): boolean {
    return this.walSize >= this.checkpointThreshold;
  }

  checkpoint(store: VectorStoreInterface): void {
    this.guardReadonly();
    // Write to temp file, then atomic rename
    const tmpPath = this.mainPath + ".tmp";
    const fd = openSync(tmpPath, "w");

    // Header
    const header = new Uint8Array(8);
    header.set(VECTOR_MAGIC, 0);
    new DataView(header.buffer).setUint32(4, VECTOR_FORMAT_VERSION, true);
    writeSync(fd, header, 0, header.byteLength);

    for (const [, entry] of store._getAllIndexEntries()) {
      // Write CREATE_INDEX record
      const indexMeta: Record<string, unknown> = {
        dimension: entry.config.dimension,
        distanceMetric: entry.config.distanceMetric,
        sparse: entry.config.sparse,
        hnswConfig: entry.config.hnswConfig,
        createdAt: entry.config.createdAt.toISOString(),
      };
      const idxRec = encodeRecord(VectorWalOp.CREATE_INDEX, entry.config.name, "", indexMeta, null);
      writeSync(fd, idxRec, 0, idxRec.byteLength);

      if (this.diskMode) {
        // Disk mode: write norms only (vectors are in S3 Store)
        for (const nodeMeta of entry.hnsw.allNodeMeta()) {
          const vecMeta = entry.vectors.get(nodeMeta.key);
          const meta: Record<string, unknown> = { norm: nodeMeta.norm };
          if (vecMeta?.metadata) meta.vectorMetadata = vecMeta.metadata;
          if (vecMeta?.sparseVector) meta.sparseVector = vecMeta.sparseVector;
          const rec = encodeRecord(VectorWalOp.PUT_VECTOR, entry.config.name, nodeMeta.key, meta, null);
          writeSync(fd, rec, 0, rec.byteLength);
        }

        // Write sparse-only vectors (no dense vector)
        for (const [key, vecMeta] of entry.vectors) {
          if (!entry.hnsw.hasKey(key) && vecMeta.sparseVector) {
            const meta: Record<string, unknown> = {};
            if (vecMeta.metadata) meta.vectorMetadata = vecMeta.metadata;
            meta.sparseVector = vecMeta.sparseVector;
            const rec = encodeRecord(VectorWalOp.PUT_VECTOR, entry.config.name, key, meta, null);
            writeSync(fd, rec, 0, rec.byteLength);
          }
        }
      } else {
        // Memory mode: write full vectors
        for (const node of entry.hnsw.allNodes()) {
          const vecMeta = entry.vectors.get(node.key);
          const meta: Record<string, unknown> = {};
          if (vecMeta?.metadata) meta.vectorMetadata = vecMeta.metadata;
          if (vecMeta?.sparseVector) meta.sparseVector = vecMeta.sparseVector;

          const vec = node.vector!;
          const data = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
          const rec = encodeRecord(VectorWalOp.PUT_VECTOR, entry.config.name, node.key, meta, data);
          writeSync(fd, rec, 0, rec.byteLength);
        }

        // Write sparse-only vectors (no dense vector)
        for (const [key, vecMeta] of entry.vectors) {
          if (!entry.hnsw.hasKey(key) && vecMeta.sparseVector) {
            const meta: Record<string, unknown> = {};
            if (vecMeta.metadata) meta.vectorMetadata = vecMeta.metadata;
            meta.sparseVector = vecMeta.sparseVector;
            const rec = encodeRecord(VectorWalOp.PUT_VECTOR, entry.config.name, key, meta, null);
            writeSync(fd, rec, 0, rec.byteLength);
          }
        }
      }
    }

    // Write GRAPH section
    const allEntries = [...store._getAllIndexEntries()];
    writeSync(fd, GRAPH_MARKER, 0, GRAPH_MARKER.byteLength);

    // Index count
    const indexCountBuf = new Uint8Array(4);
    new DataView(indexCountBuf.buffer).setUint32(0, allEntries.length, true);
    writeSync(fd, indexCountBuf, 0, 4);

    const graphEncoder = new TextEncoder();
    for (const [indexName, entry] of allEntries) {
      const nameBytes = graphEncoder.encode(indexName);
      const nameHeader = new Uint8Array(2);
      new DataView(nameHeader.buffer).setUint16(0, nameBytes.byteLength, true);
      writeSync(fd, nameHeader, 0, 2);
      writeSync(fd, nameBytes, 0, nameBytes.byteLength);

      // Only re-serialize dirty graphs; reuse cached data for clean ones
      let graphData: Uint8Array;
      if (this.dirtyGraphs.has(indexName) || !this.cachedGraphData.has(indexName)) {
        graphData = entry.hnsw.serialize();
        this.cachedGraphData.set(indexName, graphData);
      } else {
        graphData = this.cachedGraphData.get(indexName)!;
      }
      const graphLenBuf = new Uint8Array(4);
      new DataView(graphLenBuf.buffer).setUint32(0, graphData.byteLength, true);
      writeSync(fd, graphLenBuf, 0, 4);
      writeSync(fd, graphData, 0, graphData.byteLength);
    }
    this.dirtyGraphs.clear();

    if (this.syncMode !== "off") {
      fsyncSync(fd);
    }
    closeSync(fd);

    // Atomic rename
    renameSync(tmpPath, this.mainPath);

    // Truncate WAL and reopen fd to reset write position
    ftruncateSync(this.walFd!, 0);
    if (this.syncMode !== "off") {
      fsyncSync(this.walFd!);
    }
    closeSync(this.walFd!);
    this.walFd = openSync(this.walPath, "a");
    this.walSize = 0;
  }

  close(store: VectorStoreInterface): void {
    if (!this.readOnly) this.checkpoint(store);
    if (this.walFd !== null) {
      closeSync(this.walFd);
      this.walFd = null;
    }
  }
}
