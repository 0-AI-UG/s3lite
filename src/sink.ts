import type { S3Options } from "./types";
import type { Store } from "./store";
import { normalizeToBytes, concatUint8Arrays } from "./utils";

export class NetworkSink {
  private store: Store;
  private bucket: string;
  private key: string;
  private opts: S3Options;
  private chunks: Uint8Array[] = [];

  constructor(store: Store, bucket: string, key: string, opts: S3Options = {}) {
    this.store = store;
    this.bucket = bucket;
    this.key = key;
    this.opts = opts;
  }

  write(
    chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
  ): number {
    let bytes: Uint8Array;
    if (typeof chunk === "string") {
      bytes = new TextEncoder().encode(chunk);
    } else if (chunk instanceof Uint8Array) {
      bytes = chunk;
    } else if (ArrayBuffer.isView(chunk)) {
      bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      bytes = new Uint8Array(chunk);
    }
    this.chunks.push(bytes);
    return bytes.byteLength;
  }

  flush(): number {
    return 0;
  }

  async end(): Promise<number> {
    const data = concatUint8Arrays(this.chunks);
    this.store.put(
      this.bucket,
      this.key,
      data,
      this.opts.type,
      this.opts.contentDisposition,
      this.opts.expires,
    );
    const size = data.byteLength;
    this.chunks = [];
    return size;
  }

  start(options?: { highWaterMark?: number }): void {
    // no-op
  }

  ref(): void {
    // no-op
  }

  unref(): void {
    // no-op
  }

  async stat() {
    const s = this.store.stat(this.bucket, this.key);
    if (!s) throw new Error(`File not found: ${this.bucket}/${this.key}`);
    return s;
  }
}
