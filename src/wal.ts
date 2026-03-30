import { existsSync } from "node:fs";
import {
  readFileSync as nodeReadFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
  fsyncSync,
  ftruncateSync,
} from "node:fs";
import {
  MAGIC,
  FORMAT_VERSION,
  WalOp,
  type StoredObject,
} from "./types";
import { crc32, concatUint8Arrays } from "./utils";
import type { DiskIndex } from "./disk-index";

type SyncMode = "full" | "normal" | "off";
type ObjectMap = Map<string, Map<string, StoredObject>>;

const sharedEncoder = new TextEncoder();

interface ParsedRecord {
  op: WalOp;
  bucket: string;
  key: string;
  metadata: Record<string, unknown>;
  objectData: Uint8Array | null;
}

function encodeRecord(
  op: WalOp,
  bucket: string,
  key: string,
  metadata: Record<string, unknown> | null,
  data: Uint8Array | null,
): Uint8Array {
  const bucketBytes = sharedEncoder.encode(bucket);
  const keyBytes = sharedEncoder.encode(key);
  const metaBytes = sharedEncoder.encode(
    metadata ? JSON.stringify(metadata) : "{}",
  );
  const dataLen = data ? data.byteLength : 0;

  const payloadSize =
    1 + 2 + bucketBytes.byteLength + 2 + keyBytes.byteLength + 4 + metaBytes.byteLength + 4 + dataLen;
  const buf = new Uint8Array(payloadSize + 4); // +4 for CRC
  const view = new DataView(buf.buffer);
  let offset = 0;

  buf[offset++] = op;

  view.setUint16(offset, bucketBytes.byteLength, true);
  offset += 2;
  buf.set(bucketBytes, offset);
  offset += bucketBytes.byteLength;

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

export interface CorruptRecord {
  offset: number;
  reason: string;
}

export interface IntegrityReport {
  totalRecords: number;
  validRecords: number;
  corruptRecords: CorruptRecord[];
  ok: boolean;
}

/** Try to parse a single record at `offset`. Returns the parsed record and the offset after it, or null on failure. */
function tryParseRecord(
  data: Uint8Array,
  view: DataView,
  decoder: TextDecoder,
  offset: number,
): { record: ParsedRecord; nextOffset: number } | { error: string } {
  const recordStart = offset;

  if (offset + 1 > data.byteLength) return { error: "truncated: no op byte" };
  const op = data[offset++] as WalOp;
  if (op !== WalOp.PUT && op !== WalOp.DELETE && op !== WalOp.TXN_BEGIN && op !== WalOp.TXN_COMMIT)
    return { error: `invalid op byte: ${op}` };

  if (offset + 2 > data.byteLength) return { error: "truncated: bucket length" };
  const bucketLen = view.getUint16(offset, true);
  offset += 2;
  if (offset + bucketLen > data.byteLength) return { error: "truncated: bucket data" };
  const bucket = decoder.decode(data.subarray(offset, offset + bucketLen));
  offset += bucketLen;

  if (offset + 2 > data.byteLength) return { error: "truncated: key length" };
  const keyLen = view.getUint16(offset, true);
  offset += 2;
  if (offset + keyLen > data.byteLength) return { error: "truncated: key data" };
  const key = decoder.decode(data.subarray(offset, offset + keyLen));
  offset += keyLen;

  if (offset + 4 > data.byteLength) return { error: "truncated: metadata length" };
  const metaLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + metaLen > data.byteLength) return { error: "truncated: metadata" };
  const metaStr = decoder.decode(data.subarray(offset, offset + metaLen));
  offset += metaLen;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metaStr);
  } catch {
    return { error: "invalid JSON metadata" };
  }

  if (offset + 4 > data.byteLength) return { error: "truncated: data length" };
  const dataLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + dataLen > data.byteLength) return { error: "truncated: object data" };
  const objectData = dataLen > 0 ? data.slice(offset, offset + dataLen) : null;
  offset += dataLen;

  if (offset + 4 > data.byteLength) return { error: "truncated: CRC" };
  const storedCrc = view.getUint32(offset, true);
  const payloadEnd = offset;
  offset += 4;

  const computedCrc = crc32(data.subarray(recordStart, payloadEnd));
  if (computedCrc !== storedCrc) {
    return { error: `CRC mismatch: expected ${storedCrc}, got ${computedCrc}` };
  }

  return { record: { op, bucket, key, metadata, objectData }, nextOffset: offset };
}

