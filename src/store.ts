import { copyFileSync, existsSync } from "node:fs";
import {
  ReadonlyError,
  type StoredObject,
  type S3ListObjectsOptions,
  type S3ListObjectsResponse,
  type S3Stats,
  type S3EventType,
  type S3EventCallback,
} from "./types";
import { WAL, type IntegrityReport } from "./wal";
import { BlobLog, type BlobAppendSession } from "./blob";
import { FileLock } from "./lock";
import { DiskIndex } from "./disk-index";
import { computeETag, guessMimeType } from "./utils";

type SyncMode = "full" | "normal" | "off";
type IndexMode = "memory" | "disk";

interface TxnPutOp {
  type: "put";
  bucket: string;
  key: string;
  data: Uint8Array;
  contentType?: string;
  contentDisposition?: string;
  expires?: number;
}

interface TxnDeleteOp {
  type: "delete";
  bucket: string;
  key: string;
}

type TxnOp = TxnPutOp | TxnDeleteOp;

export class TransactionContext {
  /** @internal */
  _ops: TxnOp[] = [];

  put(
    bucket: string,
    key: string,
    data: Uint8Array,
    contentType?: string,
    contentDisposition?: string,
    expires?: number,
  ): void {
    this._ops.push({ type: "put", bucket, key, data, contentType, contentDisposition, expires });
  }

  delete(bucket: string, key: string): void {
    this._ops.push({ type: "delete", bucket, key });
  }
}

export class Store {
  private objects: Map<string, Map<string, StoredObject>> = new Map();
  private diskIdx: DiskIndex | null = null;
  private wal: WAL | null = null;
  private blobLog: BlobLog | null = null;
  private lock: FileLock | null = null;
  private mainPath: string | null = null;
  private listeners: Map<S3EventType, Set<S3EventCallback>> = new Map();
  private inTransaction = false;
  private pendingEvents: Array<[S3EventType, string, string]> = [];
  private readOnly: boolean;

  constructor(path?: string, syncMode: SyncMode = "normal", indexMode: IndexMode = "memory", readOnly = false, lockStaleAfterMs?: number) {
    this.readOnly = readOnly;
    if (path) {
      this.mainPath = path;
      if (!readOnly) {
        this.lock = new FileLock(path, { staleAfterMs: lockStaleAfterMs });
        this.lock.acquire();
      }
      this.wal = new WAL(path, syncMode, undefined, readOnly);
      this.blobLog = new BlobLog(path + "-blobs", syncMode, readOnly);

      if (indexMode === "disk") {
        this.diskIdx = new DiskIndex(path);
        this.diskIdx.open();
        this.wal.openWithDiskIndex(this.diskIdx);
      } else {
        this.wal.open(this.objects);
      }
    }
  }

  // --- Index abstraction layer ---

  private indexGet(bucket: string, key: string): StoredObject | undefined {
    if (this.diskIdx) return this.diskIdx.get(bucket, key);
    return this.objects.get(bucket)?.get(key);
  }

  private indexSet(bucket: string, key: string, obj: StoredObject): void {
    if (this.diskIdx) {
      this.diskIdx.set(bucket, key, obj);
    } else {
      let bucketMap = this.objects.get(bucket);
      if (!bucketMap) {
        bucketMap = new Map();
        this.objects.set(bucket, bucketMap);
      }
      bucketMap.set(key, obj);
    }
  }

  private indexDelete(bucket: string, key: string): boolean {
    if (this.diskIdx) return this.diskIdx.delete(bucket, key);
    const bucketMap = this.objects.get(bucket);
    if (!bucketMap) return false;
    const existed = bucketMap.delete(key);
    if (existed && bucketMap.size === 0) this.objects.delete(bucket);
    return existed;
  }

  private indexHas(bucket: string, key: string): boolean {
    if (this.diskIdx) return this.diskIdx.has(bucket, key);
    return this.objects.get(bucket)?.has(key) ?? false;
  }

  private *sortedBucketEntries(bucket: string): IterableIterator<[string, StoredObject]> {
    const bucketMap = this.objects.get(bucket);
    if (!bucketMap) return;
    const keys = [...bucketMap.keys()].sort();
    for (const key of keys) {
      yield [key, bucketMap.get(key)!];
    }
  }

