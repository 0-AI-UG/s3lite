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
} from "node:fs";
import { writeFileSync } from "node:fs";

type SyncMode = "full" | "normal" | "off";

export class BlobLog {
  private path: string;
  private fd: number;
  private currentSize: number;
  private deadBytes = 0;
  private syncMode: SyncMode;

  constructor(path: string, syncMode: SyncMode = "normal") {
    this.path = path;
    this.syncMode = syncMode;
    const exists = existsSync(path);
    this.fd = openSync(path, exists ? "r+" : "w+");
    this.currentSize = exists ? fstatSync(this.fd).size : 0;
  }

  append(data: Uint8Array): { offset: number; length: number } {
    const offset = this.currentSize;
    writeSync(this.fd, data, 0, data.byteLength, offset);
    this.currentSize += data.byteLength;
    if (this.syncMode === "full") {
      fsyncSync(this.fd);
    }
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

  close(): void {
    closeSync(this.fd);
  }
}