/** Scan all records, reporting corrupt ones. If `repair` is true, skip bad records and return only valid ones. */
function readRecordsWithDiagnostics(
  data: Uint8Array,
  startOffset: number,
  repair: boolean,
): { records: ParsedRecord[]; report: IntegrityReport } {
  const records: ParsedRecord[] = [];
  const corruptRecords: CorruptRecord[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  let offset = startOffset;
  let totalRecords = 0;

  while (offset < data.byteLength) {
    const result = tryParseRecord(data, view, decoder, offset);
    totalRecords++;

    if ("error" in result) {
      corruptRecords.push({ offset, reason: result.error });
      if (!repair) break;
      // Scan forward byte-by-byte for the next valid op byte
      offset++;
      while (offset < data.byteLength) {
        const op = data[offset]!;
        if (op === WalOp.PUT || op === WalOp.DELETE || op === WalOp.TXN_BEGIN || op === WalOp.TXN_COMMIT) {
          // Try parsing here
          const probe = tryParseRecord(data, view, decoder, offset);
          if (!("error" in probe)) break;
        }
        offset++;
      }
    } else {
      records.push(result.record);
      offset = result.nextOffset;
    }
  }

  return {
    records,
    report: {
      totalRecords,
      validRecords: records.length,
      corruptRecords,
      ok: corruptRecords.length === 0,
    },
  };
}

function readRecords(data: Uint8Array, startOffset: number): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = startOffset;
  const decoder = new TextDecoder();

  while (offset < data.byteLength) {
    const recordStart = offset;

    if (offset + 1 > data.byteLength) break;
    const op = data[offset++] as WalOp;
    if (op !== WalOp.PUT && op !== WalOp.DELETE && op !== WalOp.TXN_BEGIN && op !== WalOp.TXN_COMMIT) break;

    if (offset + 2 > data.byteLength) break;
    const bucketLen = view.getUint16(offset, true);
    offset += 2;
    if (offset + bucketLen > data.byteLength) break;
    const bucket = decoder.decode(data.subarray(offset, offset + bucketLen));
    offset += bucketLen;

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
    const objectData = dataLen > 0 ? data.slice(offset, offset + dataLen) : null;
    offset += dataLen;

    if (offset + 4 > data.byteLength) break;
    const storedCrc = view.getUint32(offset, true);
    const payloadEnd = offset;
    offset += 4;

    const computedCrc = crc32(data.subarray(recordStart, payloadEnd));
    if (computedCrc !== storedCrc) {
      break; // corrupted, stop
    }

    records.push({ op, bucket, key, metadata, objectData });
  }

  return records;
}

function applySingleRecord(objects: ObjectMap, rec: ParsedRecord): void {
  if (rec.op === WalOp.PUT) {
    const blobOffset = rec.metadata.blobOffset as number | undefined;
    const blobLength = rec.metadata.blobLength as number | undefined;

    // Need either inline data or a blob reference
    if (!rec.objectData && blobOffset === undefined) return;

    let bucketMap = objects.get(rec.bucket);
    if (!bucketMap) {
      bucketMap = new Map();
      objects.set(rec.bucket, bucketMap);
    }
    bucketMap.set(rec.key, {
      data: rec.objectData,
      size: rec.objectData?.byteLength ?? blobLength ?? 0,
      etag: (rec.metadata.etag as string) ?? "",
      contentType: (rec.metadata.contentType as string) ?? "application/octet-stream",
      lastModified: new Date((rec.metadata.lastModified as string) ?? Date.now()),
      contentDisposition: rec.metadata.contentDisposition as string | undefined,
      expiresAt: rec.metadata.expiresAt as number | undefined,
      blobOffset,
      blobLength,
    });
  } else if (rec.op === WalOp.DELETE) {
    const bucketMap = objects.get(rec.bucket);
    if (bucketMap) {
      bucketMap.delete(rec.key);
      if (bucketMap.size === 0) objects.delete(rec.bucket);
    }
  }
}