  /** Whether this store can accept streaming writes (i.e. has a blob log). */
  get supportsStreaming(): boolean {
    return this.blobLog !== null;
  }

  /**
   * Begin a synchronous chunked write. Returned handle exposes a `write(chunk)`
   * method that flushes to disk immediately and a `finish(...)` method that
   * commits the WAL/index entry. Requires a file-backed store.
   */
  beginPutSync(bucket: string, key: string): StorePutSession {
    if (this.readOnly) throw new ReadonlyError("put");
    if (!this.blobLog) throw new Error("beginPutSync requires blob storage (file-backed store)");
    return new StorePutSession(this, this.blobLog, bucket, key);
  }

  /** @internal */
  _finishPutSync(
    bucket: string,
    key: string,
    offset: number,
    length: number,
    etag: string,
    contentType?: string,
    contentDisposition?: string,
    expires?: number,
  ): { size: number; etag: string } {
    const resolvedType = contentType ?? guessMimeType(key);
    const lastModified = new Date();
    const expiresAt = expires ? Date.now() + expires * 1000 : undefined;

    const existing = this.indexGet(bucket, key);
    if (existing?.blobLength) this.blobLog!.markDead(existing.blobLength);

    const metadata: Record<string, unknown> = {
      contentType: resolvedType,
      etag,
      lastModified: lastModified.toISOString(),
      blobOffset: offset,
      blobLength: length,
    };
    if (contentDisposition) metadata.contentDisposition = contentDisposition;
    if (expiresAt) metadata.expiresAt = expiresAt;

    this.wal!.appendPut(bucket, key, null, metadata);
    this.indexSet(bucket, key, {
      data: null, size: length, etag, contentType: resolvedType,
      lastModified, contentDisposition, expiresAt, blobOffset: offset, blobLength: length,
    });

    if (!this.inTransaction) {
      if (this.blobLog!.shouldCompact()) {
        this.compactAndCheckpoint();
      } else if (this.wal!.shouldCheckpoint() || (this.diskIdx && this.diskIdx.shouldCompactOverlay())) {
        if (this.diskIdx) {
          this.wal!.checkpointFromIterator(this.diskIdx.entries(), true);
          this.diskIdx.reopen();
        } else {
          this.wal!.incrementalCheckpoint();
        }
      }
    }

    this.emit("put", bucket, key);
    return { size: length, etag };
  }

