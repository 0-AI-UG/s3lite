import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export interface FileLockOptions {
  /** If set, treat a lock file older than this many ms as stale regardless of holder identity. */
  staleAfterMs?: number;
}

interface LockPayload {
  pid: number;
  hostname: string;
  startTime: string | null;
  createdAt: number;
}

export class FileLock {
  private lockPath: string;
  private fd: number | null = null;
  private staleAfterMs?: number;

  constructor(path: string, options: FileLockOptions = {}) {
    this.lockPath = path + ".lock";
    this.staleAfterMs = options.staleAfterMs;
  }

  acquire(): void {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.fd = openSync(this.lockPath, "wx");
        const payload: LockPayload = {
          pid: process.pid,
          hostname: hostname(),
          startTime: getProcessStartTime(process.pid),
          createdAt: Date.now(),
        };
        writeFileSync(this.fd, JSON.stringify(payload));
        return;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

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
    let content: string;
    try {
      content = readFileSync(this.lockPath, "utf-8").trim();
    } catch {
      return false;
    }

    // Age-based escape hatch
    if (this.staleAfterMs !== undefined) {
      try {
        const age = Date.now() - statSync(this.lockPath).mtimeMs;
        if (age > this.staleAfterMs) return false;
      } catch {
        return false;
      }
    }

    const payload = parsePayload(content);
    if (!payload) return false;

    // Different host sharing the same volume → prior holder is not on this machine,
    // so its PID namespace is unrelated. Treat as stale.
    if (payload.hostname && payload.hostname !== hostname()) return false;

    try {
      process.kill(payload.pid, 0);
    } catch {
      return false;
    }

    // PID is alive — verify it's the same process via start-time fingerprint.
    // If we can't obtain a start time on either side, fall back to PID-only
    // (best we can do on platforms without a cheap syscall).
    if (payload.startTime) {
      const currentStart = getProcessStartTime(payload.pid);
      if (currentStart && currentStart !== payload.startTime) {
        // PID was reused — holder is a different process now.
        return false;
      }
    }

    return true;
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
      if (existsSync(this.lockPath)) {
        const payload = parsePayload(readFileSync(this.lockPath, "utf-8").trim());
        if (payload && payload.pid === process.pid && payload.hostname === hostname()) {
          unlinkSync(this.lockPath);
        }
      }
    } catch {
      // best effort
    }
  }

  /**
   * Forcibly remove a lock file for the given database path. Use when a crashed
   * holder couldn't be detected automatically. Caller is responsible for ensuring
   * no live holder exists.
   */
  static breakLock(path: string): boolean {
    const lockPath = path + ".lock";
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

function parsePayload(content: string): LockPayload | null {
  if (!content) return null;
  // JSON format (current)
  if (content.startsWith("{")) {
    try {
      const obj = JSON.parse(content);
      if (typeof obj.pid !== "number") return null;
      return {
        pid: obj.pid,
        hostname: typeof obj.hostname === "string" ? obj.hostname : "",
        startTime: typeof obj.startTime === "string" ? obj.startTime : null,
        createdAt: typeof obj.createdAt === "number" ? obj.createdAt : 0,
      };
    } catch {
      return null;
    }
  }
  // Legacy bare-PID format
  const pid = parseInt(content, 10);
  if (isNaN(pid)) return null;
  return { pid, hostname: "", startTime: null, createdAt: 0 };
}

function getProcessStartTime(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Field 22 (starttime). Field 2 (comm) may contain spaces/parens, so split on ')'.
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) return null;
      const fields = stat.slice(rparen + 2).split(" ");
      // After comm: state(1) ppid(2) ... starttime is field 22 overall → index 19 here (0-based).
      const starttime = fields[19];
      return starttime ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const trimmed = out.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }
  return null;
}
