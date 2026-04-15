import { dirname } from "node:path";
import {
  existsSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  renameSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
} from "node:fs";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ReadonlyError } from "./types";

type SyncMode = "full" | "normal" | "off";

export class BlobLog {
  private path: string;
  private fd: number;
  private currentSize: number;
  private deadBytes = 0;
  private syncMode: SyncMode;
  private readOnly: boolean;

  constructor(path: string, syncMode: SyncMode = "normal", readOnly = false) {
    this.path = path;
    this.syncMode = syncMode;
    this.readOnly = readOnly;
    const exists = existsSync(path);
    if (readOnly) {
      if (exists) {
        this.fd = openSync(path, "r");
        this.currentSize = fstatSync(this.fd).size;
      } else {
        this.fd = -1;
        this.currentSize = 0;
      }
    } else {
      this.fd = openSync(path, exists ? "r+" : "w+");
      this.currentSize = exists ? fstatSync(this.fd).size : 0;
    }
  }

  append(data: Uint8Array): { offset: number; length: number } {
    if (this.readOnly) throw new ReadonlyError("write");
    const offset = this.currentSize;
    writeSync(this.fd, data, 0, data.byteLength, offset);
    this.currentSize += data.byteLength;
    if (this.syncMode === "full") {
      fsyncSync(this.fd);
    }
    return { offset, length: data.byteLength };
  }

  read(offset: number, length: number): Uint8Array {
    if (this.fd === -1) throw new Error("Object has no data and no blob reference");
    const buf = Buffer.alloc(length);
    readSync(this.fd, buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readRange(
    blobOffset: number,
    blobLength: number,
    rangeStart: number,
    rangeEnd: number,
  ): Uint8Array {
    const effectiveEnd = Math.min(rangeEnd, blobLength);
    const readLen = effectiveEnd - rangeStart;
    if (readLen <= 0) return new Uint8Array(0);
    return this.read(blobOffset + rangeStart, readLen);
  }

  markDead(length: number): void {
    if (this.readOnly) throw new ReadonlyError("write");
    this.deadBytes += length;
  }

  shouldCompact(): boolean {
    return this.currentSize > 0 && this.deadBytes / this.currentSize > 0.5;
  }

  compact(
    liveEntries: { oldOffset: number; length: number }[],
  ): Map<number, number> {
    if (this.readOnly) throw new ReadonlyError("compact");
    if (liveEntries.length === 0) {
      closeSync(this.fd);
      writeFileSync(this.path, new Uint8Array(0));
      this.fd = openSync(this.path, "r+");
      this.currentSize = 0;
      this.deadBytes = 0;
      return new Map();
    }

    liveEntries.sort((a, b) => a.oldOffset - b.oldOffset);

    const newPath = this.path + ".compact";
    const newFd = openSync(newPath, "w");
    const offsetMap = new Map<number, number>();
    let newOffset = 0;

    for (const entry of liveEntries) {
      const data = this.read(entry.oldOffset, entry.length);
      writeSync(newFd, data, 0, data.byteLength, newOffset);
      offsetMap.set(entry.oldOffset, newOffset);
      newOffset += data.byteLength;
    }

    fsyncSync(newFd);
    closeSync(newFd);
    closeSync(this.fd);
    renameSync(newPath, this.path);

    // Ensure rename is durable
    if (this.syncMode !== "off") {
      try {
        const dirPath = dirname(this.path);
        const dirFd = openSync(dirPath, "r");
        fsyncSync(dirFd);
        closeSync(dirFd);
      } catch {
        // Directory fsync may not be supported on all platforms
      }
    }

    this.fd = openSync(this.path, "r+");
    this.currentSize = newOffset;
    this.deadBytes = 0;

    return offsetMap;
  }

  /** Returns the current file descriptor (may change after compaction). */
  get activeFd(): number {
    return this.fd;
  }

  createReadStream(offset: number, length: number, chunkSize = 65536): ReadableStream<Uint8Array> {
    if (this.fd === -1) throw new Error("Object has no data and no blob reference");
    const blob = this;
    let bytesRead = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          const remaining = length - bytesRead;
          if (remaining <= 0) {
            controller.close();
            return;
          }
          const toRead = Math.min(chunkSize, remaining);
          const buf = Buffer.alloc(toRead);
          readSync(blob.activeFd, buf, 0, toRead, offset + bytesRead);
          bytesRead += toRead;
          controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          if (bytesRead >= length) controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  /**
   * Begin a synchronous chunked append. Callers write chunks via the returned
   * session as they arrive (no buffering), then call `finish()` to get the
   * final offset/length/etag. This is the path used by NetworkSink so that a
   * synchronous `write()` API still flushes each chunk to disk immediately.
   */
  beginAppendSync(): BlobAppendSession {
    if (this.readOnly) throw new ReadonlyError("write");
    return new BlobAppendSession(this, this.fd, this.currentSize, this.syncMode);
  }

  /** @internal */
  _commitAppend(newSize: number): void {
    this.currentSize = newSize;
  }

  appendStream(stream: ReadableStream<Uint8Array>): Promise<{ offset: number; length: number; etag: string }> {
    if (this.readOnly) throw new ReadonlyError("write");
    const fd = this.fd;
    const startOffset = this.currentSize;
    let written = 0;
    const hash = createHash("md5");
    const syncMode = this.syncMode;
    const self = this;

    return (async () => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength === 0) continue;
          try {
            writeSync(fd, value, 0, value.byteLength, startOffset + written);
          } catch (err) {
            // Truncate back to last successful write to avoid orphaned partial data
            try { ftruncateSync(fd, startOffset + written); } catch {}
            self.currentSize = startOffset + written;
            throw err;
          }
          hash.update(value);
          written += value.byteLength;
          self.currentSize = startOffset + written;
        }
      } finally {
        reader.releaseLock();
      }
      if (syncMode === "full") {
        fsyncSync(fd);
      }
      return { offset: startOffset, length: written, etag: `"${hash.digest("hex")}"` };
    })();
  }

  close(): void {
    if (this.fd !== -1) closeSync(this.fd);
  }
}

/**
 * A synchronous chunked append session. Writes each chunk directly to the
 * blob file descriptor as it arrives. Holds no buffered copies.
 */
export class BlobAppendSession {
  private blob: BlobLog;
  private fd: number;
  private readonly startOffset: number;
  private written = 0;
  private hash = createHash("md5");
  private syncMode: SyncMode;
  private finished = false;

  constructor(blob: BlobLog, fd: number, startOffset: number, syncMode: SyncMode) {
    this.blob = blob;
    this.fd = fd;
    this.startOffset = startOffset;
    this.syncMode = syncMode;
  }

  write(chunk: Uint8Array): void {
    if (this.finished) throw new Error("BlobAppendSession: write after finish()");
    if (chunk.byteLength === 0) return;
    try {
      writeSync(this.fd, chunk, 0, chunk.byteLength, this.startOffset + this.written);
    } catch (err) {
      try { ftruncateSync(this.fd, this.startOffset + this.written); } catch {}
      this.blob._commitAppend(this.startOffset + this.written);
      this.finished = true;
      throw err;
    }
    this.hash.update(chunk);
    this.written += chunk.byteLength;
    this.blob._commitAppend(this.startOffset + this.written);
  }

  finish(): { offset: number; length: number; etag: string } {
    if (this.finished) throw new Error("BlobAppendSession: already finished");
    this.finished = true;
    if (this.syncMode === "full") fsyncSync(this.fd);
    return {
      offset: this.startOffset,
      length: this.written,
      etag: `"${this.hash.digest("hex")}"`,
    };
  }
}