function applyRecords(objects: ObjectMap, records: ParsedRecord[]): void {
  let txnBuffer: ParsedRecord[] | null = null;
  for (const rec of records) {
    if (rec.op === WalOp.TXN_BEGIN) {
      txnBuffer = [];
    } else if (rec.op === WalOp.TXN_COMMIT) {
      if (txnBuffer) {
        for (const r of txnBuffer) applySingleRecord(objects, r);
        txnBuffer = null;
      }
    } else if (txnBuffer !== null) {
      txnBuffer.push(rec);
    } else {
      applySingleRecord(objects, rec);
    }
  }
  // If txnBuffer is non-null here, the transaction was uncommitted (crash) — discard it
}

function recordToStoredObject(rec: ParsedRecord): StoredObject | null {
  const blobOffset = rec.metadata.blobOffset as number | undefined;
  const blobLength = rec.metadata.blobLength as number | undefined;
  if (!rec.objectData && blobOffset === undefined) return null;
  return {
    data: rec.objectData,
    size: rec.objectData?.byteLength ?? blobLength ?? 0,
    etag: (rec.metadata.etag as string) ?? "",
    contentType: (rec.metadata.contentType as string) ?? "application/octet-stream",
    lastModified: new Date((rec.metadata.lastModified as string) ?? Date.now()),
    contentDisposition: rec.metadata.contentDisposition as string | undefined,
    expiresAt: rec.metadata.expiresAt as number | undefined,
    blobOffset,
    blobLength,
  };
}

function applyRecordsToDiskIndex(diskIndex: DiskIndex, records: ParsedRecord[]): void {
  let txnBuffer: ParsedRecord[] | null = null;
  for (const rec of records) {
    if (rec.op === WalOp.TXN_BEGIN) {
      txnBuffer = [];
    } else if (rec.op === WalOp.TXN_COMMIT) {
      if (txnBuffer) {
        for (const r of txnBuffer) {
          if (r.op === WalOp.PUT) {
            const obj = recordToStoredObject(r);
            if (obj) diskIndex.applyWalRecord(WalOp.PUT, r.bucket, r.key, obj);
          } else if (r.op === WalOp.DELETE) {
            diskIndex.applyWalRecord(WalOp.DELETE, r.bucket, r.key, null);
          }
        }
        txnBuffer = null;
      }
    } else if (txnBuffer !== null) {
      txnBuffer.push(rec);
    } else if (rec.op === WalOp.PUT) {
      const obj = recordToStoredObject(rec);
      if (obj) diskIndex.applyWalRecord(WalOp.PUT, rec.bucket, rec.key, obj);
    } else if (rec.op === WalOp.DELETE) {
      diskIndex.applyWalRecord(WalOp.DELETE, rec.bucket, rec.key, null);
    }
  }
}

