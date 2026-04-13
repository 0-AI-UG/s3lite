import type { S3Options, S3FilePresignOptions, S3Stats } from "./types";
import type { Store } from "./store";
import { NetworkSink } from "./sink";
import { normalizeToBytes, guessMimeType } from "./utils";

export class S3File extends Blob {
  readonly name: string;
  readonly bucket: string;
  private store: Store;
  private rangeStart?: number;
  private rangeEnd?: number;
  private opts: S3Options;

  constructor(
    store: Store,
    bucket: string,
    key: string,
    opts: S3Options = {},
  ) {
    super();
    this.store = store;
    this.bucket = bucket;
    this.name = key;
    this.opts = opts;
  }

  private getData(): Uint8Array<ArrayBuffer> {
    if (this.rangeStart !== undefined || this.rangeEnd !== undefined) {
      const data = this.store.getRange(
        this.bucket,
        this.name,
        this.rangeStart ?? 0,
        this.rangeEnd ?? Infinity,
      );
      if (!data) throw new Error(`S3File not found: ${this.bucket}/${this.name}`);
      return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    }
    const obj = this.store.get(this.bucket, this.name);
    if (!obj || !obj.data) throw new Error(`S3File not found: ${this.bucket}/${this.name}`);
    return new Uint8Array(obj.data.buffer as ArrayBuffer, obj.data.byteOffset, obj.data.byteLength);
  }

  override get size(): number {
    const s = this.store.stat(this.bucket, this.name);
    return s?.size ?? 0;
  }

  override get type(): string {
    const s = this.store.stat(this.bucket, this.name);
    return s?.type ?? this.opts.type ?? guessMimeType(this.name);
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(this.getData());
  }

  override async json(): Promise<unknown> {
    const text = await this.text();
    return JSON.parse(text);
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return this.getData();
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const data = this.getData();
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const data = this.getData();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  override slice(begin?: number, end?: number, contentType?: string): S3File {
    const file = new S3File(
      this.store,
      this.bucket,
      this.name,
      { ...this.opts, type: contentType ?? this.opts.type },
    );
    file.rangeStart = begin ?? 0;
    file.rangeEnd = end;
    return file;
  }

  async write(
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
    const bytes = await normalizeToBytes(data as Parameters<typeof normalizeToBytes>[0]);
    const contentType = options?.type ?? this.opts.type;
    const contentDisposition = options?.contentDisposition ?? this.opts.contentDisposition;
    const expires = options?.expires ?? this.opts.expires;
    this.store.put(this.bucket, this.name, bytes, contentType, contentDisposition, expires);
    return bytes.byteLength;
  }

  readStream(chunkSize?: number): ReadableStream<Uint8Array> {
    const stream = this.store.getReadStream(this.bucket, this.name, chunkSize);
    if (!stream) throw new Error(`S3File not found: ${this.bucket}/${this.name}`);
    return stream;
  }

  async writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: S3Options,
  ): Promise<number> {
    const contentType = options?.type ?? this.opts.type;
    const contentDisposition = options?.contentDisposition ?? this.opts.contentDisposition;
    const expires = options?.expires ?? this.opts.expires;
    const result = await this.store.putStream(this.bucket, this.name, stream, contentType, contentDisposition, expires);
    return result.size;
  }

  exists(): boolean {
    return this.store.exists(this.bucket, this.name);
  }

  stat(): S3Stats {
    const s = this.store.stat(this.bucket, this.name);
    if (!s) throw new Error(`S3File not found: ${this.bucket}/${this.name}`);
    return s;
  }

  delete(): void {
    this.store.delete(this.bucket, this.name);
  }

  unlink = this.delete.bind(this);

  presign(_options?: S3FilePresignOptions): string {
    throw new Error(
      "presign() is not supported directly on S3File in s3lite. Use PresignHandler.presign() instead.",
    );
  }

  writer(options?: S3Options): NetworkSink {
    return new NetworkSink(this.store, this.bucket, this.name, {
      ...this.opts,
      ...options,
    });
  }
}
