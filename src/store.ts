import type {
  StoredObject,
  S3ListObjectsOptions,
  S3ListObjectsResponse,
  S3Stats,
  S3EventType,
  S3EventCallback,
} from "./types";
import { WAL } from "./wal";
import { BlobLog } from "./blob";
import { computeETag, guessMimeType } from "./utils";

export class Store {
  private objects: Map<string, Map<string, StoredObject>> = new Map();
  private wal: WAL | null = null;
  private blobLog: BlobLog | null = null;
  private listeners: Map<S3EventType, Set<S3EventCallback>> = new Map();

  constructor(path?: string) {
    if (path) {
      this.wal = new WAL(path);
      this.blobLog = new BlobLog(path + "-blobs");
      this.wal.open(this.objects);
    }
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
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) cb(bucket, key);
    }
  }

  put(
    bucket: string,
    key: string,
    data: Uint8Array,
    contentType?: string,
    contentDisposition?: string,
    expires?: number,
  ): void {
    const etag = computeETag(data);
    const lastModified = new Date();
    const resolvedType = contentType ?? guessMimeType(key);
    const expiresAt = expires ? Date.now() + expires * 1000 : undefined;

    if (this.blobLog) {
      // Mark old blob data as dead if overwriting
      const existing = this.objects.get(bucket)?.get(key);
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
      this.setInMap(bucket, key, null, resolvedType, etag, lastModified, contentDisposition, expiresAt, offset, length);

      if (this.wal!.shouldCheckpoint() || this.blobLog.shouldCompact()) {
        this.compactAndCheckpoint();
      }
    } else {
      // In-memory mode
      this.setInMap(bucket, key, data, resolvedType, etag, lastModified, contentDisposition, expiresAt);
    }

    this.emit("put", bucket, key);
  }

  private setInMap(
    bucket: string,
    key: string,
    data: Uint8Array | null,
    contentType: string,
    etag: string,
    lastModified: Date,
    contentDisposition?: string,
    expiresAt?: number,
    blobOffset?: number,
    blobLength?: number,
  ): void {
    let bucketMap = this.objects.get(bucket);
    if (!bucketMap) {
      bucketMap = new Map();
      this.objects.set(bucket, bucketMap);
    }
    bucketMap.set(key, {
      data,
      size: blobLength ?? data?.byteLength ?? 0,
      etag,
      contentType,
      lastModified,
      contentDisposition,
      expiresAt,
      blobOffset,
      blobLength,
    });
  }

  private isExpired(obj: StoredObject): boolean {
    return obj.expiresAt !== undefined && Date.now() > obj.expiresAt;
  }

  private getObject(bucket: string, key: string): StoredObject | undefined {
    const obj = this.objects.get(bucket)?.get(key);
    if (!obj) return undefined;
    if (this.isExpired(obj)) {
      this.delete(bucket, key);
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

  delete(bucket: string, key: string): boolean {
    const bucketMap = this.objects.get(bucket);
    if (!bucketMap) return false;
    const obj = bucketMap.get(key);
    const existed = bucketMap.delete(key);
    if (existed) {
      if (this.blobLog && obj?.blobLength) {
        this.blobLog.markDead(obj.blobLength);
      }
      if (this.wal) this.wal.appendDelete(bucket, key);
      if (bucketMap.size === 0) this.objects.delete(bucket);
      this.emit("delete", bucket, key);
    }
    return existed;
  }

  exists(bucket: string, key: string): boolean {
    const obj = this.objects.get(bucket)?.get(key);
    if (!obj) return false;
    if (this.isExpired(obj!)) {
      this.delete(bucket, key);
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
    const obj = this.getObject(srcBucket, srcKey);
    if (!obj) return false;

    const data = this.loadData(obj);

    if (this.blobLog) {
      const { offset, length } = this.blobLog.append(data);
      const metadata: Record<string, unknown> = {
        contentType: obj.contentType,
        etag: obj.etag,
        lastModified: new Date().toISOString(),
        blobOffset: offset,
        blobLength: length,
      };
      if (obj.contentDisposition) metadata.contentDisposition = obj.contentDisposition;
      if (obj.expiresAt) metadata.expiresAt = obj.expiresAt;

      this.wal!.appendPut(destBucket, destKey, null, metadata);
      this.setInMap(destBucket, destKey, null, obj.contentType, obj.etag, new Date(), obj.contentDisposition, obj.expiresAt, offset, length);
    } else {
      this.setInMap(destBucket, destKey, data.slice(), obj.contentType, obj.etag, new Date(), obj.contentDisposition, obj.expiresAt);
    }

    this.emit("copy", srcBucket, srcKey);
    return true;
  }

  list(
    bucket: string,
    opts?: S3ListObjectsOptions,
  ): S3ListObjectsResponse {
    const prefix = opts?.prefix ?? "";
    const delimiter = opts?.delimiter;
    const maxKeys = opts?.maxKeys ?? 1000;
    const startAfter = opts?.startAfter;

    const bucketMap = this.objects.get(bucket);
    const allKeys: string[] = [];

    if (bucketMap) {
      for (const [key, obj] of bucketMap) {
        if (key.startsWith(prefix)) {
          if (this.isExpired(obj)) {
            this.delete(bucket, key);
            continue;
          }
          allKeys.push(key);
        }
      }
    }

    allKeys.sort();

    // Filter by startAfter
    let filteredKeys = startAfter
      ? allKeys.filter((k) => k > startAfter)
      : allKeys;

    const commonPrefixSet = new Set<string>();
    const contents: S3ListObjectsResponse["contents"] = [];

    for (const key of filteredKeys) {
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const delimIdx = rest.indexOf(delimiter);
        if (delimIdx !== -1) {
          commonPrefixSet.add(prefix + rest.slice(0, delimIdx + delimiter.length));
          continue;
        }
      }
      contents.push({
        key,
        eTag: bucketMap!.get(key)!.etag,
        lastModified: bucketMap!.get(key)!.lastModified.toISOString(),
        size: bucketMap!.get(key)!.size,
      });
    }

    // Apply maxKeys to contents + commonPrefixes combined
    const totalItems = contents.length + commonPrefixSet.size;
    const isTruncated = totalItems > maxKeys;

    // Truncate contents if needed
    const truncatedContents = contents.slice(0, maxKeys);

    const commonPrefixes = [...commonPrefixSet]
      .sort()
      .map((p) => ({ prefix: p }));

    const response: S3ListObjectsResponse = {
      contents: truncatedContents.length > 0 ? truncatedContents : undefined,
      commonPrefixes: commonPrefixes.length > 0 ? commonPrefixes : undefined,
      isTruncated,
      keyCount: truncatedContents.length,
      maxKeys,
      prefix: prefix || undefined,
      delimiter,
      name: bucket,
    };

    if (isTruncated && truncatedContents.length > 0) {
      const lastKey = truncatedContents[truncatedContents.length - 1]!.key;
      response.nextContinuationToken = lastKey;
    }

    return response;
  }

  private compactAndCheckpoint(): void {
    if (!this.blobLog || !this.wal) return;

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

  checkpoint(): void {
    if (this.blobLog) {
      this.compactAndCheckpoint();
    } else if (this.wal) {
      this.wal.checkpoint(this.objects);
    }
  }

  close(): void {
    if (this.blobLog) {
      this.compactAndCheckpoint();
      this.blobLog.close();
    } else if (this.wal) {
      this.wal.close(this.objects);
    }
  }
}