function readFileBytes(path: string): Uint8Array {
  const buf = nodeReadFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export class WAL {
  private mainPath: string;
  private walPath: string;
  private walFd: number | null = null;
  private walSize = 0;
  private txnStartSize = 0;
  private checkpointThreshold: number;
  private syncMode: SyncMode;
  private mainFileSize = 0;
  private cleanMainSize = 0; // size after last full checkpoint

  constructor(path: string, syncMode: SyncMode = "normal", checkpointThreshold = 10 * 1024 * 1024) {
    this.mainPath = path;
    this.walPath = path + "-wal";
    this.checkpointThreshold = checkpointThreshold;
    this.syncMode = syncMode;
  }

  open(objects: ObjectMap): void {
    // Read main file
    if (existsSync(this.mainPath)) {
      const buf = readFileBytes(this.mainPath);
      this.mainFileSize = buf.byteLength;
      this.cleanMainSize = buf.byteLength;
      if (buf.byteLength >= 8) {
        if (
          buf[0] === MAGIC[0] &&
          buf[1] === MAGIC[1] &&
          buf[2] === MAGIC[2] &&
          buf[3] === MAGIC[3]
        ) {
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const version = view.getUint32(4, true);
          if (version === FORMAT_VERSION) {
            const records = readRecords(buf, 8);
            applyRecords(objects, records);
          }
        }
      }
    }

    // Replay WAL
    if (existsSync(this.walPath)) {
      const walBuf = readFileBytes(this.walPath);
      if (walBuf.byteLength > 0) {
        const records = readRecords(walBuf, 0);
        applyRecords(objects, records);
      }
      this.walSize = walBuf.byteLength;
    }

    // Open WAL fd for appending (create if needed)
    this.walFd = openSync(this.walPath, existsSync(this.walPath) ? "a" : "w");
  }

  appendPut(
    bucket: string,
    key: string,
    data: Uint8Array | null,
    metadata: Record<string, unknown>,
  ): void {
    const record = encodeRecord(WalOp.PUT, bucket, key, metadata, data);
    writeSync(this.walFd!, record, 0, record.byteLength);
    this.walSize += record.byteLength;
    if (this.syncMode === "full") {
      fsyncSync(this.walFd!);
    }
  }

  appendDelete(bucket: string, key: string): void {
    const record = encodeRecord(WalOp.DELETE, bucket, key, null, null);
    writeSync(this.walFd!, record, 0, record.byteLength);
    this.walSize += record.byteLength;
    if (this.syncMode === "full") {
      fsyncSync(this.walFd!);
    }
  }

  appendTxnBegin(): void {
    this.txnStartSize = this.walSize;
    const record = encodeRecord(WalOp.TXN_BEGIN, "", "", null, null);
    writeSync(this.walFd!, record, 0, record.byteLength);
    this.walSize += record.byteLength;
  }

  appendTxnCommit(): void {
    const record = encodeRecord(WalOp.TXN_COMMIT, "", "", null, null);
    writeSync(this.walFd!, record, 0, record.byteLength);
    this.walSize += record.byteLength;
    // Always fsync on commit to ensure atomicity
    if (this.syncMode !== "off") {
      fsyncSync(this.walFd!);
    }
  }

  truncateUncommitted(): void {
    ftruncateSync(this.walFd!, this.txnStartSize);
    this.walSize = this.txnStartSize;
  }

  shouldCheckpoint(): boolean {
    return this.walSize >= this.checkpointThreshold;
  }

  /** Returns true when the main file has too many stale entries from incremental appends. */
  shouldFullCompact(): boolean {
    return this.cleanMainSize > 0 && this.mainFileSize > this.cleanMainSize * 2;
  }

  /** Append WAL bytes to the main file instead of rewriting everything. */
  incrementalCheckpoint(): void {
    if (this.walSize === 0) return;

    // Ensure main file exists with header
    if (this.mainFileSize === 0) {
      const header = new Uint8Array(8);
      header.set(MAGIC, 0);
      new DataView(header.buffer).setUint32(4, FORMAT_VERSION, true);
      writeFileSync(this.mainPath, header);
      this.mainFileSize = 8;
      this.cleanMainSize = 8;
    }

    // Read WAL content and append to main file
    const walBuf = readFileBytes(this.walPath);
    if (walBuf.byteLength === 0) return;

    const mainFd = openSync(this.mainPath, "a");
    writeSync(mainFd, walBuf, 0, walBuf.byteLength);

    if (this.syncMode !== "off") {
      fsyncSync(mainFd);
    }
    closeSync(mainFd);

    // Truncate WAL
    ftruncateSync(this.walFd!, 0);
    if (this.syncMode !== "off") {
      fsyncSync(this.walFd!);
    }

    this.mainFileSize += walBuf.byteLength;
    this.walSize = 0;
  }

  checkpoint(objects: ObjectMap, blobBacked = false): void {
    const parts: Uint8Array[] = [];

    // Header
    const header = new Uint8Array(8);
    header.set(MAGIC, 0);
    new DataView(header.buffer).setUint32(4, FORMAT_VERSION, true);
    parts.push(header);

    // All records
    for (const [bucket, bucketMap] of objects) {
      for (const [key, obj] of bucketMap) {
        const metadata: Record<string, unknown> = {
          contentType: obj.contentType,
          etag: obj.etag,
          lastModified: obj.lastModified.toISOString(),
        };
        if (obj.contentDisposition) {
          metadata.contentDisposition = obj.contentDisposition;
        }
        if (obj.expiresAt) {
          metadata.expiresAt = obj.expiresAt;
        }

        let data: Uint8Array | null;
        if (blobBacked) {
          metadata.blobOffset = obj.blobOffset;
          metadata.blobLength = obj.blobLength;
          data = null;
        } else {
          data = obj.data;
        }

        const record = encodeRecord(WalOp.PUT, bucket, key, metadata, data);
        parts.push(record);
      }
    }

    const fullData = concatUint8Arrays(parts);

    // Critical checkpoint sequence:
    // 1. Write main file
    writeFileSync(this.mainPath, fullData);

    if (this.syncMode !== "off") {
      // 2. fsync main file — ensures data is on disk before WAL truncation
      const mainFd = openSync(this.mainPath, "r");
      fsyncSync(mainFd);
      closeSync(mainFd);
    }

    // 3. Truncate WAL
    ftruncateSync(this.walFd!, 0);

    if (this.syncMode !== "off") {
      // 4. fsync WAL — ensures truncation is durable
      fsyncSync(this.walFd!);
    }

    this.walSize = 0;
    this.mainFileSize = fullData.byteLength;
    this.cleanMainSize = fullData.byteLength;
  }

  /** Open for DiskIndex mode: skip main file (DiskIndex reads it), replay WAL into overlay. */
  openWithDiskIndex(diskIndex: DiskIndex): void {
    // Track main file size
    if (existsSync(this.mainPath)) {
      const mainBuf = readFileBytes(this.mainPath);
      this.mainFileSize = mainBuf.byteLength;
      this.cleanMainSize = mainBuf.byteLength;
    }

    // Replay WAL into DiskIndex overlay
    if (existsSync(this.walPath)) {
      const walBuf = readFileBytes(this.walPath);
      if (walBuf.byteLength > 0) {
        const records = readRecords(walBuf, 0);
        applyRecordsToDiskIndex(diskIndex, records);
      }
      this.walSize = walBuf.byteLength;
    }

    // Open WAL fd for appending
    this.walFd = openSync(this.walPath, existsSync(this.walPath) ? "a" : "w");
  }

  /** Checkpoint from an iterator of [bucket, key, obj] triples (for DiskIndex mode).
   *  Entries MUST be sorted by bucket+key for the sparse index to work on reload. */
  checkpointFromIterator(
    entries: Iterable<[string, string, StoredObject]>,
    blobBacked = false,
  ): void {
    const parts: Uint8Array[] = [];

    const header = new Uint8Array(8);
    header.set(MAGIC, 0);
    new DataView(header.buffer).setUint32(4, FORMAT_VERSION, true);
    parts.push(header);

    // Collect and sort entries
    const sorted = [...entries].sort((a, b) => {
      const ckA = a[0] + "\0" + a[1];
      const ckB = b[0] + "\0" + b[1];
      return ckA < ckB ? -1 : ckA > ckB ? 1 : 0;
    });

    for (const [bucket, key, obj] of sorted) {
      const metadata: Record<string, unknown> = {
        contentType: obj.contentType,
        etag: obj.etag,
        lastModified: obj.lastModified.toISOString(),
      };
      if (obj.contentDisposition) metadata.contentDisposition = obj.contentDisposition;
      if (obj.expiresAt) metadata.expiresAt = obj.expiresAt;

      let data: Uint8Array | null;
      if (blobBacked) {
        metadata.blobOffset = obj.blobOffset;
        metadata.blobLength = obj.blobLength;
        data = null;
      } else {
        data = obj.data;
      }

      parts.push(encodeRecord(WalOp.PUT, bucket, key, metadata, data));
    }

    const fullData = concatUint8Arrays(parts);
    writeFileSync(this.mainPath, fullData);

    if (this.syncMode !== "off") {
      const mainFd = openSync(this.mainPath, "r");
      fsyncSync(mainFd);
      closeSync(mainFd);
    }

    ftruncateSync(this.walFd!, 0);

    if (this.syncMode !== "off") {
      fsyncSync(this.walFd!);
    }

    this.walSize = 0;
    this.mainFileSize = fullData.byteLength;
    this.cleanMainSize = fullData.byteLength;
  }

  /** Check integrity of both main file and WAL. Returns a combined report. */
  integrityCheck(): IntegrityReport {
    const combined: IntegrityReport = { totalRecords: 0, validRecords: 0, corruptRecords: [], ok: true };

    if (existsSync(this.mainPath)) {
      const buf = readFileBytes(this.mainPath);
      if (buf.byteLength >= 8) {
        const hasMagic = buf[0] === MAGIC[0] && buf[1] === MAGIC[1] && buf[2] === MAGIC[2] && buf[3] === MAGIC[3];
        if (hasMagic) {
          const { report } = readRecordsWithDiagnostics(buf, 8, false);
          combined.totalRecords += report.totalRecords;
          combined.validRecords += report.validRecords;
          for (const c of report.corruptRecords) combined.corruptRecords.push({ offset: c.offset, reason: `main: ${c.reason}` });
        }
      }
    }

    if (existsSync(this.walPath)) {
      const walBuf = readFileBytes(this.walPath);
      if (walBuf.byteLength > 0) {
        const { report } = readRecordsWithDiagnostics(walBuf, 0, false);
        combined.totalRecords += report.totalRecords;
        combined.validRecords += report.validRecords;
        for (const c of report.corruptRecords) combined.corruptRecords.push({ offset: c.offset, reason: `wal: ${c.reason}` });
      }
    }

    combined.ok = combined.corruptRecords.length === 0;
    return combined;
  }

  /** Repair by re-reading all records, skipping corrupt ones, and rewriting the main file + WAL. */
  repair(): IntegrityReport {
    const objects: ObjectMap = new Map();
    const combined: IntegrityReport = { totalRecords: 0, validRecords: 0, corruptRecords: [], ok: true };

    // Repair main file
    if (existsSync(this.mainPath)) {
      const buf = readFileBytes(this.mainPath);
      if (buf.byteLength >= 8) {
        const hasMagic = buf[0] === MAGIC[0] && buf[1] === MAGIC[1] && buf[2] === MAGIC[2] && buf[3] === MAGIC[3];
        if (hasMagic) {
          const { records, report } = readRecordsWithDiagnostics(buf, 8, true);
          applyRecords(objects, records);
          combined.totalRecords += report.totalRecords;
          combined.validRecords += report.validRecords;
          for (const c of report.corruptRecords) combined.corruptRecords.push({ offset: c.offset, reason: `main: ${c.reason}` });
        }
      }
    }

    // Repair WAL
    if (existsSync(this.walPath)) {
      const walBuf = readFileBytes(this.walPath);
      if (walBuf.byteLength > 0) {
        const { records, report } = readRecordsWithDiagnostics(walBuf, 0, true);
        applyRecords(objects, records);
        combined.totalRecords += report.totalRecords;
        combined.validRecords += report.validRecords;
        for (const c of report.corruptRecords) combined.corruptRecords.push({ offset: c.offset, reason: `wal: ${c.reason}` });
      }
    }

    // Rewrite clean main file and truncate WAL
    if (combined.corruptRecords.length > 0) {
      this.checkpoint(objects);
    }

    combined.ok = combined.corruptRecords.length === 0;
    return combined;
  }

  closeFd(): void {
    if (this.walFd !== null) {
      closeSync(this.walFd);
      this.walFd = null;
    }
  }

  close(objects: ObjectMap): void {
    this.checkpoint(objects);
    this.closeFd();
  }

  closeDiskIndex(diskIndex: DiskIndex): void {
    this.checkpointFromIterator(diskIndex.entries(), true);
    if (this.walFd !== null) {
      closeSync(this.walFd);
      this.walFd = null;
    }
  }
}
