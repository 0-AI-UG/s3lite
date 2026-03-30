import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";

export class FileLock {
  private lockPath: string;
  private fd: number | null = null;

  constructor(path: string) {
    this.lockPath = path + ".lock";
  }

  acquire(): void {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.fd = openSync(this.lockPath, "wx");
        writeFileSync(this.fd, String(process.pid));
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        // Lock file exists — check if the holder is still alive
        if (!this.isHolderAlive()) {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Race with another process cleaning up — retry
          }
          continue;
        }

        throw new Error(
          `Database is locked by another process: ${this.lockPath.replace(/\.lock$/, "")}`,
        );
      }
    }

    throw new Error(
      `Database is locked by another process: ${this.lockPath.replace(/\.lock$/, "")}`,
    );
  }

  private isHolderAlive(): boolean {
    try {
      const pid = parseInt(readFileSync(this.lockPath, "utf-8").trim(), 10);
      if (isNaN(pid)) return false;
      process.kill(pid, 0); // signal 0 = check if process exists
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
    try {
      // Only unlink if we own it (contains our PID)
      if (existsSync(this.lockPath)) {
        const content = readFileSync(this.lockPath, "utf-8").trim();
        if (content === String(process.pid)) {
          unlinkSync(this.lockPath);
        }
      }
    } catch {
      // best effort
    }
  }
}
