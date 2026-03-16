import type {
  StoredObject,
  S3ListObjectsOptions,
  S3ListObjectsResponse,
  S3Stats,
} from "./types";
import { WAL } from "./wal";
import { computeETag, guessMimeType } from "./utils";

export class Store {
  private objects: Map<string, Map<string, StoredObject>> = new Map();
  private wal: WAL | null = null;

  constructor(path?: string) {
    if (path) {
      this.wal = new WAL(path);
      this.wal.open(this.objects);
    }
  }

  put(
    bucket: string,
    key: string,
    data: Uint8Array,
    contentType?: string,
    contentDisposition?: string,
  ): void {
    const etag = computeETag(data);
    const lastModified = new Date();
    const resolvedType = contentType ?? guessMimeType(key);

    const metadata: Record<string, unknown> = {
      contentType: resolvedType,
      etag,
      lastModified: lastModified.toISOString(),
    };
    if (contentDisposition) metadata.contentDisposition = contentDisposition;

    if (this.wal) {
      this.wal.appendPut(bucket, key, data, metadata);
      if (this.wal.shouldCheckpoint()) {
        // Update map first, then checkpoint
        this.setInMap(bucket, key, data, resolvedType, etag, lastModified, contentDisposition);
        this.wal.checkpoint(this.objects);
        return;
      }
    }

    this.setInMap(bucket, key, data, resolvedType, etag, lastModified, contentDisposition);
  }

  private setInMap(
    bucket: string,
    key: string,
    data: Uint8Array,
    contentType: string,
    etag: string,
    lastModified: Date,
    contentDisposition?: string,
  ): void {
    let bucketMap = this.objects.get(bucket);
    if (!bucketMap) {
      bucketMap = new Map();
      this.objects.set(bucket, bucketMap);
    }
    bucketMap.set(key, {
      data,
      size: data.byteLength,
      etag,
      contentType,
      lastModified,
      contentDisposition,
    });
  }

  get(bucket: string, key: string): StoredObject | undefined {
    return this.objects.get(bucket)?.get(key);
  }

  getRange(
    bucket: string,
    key: string,
    start: number,
    end: number,
  ): Uint8Array | undefined {
    const obj = this.get(bucket, key);
    if (!obj) return undefined;
    return obj.data.slice(start, end);
  }

  delete(bucket: string, key: string): boolean {
    const bucketMap = this.objects.get(bucket);
    if (!bucketMap) return false;
    const existed = bucketMap.delete(key);
    if (existed) {
      if (this.wal) this.wal.appendDelete(bucket, key);
      if (bucketMap.size === 0) this.objects.delete(bucket);
    }
    return existed;
  }

  exists(bucket: string, key: string): boolean {
    return this.objects.get(bucket)?.has(key) ?? false;
  }

  stat(bucket: string, key: string): S3Stats | undefined {
    const obj = this.get(bucket, key);
    if (!obj) return undefined;
    return {
      size: obj.size,
      lastModified: obj.lastModified,
      etag: obj.etag,
      type: obj.contentType,
    };
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
      for (const key of bucketMap.keys()) {
        if (key.startsWith(prefix)) {
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
      const lastKey = truncatedContents[truncatedContents.length - 1].key;
      response.nextContinuationToken = lastKey;
    }

    return response;
  }

  checkpoint(): void {
    if (this.wal) this.wal.checkpoint(this.objects);
  }

  close(): void {
    if (this.wal) this.wal.close(this.objects);
  }
}
