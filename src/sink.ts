import type { S3Options } from "./types";
import type { Store, StorePutSession } from "./store";
import { concatUint8Arrays } from "./utils";

export class NetworkSink {
  private store: Store;
  private bucket: string;
  private key: string;
  private opts: S3Options;

  // Streaming path: a sync session that writes each chunk straight to disk.
  private session: StorePutSession | null = null;

  // Buffered fallback for in-memory stores (which have no blob log).
  private chunks: Uint8Array[] | null;

  private bytesWritten = 0;
  private readonly streaming: boolean;

  constructor(store: Store, bucket: string, key: string, opts: S3Options = {}) {
    this.store = store;
    this.bucket = bucket;
    this.key = key;
    this.opts = opts;
    this.streaming = store.supportsStreaming;
    this.chunks = this.streaming ? null : [];
  }

  private ensureSession(): StorePutSession {
    if (!this.session) {
      this.session = this.store.beginPutSync(this.bucket, this.key);
    }
    return this.session;
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

    if (this.streaming) {
      this.ensureSession().write(bytes);
    } else {
      this.chunks!.push(bytes);
    }
    this.bytesWritten += bytes.byteLength;
    return bytes.byteLength;
  }

  flush(): number {
    return 0;
  }

  async end(): Promise<number> {
    if (this.streaming) {
      const session = this.ensureSession();
      const result = session.end({
        contentType: this.opts.type,
        contentDisposition: this.opts.contentDisposition,
        expires: this.opts.expires,
      });
      this.session = null;
      const written = this.bytesWritten;
      this.bytesWritten = 0;
      return result.size || written;
    }

    const data = concatUint8Arrays(this.chunks!);
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
    this.bytesWritten = 0;
    return size;
  }

  start(_options?: { highWaterMark?: number }): void {
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
