import { existsSync } from "node:fs";
import {
  readFileSync as nodeReadFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import {
  MAGIC,
  FORMAT_VERSION,
  WalOp,
  type StoredObject,
} from "./types";
import { crc32, concatUint8Arrays } from "./utils";

type ObjectMap = Map<string, Map<string, StoredObject>>;

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
  const encoder = new TextEncoder();
  const bucketBytes = encoder.encode(bucket);
  const keyBytes = encoder.encode(key);
  const metaBytes = encoder.encode(
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

function readRecords(data: Uint8Array, startOffset: number): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = startOffset;
  const decoder = new TextDecoder();

  while (offset < data.byteLength) {
    const recordStart = offset;

    if (offset + 1 > data.byteLength) break;
    const op = data[offset++] as WalOp;
    if (op !== WalOp.PUT && op !== WalOp.DELETE) break;

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

function applyRecords(objects: ObjectMap, records: ParsedRecord[]): void {
  for (const rec of records) {
    if (rec.op === WalOp.PUT) {
      const blobOffset = rec.metadata.blobOffset as number | undefined;
      const blobLength = rec.metadata.blobLength as number | undefined;

      // Need either inline data or a blob reference
      if (!rec.objectData && blobOffset === undefined) continue;

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
}

function readFileBytes(path: string): Uint8Array {
  const buf = nodeReadFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export class WAL {
  private mainPath: string;
  private walPath: string;
  private walSize = 0;
  private checkpointThreshold: number;

  constructor(path: string, checkpointThreshold = 10 * 1024 * 1024) {
    this.mainPath = path;
    this.walPath = path + "-wal";
    this.checkpointThreshold = checkpointThreshold;
  }

  open(objects: ObjectMap): void {
    // Read main file
    if (existsSync(this.mainPath)) {
      const buf = readFileBytes(this.mainPath);
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

    // Ensure WAL file exists
    if (!existsSync(this.walPath)) {
      writeFileSync(this.walPath, new Uint8Array(0));
    }
  }

  appendPut(
    bucket: string,
    key: string,
    data: Uint8Array | null,
    metadata: Record<string, unknown>,
  ): void {
    const record = encodeRecord(WalOp.PUT, bucket, key, metadata, data);
    appendFileSync(this.walPath, record);
    this.walSize += record.byteLength;
  }

  appendDelete(bucket: string, key: string): void {
    const record = encodeRecord(WalOp.DELETE, bucket, key, null, null);
    appendFileSync(this.walPath, record);
    this.walSize += record.byteLength;
  }

  shouldCheckpoint(): boolean {
    return this.walSize >= this.checkpointThreshold;
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
    writeFileSync(this.mainPath, fullData);

    // Truncate WAL
    writeFileSync(this.walPath, new Uint8Array(0));
    this.walSize = 0;
  }

  close(objects: ObjectMap): void {
    this.checkpoint(objects);
  }
}