  on(event: S3EventType, callback: S3EventCallback): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: S3EventType, callback: S3EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: S3EventType, bucket: string, key: string): void {
    if (this.inTransaction) {
      this.pendingEvents.push([event, bucket, key]);
      return;
    }
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) cb(bucket, key);
    }
  }

  private flushEvents(): void {
    for (const [event, bucket, key] of this.pendingEvents) {
      const set = this.listeners.get(event);
      if (set) {
        for (const cb of set) cb(bucket, key);
      }
    }
    this.pendingEvents = [];
  }

  put(
    bucket: string,
    key: string,
    data: Uint8Array,
    contentType?: string,
    contentDisposition?: string,
    expires?: number,
  ): void {
    if (this.readOnly) throw new ReadonlyError("put");
    const etag = computeETag(data);
    const lastModified = new Date();
    const resolvedType = contentType ?? guessMimeType(key);
    const expiresAt = expires ? Date.now() + expires * 1000 : undefined;

    if (this.blobLog) {
      // Mark old blob data as dead if overwriting
      const existing = this.indexGet(bucket, key);
      if (existing?.blobLength) this.blobLog.markDead(existing.blobLength);

      const { offset, length } = this.blobLog.append(data);
      const metadata: Record<string, unknown> = {
        contentType: resolvedType,
        etag,
        lastModified: lastModified.toISOString(),
        blobOffset: offset,
        blobLength: length,
      };
      if (contentDisposition) metadata.contentDisposition = contentDisposition;
      if (expiresAt) metadata.expiresAt = expiresAt;

      this.wal!.appendPut(bucket, key, null, metadata);
      this.indexSet(bucket, key, {
        data: null, size: length, etag, contentType: resolvedType,
        lastModified, contentDisposition, expiresAt, blobOffset: offset, blobLength: length,
      });

      if (!this.inTransaction) {
        if (this.blobLog.shouldCompact()) {
          this.compactAndCheckpoint();
        } else if (this.wal!.shouldCheckpoint() || (this.diskIdx && this.diskIdx.shouldCompactOverlay())) {
          if (this.diskIdx) {
            // Disk index requires sorted main file; do full checkpoint
            this.wal!.checkpointFromIterator(this.diskIdx.entries(), true);
            this.diskIdx.reopen();
          } else {
            this.wal!.incrementalCheckpoint();
          }
        }
      }
    } else {
      // In-memory mode
      this.indexSet(bucket, key, {
        data, size: data.byteLength, etag, contentType: resolvedType,
        lastModified, contentDisposition, expiresAt,
      });
    }

    this.emit("put", bucket, key);
  }

  private isExpired(obj: StoredObject): boolean {
    return obj.expiresAt !== undefined && Date.now() > obj.expiresAt;
  }

  private getObject(bucket: string, key: string): StoredObject | undefined {
    const obj = this.indexGet(bucket, key);
    if (!obj) return undefined;
    if (this.isExpired(obj)) {
      if (!this.readOnly) this.delete(bucket, key);
      return undefined;
    }
    return obj;
  }

  private loadData(obj: StoredObject): Uint8Array {
    if (obj.data !== null) return obj.data;
    if (this.blobLog && obj.blobOffset !== undefined && obj.blobLength !== undefined) {
      return this.blobLog.read(obj.blobOffset, obj.blobLength);
    }
    throw new Error("Object has no data and no blob reference");
  }

  get(bucket: string, key: string): StoredObject | undefined {
    const obj = this.getObject(bucket, key);
    if (!obj) return undefined;
    if (obj.data === null) {
      return { ...obj, data: this.loadData(obj) };
    }
    return obj;
  }

  getRange(
    bucket: string,
    key: string,
    start: number,
    end: number,
  ): Uint8Array | undefined {
    const obj = this.getObject(bucket, key);
    if (!obj) return undefined;

    if (this.blobLog && obj.blobOffset !== undefined && obj.blobLength !== undefined) {
      return this.blobLog.readRange(obj.blobOffset, obj.blobLength, start, end);
    }

    if (!obj.data) return undefined;
    return obj.data.slice(start, end);
  }

  getReadStream(bucket: string, key: string, chunkSize?: number): ReadableStream<Uint8Array> | undefined {
    const obj = this.getObject(bucket, key);
    if (!obj) return undefined;

    if (this.blobLog && obj.blobOffset !== undefined && obj.blobLength !== undefined) {
      return this.blobLog.createReadStream(obj.blobOffset, obj.blobLength, chunkSize);
    }

    // In-memory: wrap data in a single-chunk stream
    const data = obj.data;
    if (!data) return undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  async putStream(
    bucket: string,
    key: string,
    stream: ReadableStream<Uint8Array>,
    contentType?: string,
    contentDisposition?: string,
    expires?: number,
  ): Promise<{ size: number; etag: string }> {
    if (this.readOnly) throw new ReadonlyError("put");
    if (!this.blobLog) throw new Error("putStream requires blob storage (file-backed store)");

    const resolvedType = contentType ?? guessMimeType(key);
    const lastModified = new Date();
    const expiresAt = expires ? Date.now() + expires * 1000 : undefined;

    // Mark old blob data as dead if overwriting
    const existing = this.indexGet(bucket, key);
    if (existing?.blobLength) this.blobLog.markDead(existing.blobLength);

    const { offset, length, etag } = await this.blobLog.appendStream(stream);

    const metadata: Record<string, unknown> = {
      contentType: resolvedType,
      etag,
      lastModified: lastModified.toISOString(),
      blobOffset: offset,
      blobLength: length,
    };
    if (contentDisposition) metadata.contentDisposition = contentDisposition;
    if (expiresAt) metadata.expiresAt = expiresAt;

    this.wal!.appendPut(bucket, key, null, metadata);
    this.indexSet(bucket, key, {
      data: null, size: length, etag, contentType: resolvedType,
      lastModified, contentDisposition, expiresAt, blobOffset: offset, blobLength: length,
    });

    if (!this.inTransaction) {
      if (this.blobLog.shouldCompact()) {
        this.compactAndCheckpoint();
      } else if (this.wal!.shouldCheckpoint() || (this.diskIdx && this.diskIdx.shouldCompactOverlay())) {
        if (this.diskIdx) {
          this.wal!.checkpointFromIterator(this.diskIdx.entries(), true);
          this.diskIdx.reopen();
        } else {
          this.wal!.incrementalCheckpoint();
        }
      }
    }

    this.emit("put", bucket, key);
    return { size: length, etag };
  }

  delete(bucket: string, key: string): boolean {
    if (this.readOnly) throw new ReadonlyError("delete");
    const obj = this.indexGet(bucket, key);
    if (!obj) return false;
    const existed = this.indexDelete(bucket, key);
    if (existed) {
      if (this.blobLog && obj.blobLength) {
        this.blobLog.markDead(obj.blobLength);
      }
      if (this.wal) this.wal.appendDelete(bucket, key);
      this.emit("delete", bucket, key);
    }
    return existed;
  }

  exists(bucket: string, key: string): boolean {
    const obj = this.indexGet(bucket, key);
    if (!obj) return false;
    if (this.isExpired(obj)) {
      if (!this.readOnly) this.delete(bucket, key);
      return false;
    }
    return true;
  }

  stat(bucket: string, key: string): S3Stats | undefined {
    const obj = this.getObject(bucket, key);
    if (!obj) return undefined;
    return {
      size: obj.size,
      lastModified: obj.lastModified,
      etag: obj.etag,
      type: obj.contentType,
    };
  }

  copy(
    srcBucket: string,
    srcKey: string,
    destBucket: string,
    destKey: string,
  ): boolean {
    if (this.readOnly) throw new ReadonlyError("copy");
    const obj = this.getObject(srcBucket, srcKey);
    if (!obj) return false;

    const data = this.loadData(obj);
    const now = new Date();

    if (this.blobLog) {
      const { offset, length } = this.blobLog.append(data);
      const metadata: Record<string, unknown> = {
        contentType: obj.contentType,
        etag: obj.etag,
        lastModified: now.toISOString(),
        blobOffset: offset,
        blobLength: length,
      };
      if (obj.contentDisposition) metadata.contentDisposition = obj.contentDisposition;
      if (obj.expiresAt) metadata.expiresAt = obj.expiresAt;

      this.wal!.appendPut(destBucket, destKey, null, metadata);
      this.indexSet(destBucket, destKey, {
        data: null, size: length, etag: obj.etag, contentType: obj.contentType,
        lastModified: now, contentDisposition: obj.contentDisposition,
        expiresAt: obj.expiresAt, blobOffset: offset, blobLength: length,
      });
    } else {
      this.indexSet(destBucket, destKey, {
        data: data.slice(), size: data.byteLength, etag: obj.etag,
        contentType: obj.contentType, lastModified: now,
        contentDisposition: obj.contentDisposition, expiresAt: obj.expiresAt,
      });
    }

    this.emit("copy", destBucket, destKey);
    return true;
  }

  list(
    bucket: string,
    opts?: S3ListObjectsOptions,
  ): S3ListObjectsResponse {
    const prefix = opts?.prefix ?? "";
    const delimiter = opts?.delimiter;
    const maxKeys = opts?.maxKeys ?? 1000;
    const effectiveStartAfter = opts?.continuationToken ?? opts?.startAfter;

    // Iterate entries — disk index yields sorted, in-memory needs sorting
    const commonPrefixSet = new Set<string>();
    const contents: NonNullable<S3ListObjectsResponse["contents"]> = [];
    let itemCount = 0;
    let isTruncated = false;

    const iterate = this.diskIdx
      ? this.diskIdx.bucketEntries(bucket)
      : this.sortedBucketEntries(bucket);

    for (const [key, obj] of iterate) {
      if (!key.startsWith(prefix)) continue;
      if (this.isExpired(obj)) {
        if (!this.readOnly) this.delete(bucket, key);
        continue;
      }
      if (effectiveStartAfter && key <= effectiveStartAfter) continue;

      if (itemCount >= maxKeys) {
        isTruncated = true;
        break;
      }

      if (delimiter) {
        const rest = key.slice(prefix.length);
        const delimIdx = rest.indexOf(delimiter);
        if (delimIdx !== -1) {
          const cp = prefix + rest.slice(0, delimIdx + delimiter.length);
          if (!commonPrefixSet.has(cp)) {
            commonPrefixSet.add(cp);
            itemCount++;
          }
          continue;
        }
      }
      contents.push({
        key,
        eTag: obj.etag,
        lastModified: obj.lastModified.toISOString(),
        size: obj.size,
      });
      itemCount++;
    }

    const commonPrefixes = [...commonPrefixSet]
      .sort()
      .map((p) => ({ prefix: p }));

    const response: S3ListObjectsResponse = {
      contents: contents.length > 0 ? contents : undefined,
      commonPrefixes: commonPrefixes.length > 0 ? commonPrefixes : undefined,
      isTruncated,
      keyCount: contents.length,
      maxKeys,
      prefix: prefix || undefined,
      delimiter,
      name: bucket,
      continuationToken: opts?.continuationToken,
      startAfter: opts?.startAfter,
    };

    if (isTruncated && contents.length > 0) {
      const lastKey = contents[contents.length - 1]!.key;
      response.nextContinuationToken = lastKey;
    }

    return response;
  }

  private compactAndCheckpoint(): void {
    if (!this.blobLog || !this.wal) return;

    if (this.diskIdx) {
      // Materialize all entries (disk reads are ephemeral, can't update in-place)
      const allEntries: Array<[string, string, StoredObject]> = [...this.diskIdx.entries()];

      const liveEntries: { oldOffset: number; length: number }[] = [];
      for (const [, , obj] of allEntries) {
        if (obj.blobOffset !== undefined && obj.blobLength !== undefined) {
          liveEntries.push({ oldOffset: obj.blobOffset, length: obj.blobLength });
        }
      }

      const offsetMap = this.blobLog.compact(liveEntries);

      for (const [, , obj] of allEntries) {
        if (obj.blobOffset !== undefined) {
          const newOffset = offsetMap.get(obj.blobOffset);
          if (newOffset !== undefined) obj.blobOffset = newOffset;
        }
      }

      this.wal.checkpointFromIterator(allEntries, true);
      this.diskIdx.reopen();
    } else {
      const liveEntries: { oldOffset: number; length: number }[] = [];
      for (const [, bucketMap] of this.objects) {
        for (const [, obj] of bucketMap) {
          if (obj.blobOffset !== undefined && obj.blobLength !== undefined) {
            liveEntries.push({ oldOffset: obj.blobOffset, length: obj.blobLength });
          }
        }
      }

      const offsetMap = this.blobLog.compact(liveEntries);

      for (const [, bucketMap] of this.objects) {
        for (const [, obj] of bucketMap) {
          if (obj.blobOffset !== undefined) {
            const newOffset = offsetMap.get(obj.blobOffset);
            if (newOffset !== undefined) obj.blobOffset = newOffset;
          }
        }
      }

      this.wal.checkpoint(this.objects, true);
    }
  }

  transaction(fn: (txn: TransactionContext) => void): void {
    if (this.readOnly) throw new ReadonlyError("transaction");
    if (this.inTransaction) throw new Error("Nested transactions are not supported");

    const txn = new TransactionContext();
    fn(txn);

    if (txn._ops.length === 0) return;

    this.inTransaction = true;

    if (this.wal) {
      this.wal.beginBatch();
      this.wal.appendTxnBegin();
    }

    // Snapshot affected keys for rollback
    const snapshots = new Map<string, StoredObject | undefined>();
    for (const op of txn._ops) {
      const snapKey = op.bucket + "\0" + op.key;
      if (!snapshots.has(snapKey)) {
        const existing = this.indexGet(op.bucket, op.key);
        snapshots.set(snapKey, existing ? { ...existing } : undefined);
      }
    }

    try {
      for (const op of txn._ops) {
        if (op.type === "put") {
          this.put(op.bucket, op.key, op.data, op.contentType, op.contentDisposition, op.expires);
        } else {
          this.delete(op.bucket, op.key);
        }
      }
    } catch (err) {
      this.inTransaction = false;
      this.pendingEvents = [];
      // Rollback using snapshots
      for (const [snapKey, original] of snapshots) {
        const [bucket, key] = snapKey.split("\0") as [string, string];
        if (original) {
          this.indexSet(bucket, key, original);
        } else {
          this.indexDelete(bucket, key);
        }
      }
      if (this.wal) {
        this.wal.discardBatch();
        this.wal.truncateUncommitted();
      }
      throw err;
    }

    this.inTransaction = false;

    if (this.wal) {
      this.wal.appendTxnCommit();
    }

    this.flushEvents();
  }

  checkpoint(): void {
    if (this.readOnly) throw new ReadonlyError("checkpoint");
    if (!this.wal) return;

    if (this.blobLog) {
      // Blob compaction needs offset remapping — always full
      this.compactAndCheckpoint();
    } else if (this.diskIdx) {
      // Disk index requires sorted main file — always full
      this.wal.checkpointFromIterator(this.diskIdx.entries());
      this.diskIdx.reopen();
    } else if (this.wal.shouldFullCompact()) {
      // Main file has too many stale entries from incremental appends — full rewrite
      this.wal.checkpoint(this.objects);
    } else {
      // Fast path: append WAL to main file
      this.wal.incrementalCheckpoint();
    }
  }

  /** Check integrity of the database files without modifying anything. */
  integrityCheck(): IntegrityReport {
    if (!this.wal) return { totalRecords: 0, validRecords: 0, corruptRecords: [], ok: true };
    return this.wal.integrityCheck();
  }

  /** Repair corrupt records by skipping them and rewriting clean data. Returns report of what was found. */
  repair(): IntegrityReport {
    if (this.readOnly) throw new ReadonlyError("repair");
    if (!this.wal) return { totalRecords: 0, validRecords: 0, corruptRecords: [], ok: true };
    return this.wal.repair();
  }

  /** Create a consistent backup of the database at destPath. */
  backup(destPath: string): void {
    if (this.readOnly) throw new ReadonlyError("backup");
    if (!this.wal) throw new Error("Cannot backup an in-memory store");

    // Checkpoint to flush WAL into main file, producing a self-contained snapshot
    this.checkpoint();

    // Copy the main file
    copyFileSync(this.mainPath!, destPath);

    // Copy blob file if it exists
    const blobPath = this.mainPath! + "-blobs";
    if (existsSync(blobPath)) {
      copyFileSync(blobPath, destPath + "-blobs");
    }
  }

  close(): void {
    if (this.readOnly) {
      if (this.blobLog) this.blobLog.close();
      if (this.wal) this.wal.closeFd();
      if (this.diskIdx) this.diskIdx.close();
      return;
    }
    if (this.diskIdx) {
      if (this.blobLog) {
        this.compactAndCheckpoint();
        this.blobLog.close();
      } else if (this.wal) {
        this.wal.checkpointFromIterator(this.diskIdx.entries());
        this.wal.closeFd();
      }
      this.diskIdx.close();
    } else {
      if (this.blobLog) {
        this.compactAndCheckpoint();
        this.blobLog.close();
      } else if (this.wal) {
        this.wal.close(this.objects);
      }
    }
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }
}

/**
 * Streaming put session returned from `Store.beginPutSync`. Each `write()`
 * synchronously writes the chunk to the blob file; `end(opts)` commits the
 * WAL/index entry. No internal chunk buffering.
 */
export class StorePutSession {
  private store: Store;
  private session: BlobAppendSession;
  private bucket: string;
  private key: string;
  private finished = false;

  constructor(store: Store, blobLog: BlobLog, bucket: string, key: string) {
    this.store = store;
    this.bucket = bucket;
    this.key = key;
    this.session = blobLog.beginAppendSync();
  }

  write(chunk: Uint8Array): number {
    if (this.finished) throw new Error("StorePutSession: write after end()");
    this.session.write(chunk);
    return chunk.byteLength;
  }

  end(opts?: { contentType?: string; contentDisposition?: string; expires?: number }): { size: number; etag: string } {
    if (this.finished) throw new Error("StorePutSession: already ended");
    this.finished = true;
    const { offset, length, etag } = this.session.finish();
    return this.store._finishPutSync(
      this.bucket, this.key, offset, length, etag,
      opts?.contentType, opts?.contentDisposition, opts?.expires,
    );
  }
}
