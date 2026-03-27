import type {
  S3Options,
  S3FilePresignOptions,
  S3Stats,
  S3ListObjectsOptions,
  S3ListObjectsResponse,
  S3EventType,
  S3EventCallback,
} from "./types";
import { Store } from "./store";
import { S3File } from "./file";

export class S3Client {
  private store: Store;
  readonly defaultBucket: string;
  private opts: S3Options;

  constructor(options?: S3Options) {
    this.opts = options ?? {};
    this.defaultBucket = options?.bucket ?? "default";
    this.store = new Store(options?.path);
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

  async delete(path: string, options?: S3Options): Promise<void> {
    const f = this.file(path, options);
    return f.delete();
  }

  unlink = this.delete.bind(this);

  presign(path: string, options?: S3FilePresignOptions): string {
    const f = this.file(path, options);
    return f.presign(options);
  }

  async size(path: string, options?: S3Options): Promise<number> {
    const s = await this.file(path, options).stat();
    return s.size;
  }

  async exists(path: string, options?: S3Options): Promise<boolean> {
    return this.file(path, options).exists();
  }

  async stat(path: string, options?: S3Options): Promise<S3Stats> {
    return this.file(path, options).stat();
  }

  async list(
    input?: S3ListObjectsOptions | null,
    options?: S3Options,
  ): Promise<S3ListObjectsResponse> {
    const bucket = options?.bucket ?? this.defaultBucket;
    return this.store.list(bucket, input ?? undefined);
  }

  async copy(
    srcPath: string,
    destPath: string,
    options?: S3Options & { srcBucket?: string; destBucket?: string },
  ): Promise<boolean> {
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

  checkpoint(): void {
    this.store.checkpoint();
  }

  close(): void {
    this.store.close();
  }
}
