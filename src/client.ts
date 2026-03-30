import type {
  S3Options,
  S3FilePresignOptions,
  S3Stats,
  S3ListObjectsOptions,
  S3ListObjectsResponse,
  S3EventType,
  S3EventCallback,
} from "./types";
import { Store, TransactionContext } from "./store";
import { S3File } from "./file";

export class S3Client {
  private store: Store;
  readonly defaultBucket: string;
  private opts: S3Options;

  constructor(options?: S3Options) {
    this.opts = options ?? {};
    this.defaultBucket = options?.bucket ?? "default";
    this.store = new Store(options?.path, options?.syncMode, options?.indexMode);
  }

  file(path: string, options?: S3Options): S3File {
    const bucket = options?.bucket ?? this.defaultBucket;
    return new S3File(this.store, bucket, path, {
      ...this.opts,
      ...options,
    });
  }

  async write(
    path: string,
    data:
      | string
      | ArrayBufferView
      | ArrayBuffer
      | SharedArrayBuffer
      | Blob
      | Response
      | Request,
    options?: S3Options,
  ): Promise<number> {
    const f = this.file(path, options);
    return f.write(data, options);
  }

  delete(path: string, options?: S3Options): void {
    const f = this.file(path, options);
    f.delete();
  }

  unlink = this.delete.bind(this);

  presign(path: string, options?: S3FilePresignOptions): string {
    const f = this.file(path, options);
    return f.presign(options);
  }

  size(path: string, options?: S3Options): number {
    const s = this.file(path, options).stat();
    return s.size;
  }

  exists(path: string, options?: S3Options): boolean {
    return this.file(path, options).exists();
  }

  stat(path: string, options?: S3Options): S3Stats {
    return this.file(path, options).stat();
  }

  list(
    input?: S3ListObjectsOptions | null,
    options?: S3Options,
  ): S3ListObjectsResponse {
    const bucket = options?.bucket ?? this.defaultBucket;
    return this.store.list(bucket, input ?? undefined);
  }

  copy(
    srcPath: string,
    destPath: string,
    options?: S3Options & { srcBucket?: string; destBucket?: string },
  ): boolean {
    const srcBucket = options?.srcBucket ?? options?.bucket ?? this.defaultBucket;
    const destBucket = options?.destBucket ?? options?.bucket ?? this.defaultBucket;
    return this.store.copy(srcBucket, srcPath, destBucket, destPath);
  }

  on(event: S3EventType, callback: S3EventCallback): void {
    this.store.on(event, callback);
  }

  off(event: S3EventType, callback: S3EventCallback): void {
    this.store.off(event, callback);
  }

  transaction(fn: (txn: TransactionContext) => void): void {
    this.store.transaction(fn);
  }

  checkpoint(): void {
    this.store.checkpoint();
  }

  close(): void {
    this.store.close();
  }
}
