import { existsSync } from "node:fs";
import {
  readFileSync as nodeReadFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import {
  VECTOR_MAGIC,
  VECTOR_FORMAT_VERSION,
  VectorWalOp,
  type VectorIndexConfig,
  type SparseVector,
} from "./types";
import { crc32, concatUint8Arrays } from "../utils";

// Forward reference to avoid circular imports
interface VectorStoreInterface {
  _createIndexInternal(config: VectorIndexConfig): void;
  _putVectorInternal(indexName: string, key: string, vector: Float32Array | null, metadata?: Record<string, unknown>, sparseVector?: SparseVector): void;
  _deleteVectorInternal(indexName: string, key: string): void;
  _getAllIndexEntries(): Map<string, {
    config: VectorIndexConfig;
    hnsw: { allNodes(): IterableIterator<{ key: string; vector: Float32Array; metadata?: Record<string, unknown> }> };
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

function applyRecords(store: VectorStoreInterface, records: ParsedRecord[]): void {
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
        // Delete all vectors first, then index
        // Simple: just rebuild from remaining records
        break;
      case VectorWalOp.PUT_VECTOR: {
        const vector = rec.data ? new Float32Array(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength / 4) : null;
        const sparseVector = rec.metadata.sparseVector as SparseVector | undefined;
        const vectorMeta = rec.metadata.vectorMetadata as Record<string, unknown> | undefined;
        store._putVectorInternal(rec.indexName, rec.key, vector, vectorMeta, sparseVector);
        break;
      }
      case VectorWalOp.DELETE_VECTOR:
        store._deleteVectorInternal(rec.indexName, rec.key);
        break;
    }
  }
}

function readFileBytes(path: string): Uint8Array {
  const buf = nodeReadFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export class VectorWAL {
  private mainPath: string;
  private walPath: string;
  private walSize = 0;
  private checkpointThreshold: number;

  constructor(path: string, checkpointThreshold = 10 * 1024 * 1024) {
    this.mainPath = path;
    this.walPath = path + "-wal";
    this.checkpointThreshold = checkpointThreshold;
  }

  open(store: VectorStoreInterface): void {
    if (existsSync(this.mainPath)) {
      const buf = readFileBytes(this.mainPath);
      if (buf.byteLength >= 8) {
        if (
          buf[0] === VECTOR_MAGIC[0] &&
          buf[1] === VECTOR_MAGIC[1] &&
          buf[2] === VECTOR_MAGIC[2] &&
          buf[3] === VECTOR_MAGIC[3]
        ) {
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const version = view.getUint32(4, true);
          if (version === VECTOR_FORMAT_VERSION) {
            const records = readRecords(buf, 8);
            applyRecords(store, records);
          }
        }
      }
    }

    if (existsSync(this.walPath)) {
      const walBuf = readFileBytes(this.walPath);
      if (walBuf.byteLength > 0) {
        const records = readRecords(walBuf, 0);
        applyRecords(store, records);
      }
      this.walSize = walBuf.byteLength;
    }

    if (!existsSync(this.walPath)) {
      writeFileSync(this.walPath, new Uint8Array(0));
    }
  }

  appendCreateIndex(config: VectorIndexConfig): void {
    const metadata: Record<string, unknown> = {
      dimension: config.dimension,
      distanceMetric: config.distanceMetric,
      sparse: config.sparse,
      hnswConfig: config.hnswConfig,
      createdAt: config.createdAt.toISOString(),
    };
    const record = encodeRecord(VectorWalOp.CREATE_INDEX, config.name, "", metadata, null);
    appendFileSync(this.walPath, record);
    this.walSize += record.byteLength;
  }

  appendDeleteIndex(indexName: string): void {
    const record = encodeRecord(VectorWalOp.DELETE_INDEX, indexName, "", null, null);
    appendFileSync(this.walPath, record);
    this.walSize += record.byteLength;
  }

  appendPutVector(
    indexName: string,
    key: string,
    vector: Float32Array | null,
    metadata?: Record<string, unknown>,
    sparseVector?: SparseVector,
  ): void {
    const meta: Record<string, unknown> = {};
    if (metadata) meta.vectorMetadata = metadata;
    if (sparseVector) meta.sparseVector = sparseVector;

    const data = vector ? new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength) : null;
    const record = encodeRecord(VectorWalOp.PUT_VECTOR, indexName, key, meta, data);
    appendFileSync(this.walPath, record);
    this.walSize += record.byteLength;
  }

  appendDeleteVector(indexName: string, key: string): void {
    const record = encodeRecord(VectorWalOp.DELETE_VECTOR, indexName, key, null, null);
    appendFileSync(this.walPath, record);
    this.walSize += record.byteLength;
  }

  shouldCheckpoint(): boolean {
    return this.walSize >= this.checkpointThreshold;
  }

  checkpoint(store: VectorStoreInterface): void {
    const parts: Uint8Array[] = [];

    const header = new Uint8Array(8);
    header.set(VECTOR_MAGIC, 0);
    new DataView(header.buffer).setUint32(4, VECTOR_FORMAT_VERSION, true);
    parts.push(header);

    for (const [, entry] of store._getAllIndexEntries()) {
      // Write CREATE_INDEX record
      const indexMeta: Record<string, unknown> = {
        dimension: entry.config.dimension,
        distanceMetric: entry.config.distanceMetric,
        sparse: entry.config.sparse,
        hnswConfig: entry.config.hnswConfig,
        createdAt: entry.config.createdAt.toISOString(),
      };
      parts.push(encodeRecord(VectorWalOp.CREATE_INDEX, entry.config.name, "", indexMeta, null));

      // Write all vectors
      for (const node of entry.hnsw.allNodes()) {
        const vecMeta = entry.vectors.get(node.key);
        const meta: Record<string, unknown> = {};
        if (vecMeta?.metadata) meta.vectorMetadata = vecMeta.metadata;
        if (vecMeta?.sparseVector) meta.sparseVector = vecMeta.sparseVector;

        const data = new Uint8Array(node.vector.buffer, node.vector.byteOffset, node.vector.byteLength);
        parts.push(encodeRecord(VectorWalOp.PUT_VECTOR, entry.config.name, node.key, meta, data));
      }

      // Write vectors that are sparse-only (no dense vector)
      for (const [key, vecMeta] of entry.vectors) {
        const node = [...entry.hnsw.allNodes()].find(n => n.key === key);
        if (!node && vecMeta.sparseVector) {
          const meta: Record<string, unknown> = {};
          if (vecMeta.metadata) meta.vectorMetadata = vecMeta.metadata;
          meta.sparseVector = vecMeta.sparseVector;
          parts.push(encodeRecord(VectorWalOp.PUT_VECTOR, entry.config.name, key, meta, null));
        }
      }
    }

    const fullData = concatUint8Arrays(parts);
    writeFileSync(this.mainPath, fullData);
    writeFileSync(this.walPath, new Uint8Array(0));
    this.walSize = 0;
  }

  close(store: VectorStoreInterface): void {
    this.checkpoint(store);
  }
}
