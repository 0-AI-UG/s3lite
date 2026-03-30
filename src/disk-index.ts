import {
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import type { StoredObject } from "./types";
import { WalOp, MAGIC, FORMAT_VERSION } from "./types";
import { crc32 } from "./utils";

/** Composite key: bucket + NUL + key */
function compositeKey(bucket: string, key: string): string {
  return bucket + "\0" + key;
}

function splitComposite(ck: string): [string, string] {
  const idx = ck.indexOf("\0");
  return [ck.slice(0, idx), ck.slice(idx + 1)];
}

interface SparseEntry {
  compositeKey: string;
  fileOffset: number;
}

interface DiskRecord {
  compositeKey: string;
  obj: StoredObject;
  fileOffset: number;
  recordLength: number;
}

const SPARSE_INTERVAL = 64;

/**
 * Disk-resident index with sparse in-memory index and WAL overlay.
 * Keeps only ~1/SPARSE_INTERVAL of keys in memory for binary search,
 * reads metadata from disk on demand.
 */
export class DiskIndex {
  private mainPath: string;
  private mainFd: number | null = null;
  private mainSize = 0;
  private sparseIndex: SparseEntry[] = [];
  private totalCount = 0;
  /** Overlay: compositeKey → StoredObject | null (null = tombstone) */
  private overlay: Map<string, StoredObject | null> = new Map();
  /** Track which bucket+keys exist on disk (not in overlay). Needed for accurate has/delete. */
  private diskKeyCount = 0;
  private headerSize = 8; // MAGIC(4) + VERSION(4)
  private headerBuf = Buffer.allocUnsafe(4096);

  constructor(mainPath: string) {
    this.mainPath = mainPath;
  }

  /** Open and scan the main file to build sparse index. Does NOT load all metadata. */
  open(): void {
    if (!existsSync(this.mainPath)) return;

    this.mainFd = openSync(this.mainPath, "r");
    const stat = require("node:fs").fstatSync(this.mainFd);
    this.mainSize = stat.size;

    if (this.mainSize < this.headerSize) return;

    // Verify header
    const headerBuf = Buffer.alloc(this.headerSize);
    readSync(this.mainFd, headerBuf, 0, this.headerSize, 0);
    if (
      headerBuf[0] !== MAGIC[0] ||
      headerBuf[1] !== MAGIC[1] ||
      headerBuf[2] !== MAGIC[2] ||
      headerBuf[3] !== MAGIC[3]
    ) return;

    const version = headerBuf.readUInt32LE(4);
    if (version !== FORMAT_VERSION) return;

    // Scan all records to build sparse index
    this.buildSparseIndex();
  }

  private buildSparseIndex(): void {
    this.sparseIndex = [];
    this.totalCount = 0;

    let offset = this.headerSize;
    const decoder = new TextDecoder();

    while (offset < this.mainSize) {
      const recordStart = offset;
      const rec = this.readRecordHeader(offset);
      if (!rec) break;

      const ck = compositeKey(rec.bucket, rec.key);

      if (this.totalCount % SPARSE_INTERVAL === 0) {
        this.sparseIndex.push({ compositeKey: ck, fileOffset: recordStart });
      }

      this.totalCount++;
      offset = rec.nextOffset;
    }

    this.diskKeyCount = this.totalCount;
  }

  /** Read a record's header (op, bucket, key, meta) and compute nextOffset, without loading data. */
  private readRecordHeader(offset: number): {
    op: number;
    bucket: string;
    key: string;
    metaStr: string;
    dataLen: number;
    dataOffset: number;
    nextOffset: number;
  } | null {
    if (!this.mainFd || offset >= this.mainSize) return null;

    // Read enough for the header portion. Records have variable sizes.
    // We read in stages to minimize reads.
    // op(1) + bucketLen(2) = 3 bytes minimum
    const bytesAvailable = Math.min(4096, this.mainSize - offset);
    readSync(this.mainFd, this.headerBuf, 0, bytesAvailable, offset);
    const headerBuf = this.headerBuf;

    const view = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
    const decoder = new TextDecoder();
    let pos = 0;

    if (pos + 1 > bytesAvailable) return null;
    const op = headerBuf[pos++]!;
    if (op !== WalOp.PUT && op !== WalOp.DELETE) return null;

    if (pos + 2 > bytesAvailable) return null;
    const bucketLen = view.getUint16(pos, true);
    pos += 2;
    if (pos + bucketLen > bytesAvailable) return null;
    const bucket = decoder.decode(headerBuf.subarray(pos, pos + bucketLen));
    pos += bucketLen;

    if (pos + 2 > bytesAvailable) return null;
    const keyLen = view.getUint16(pos, true);
    pos += 2;
    if (pos + keyLen > bytesAvailable) return null;
    const key = decoder.decode(headerBuf.subarray(pos, pos + keyLen));
    pos += keyLen;

    if (pos + 4 > bytesAvailable) return null;
    const metaLen = view.getUint32(pos, true);
    pos += 4;

    // Meta might exceed our 4KB buffer — read more if needed
    let metaStr: string;
    if (pos + metaLen <= bytesAvailable) {
      metaStr = decoder.decode(headerBuf.subarray(pos, pos + metaLen));
      pos += metaLen;
    } else {
      const metaBuf = Buffer.alloc(metaLen);
      readSync(this.mainFd, metaBuf, 0, metaLen, offset + pos);
      metaStr = decoder.decode(metaBuf);
      pos += metaLen;
    }

    // Read data length
    let dataLen: number;
    if (pos + 4 <= bytesAvailable) {
      dataLen = view.getUint32(pos, true);
    } else {
      const dlBuf = Buffer.alloc(4);
      readSync(this.mainFd, dlBuf, 0, 4, offset + pos);
      dataLen = dlBuf.readUInt32LE(0);
    }
    pos += 4;

    const dataOffset = offset + pos;
    pos += dataLen;
    pos += 4; // CRC

    return {
      op,
      bucket,
      key,
      metaStr,
      dataLen,
      dataOffset,
      nextOffset: offset + pos,
    };
  }

  /** Read a full record from disk including data, and parse into StoredObject. */
  private readFullRecord(offset: number): DiskRecord | null {
    const header = this.readRecordHeader(offset);
    if (!header || header.op !== WalOp.PUT) return null;

    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(header.metaStr);
    } catch {
      return null;
    }

    const blobOffset = metadata.blobOffset as number | undefined;
    const blobLength = metadata.blobLength as number | undefined;

    let data: Uint8Array | null = null;
    if (header.dataLen > 0 && this.mainFd) {
      const buf = Buffer.alloc(header.dataLen);
      readSync(this.mainFd, buf, 0, header.dataLen, header.dataOffset);
      data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }

    if (!data && blobOffset === undefined) return null;

    const obj: StoredObject = {
      data,
      size: data?.byteLength ?? blobLength ?? 0,
      etag: (metadata.etag as string) ?? "",
      contentType: (metadata.contentType as string) ?? "application/octet-stream",
      lastModified: new Date((metadata.lastModified as string) ?? Date.now()),
      contentDisposition: metadata.contentDisposition as string | undefined,
      expiresAt: metadata.expiresAt as number | undefined,
      blobOffset,
      blobLength,
    };

    return {
      compositeKey: compositeKey(header.bucket, header.key),
      obj,
      fileOffset: offset,
      recordLength: header.nextOffset - offset,
    };
  }

  /** Binary search the sparse index to find the page containing the key. */
  private findSparseOffset(ck: string): number {
    if (this.sparseIndex.length === 0) return this.headerSize;

    let lo = 0;
    let hi = this.sparseIndex.length - 1;
    let result = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sparseIndex[mid]!.compositeKey <= ck) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return this.sparseIndex[result]!.fileOffset;
  }

  /** Look up a key from disk using sparse index + sequential scan. */
  private diskGet(bucket: string, key: string): StoredObject | undefined {
    if (!this.mainFd || this.diskKeyCount === 0) return undefined;

    const ck = compositeKey(bucket, key);
    let offset = this.findSparseOffset(ck);

    // Scan forward from the sparse entry
    while (offset < this.mainSize) {
      const rec = this.readFullRecord(offset);
      if (!rec) break;

      if (rec.compositeKey === ck) return rec.obj;
      if (rec.compositeKey > ck) break; // Past the key, not found

      offset += rec.recordLength;
    }

    return undefined;
  }

  /** Check if a key exists on disk. */
  private diskHas(bucket: string, key: string): boolean {
    if (!this.mainFd || this.diskKeyCount === 0) return false;

    const ck = compositeKey(bucket, key);
    let offset = this.findSparseOffset(ck);

    while (offset < this.mainSize) {
      const header = this.readRecordHeader(offset);
      if (!header) break;

      const rck = compositeKey(header.bucket, header.key);
      if (rck === ck) return true;
      if (rck > ck) break;

      offset = header.nextOffset;
    }

    return false;
  }

  // --- Public API ---

  get(bucket: string, key: string): StoredObject | undefined {
    const ck = compositeKey(bucket, key);
    if (this.overlay.has(ck)) {
      const val = this.overlay.get(ck);
      return val === null ? undefined : val; // null = tombstone
    }
    return this.diskGet(bucket, key);
  }

  set(bucket: string, key: string, obj: StoredObject): void {
    this.overlay.set(compositeKey(bucket, key), obj);
  }

  delete(bucket: string, key: string): boolean {
    const ck = compositeKey(bucket, key);
    const hadInOverlay = this.overlay.has(ck) && this.overlay.get(ck) !== null;
    const hadOnDisk = !this.overlay.has(ck) && this.diskHas(bucket, key);

    if (hadInOverlay || hadOnDisk) {
      this.overlay.set(ck, null); // tombstone
      return true;
    }
    return false;
  }

  has(bucket: string, key: string): boolean {
    const ck = compositeKey(bucket, key);
    if (this.overlay.has(ck)) {
      return this.overlay.get(ck) !== null;
    }
    return this.diskHas(bucket, key);
  }

  /** Apply overlay entries from WAL replay. */
  applyWalRecord(
    op: number,
    bucket: string,
    key: string,
    obj: StoredObject | null,
  ): void {
    const ck = compositeKey(bucket, key);
    if (op === WalOp.PUT && obj) {
      this.overlay.set(ck, obj);
    } else if (op === WalOp.DELETE) {
      this.overlay.set(ck, null);
    }
  }

  /** Get the overlay map (for rollback/snapshot). */
  getOverlay(): Map<string, StoredObject | null> {
    return this.overlay;
  }

  /** Iterate all entries (disk + overlay), sorted by compositeKey. Yields [bucket, key, obj]. */
  *entries(): IterableIterator<[string, string, StoredObject]> {
    // Collect sorted overlay entries
    const overlayEntries = [...this.overlay.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    );
    let oIdx = 0;

    // Scan disk sequentially
    let diskOffset = this.mainFd ? this.headerSize : this.mainSize + 1;

    let diskRec = this.nextDiskRecord(diskOffset);
    let overlayEntry = oIdx < overlayEntries.length ? overlayEntries[oIdx] : null;

    while (diskRec || overlayEntry) {
      let useDisk = false;
      let useOverlay = false;

      if (diskRec && overlayEntry) {
        if (diskRec.compositeKey < overlayEntry[0]) {
          useDisk = true;
        } else if (diskRec.compositeKey > overlayEntry[0]) {
          useOverlay = true;
        } else {
          // Same key — overlay wins, skip disk
          useOverlay = true;
          diskRec = this.nextDiskRecord(diskRec.fileOffset + diskRec.recordLength);
        }
      } else if (diskRec) {
        useDisk = true;
      } else {
        useOverlay = true;
      }

      if (useDisk && diskRec) {
        const [bucket, key] = splitComposite(diskRec.compositeKey);
        yield [bucket, key, diskRec.obj];
        diskRec = this.nextDiskRecord(diskRec.fileOffset + diskRec.recordLength);
      }

      if (useOverlay && overlayEntry) {
        const val = overlayEntry[1];
        if (val !== null) {
          const [bucket, key] = splitComposite(overlayEntry[0]);
          yield [bucket, key, val];
        }
        oIdx++;
        overlayEntry = oIdx < overlayEntries.length ? overlayEntries[oIdx] : null;
      }
    }
  }

  /** Iterate entries for a specific bucket, sorted by key. */
  *bucketEntries(bucket: string): IterableIterator<[string, StoredObject]> {
    for (const [b, k, obj] of this.entries()) {
      if (b === bucket) yield [k, obj];
      // Since entries are sorted by bucket\0key, once we pass the bucket we're done
      else if (b > bucket) break;
    }
  }

  /** Read the next PUT record from disk at or after the given offset. */
  private nextDiskRecord(offset: number): DiskRecord | null {
    if (!this.mainFd) return null;
    while (offset < this.mainSize) {
      const rec = this.readFullRecord(offset);
      if (!rec) return null;
      if (rec.obj) return rec;
      offset += rec.recordLength;
    }
    return null;
  }

  /** Clear the overlay (called after checkpoint). */
  clearOverlay(): void {
    this.overlay.clear();
  }

  /** Rebuild sparse index after checkpoint writes a new main file. */
  reopen(): void {
    if (this.mainFd !== null) {
      closeSync(this.mainFd);
      this.mainFd = null;
    }
    this.sparseIndex = [];
    this.totalCount = 0;
    this.diskKeyCount = 0;
    this.overlay.clear();
    this.open();
  }

  close(): void {
    if (this.mainFd !== null) {
      closeSync(this.mainFd);
      this.mainFd = null;
    }
  }

  /** Get the total number of live entries (approximate — includes overlay). */
  get size(): number {
    // Approximate: disk keys + net overlay additions (no disk I/O)
    let adds = 0;
    let tombstones = 0;
    for (const val of this.overlay.values()) {
      if (val === null) tombstones++;
      else adds++;
    }
    // Overlay entries either shadow disk keys or add new ones.
    // Worst case: all adds are new, all tombstones shadow disk keys.
    return Math.max(0, this.diskKeyCount - tombstones + adds);
  }
}
