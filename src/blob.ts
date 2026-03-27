import {
  existsSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  renameSync,
  fstatSync,
  fsyncSync,
} from "node:fs";
import { writeFileSync } from "node:fs";

export class BlobLog {
  private path: string;
  private fd: number;
  private currentSize: number;
  private deadBytes = 0;

  constructor(path: string) {
    this.path = path;
    const exists = existsSync(path);
    this.fd = openSync(path, exists ? "r+" : "w+");
    this.currentSize = exists ? fstatSync(this.fd).size : 0;
  }

  append(data: Uint8Array): { offset: number; length: number } {
    const offset = this.currentSize;
    writeSync(this.fd, data, 0, data.byteLength, offset);
    this.currentSize += data.byteLength;
    return { offset, length: data.byteLength };
  }

  read(offset: number, length: number): Uint8Array {
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
    this.deadBytes += length;
  }

  shouldCompact(): boolean {
    return this.currentSize > 0 && this.deadBytes / this.currentSize > 0.5;
  }

  compact(
    liveEntries: { oldOffset: number; length: number }[],
  ): Map<number, number> {
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

    this.fd = openSync(this.path, "r+");
    this.currentSize = newOffset;
    this.deadBytes = 0;

    return offsetMap;
  }

  close(): void {
    closeSync(this.fd);
  }
}
