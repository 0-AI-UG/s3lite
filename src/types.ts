export interface StoredObject {
  data: Uint8Array | null;
  size: number;
  etag: string;
  contentType: string;
  lastModified: Date;
  contentDisposition?: string;
  expiresAt?: number;
  blobOffset?: number;
  blobLength?: number;
}

export class ReadonlyError extends Error {
  constructor(operation: string) {
    super(`Cannot ${operation} on a read-only database`);
    this.name = "ReadonlyError";
  }
}

export interface S3Options {
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  type?: string;
  contentDisposition?: string;
  acl?: string;
  partSize?: number;
  queueSize?: number;
  retry?: number;
  highWaterMark?: number;
  storageClass?: string;
  requestPayer?: boolean;
  virtualHostedStyle?: boolean;
  /** Path to the .s3db file on disk. If omitted, pure in-memory. */
  path?: string;
  /** TTL in seconds. Object auto-expires after this duration. */
  expires?: number;
  /** Controls fsync behavior. "full" syncs every write, "normal" syncs at checkpoint, "off" never syncs (default: "normal") */
  syncMode?: "full" | "normal" | "off";
  /** Index mode. "memory" loads all keys in RAM (fast, limited scale). "disk" uses sparse disk index (millions of keys, lower RAM). Default: "memory" */
  indexMode?: "memory" | "disk";
  /** Open in read-only mode. No file lock is acquired and all write operations throw. Multiple readers can coexist with a writer. */
  readonly?: boolean;
}

export interface S3FilePresignOptions extends S3Options {
  expiresIn?: number;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
}

export interface S3Stats {
  size: number;
  lastModified: Date;
  etag: string;
  type: string;
}

export interface S3ListObjectsOptions {
  prefix?: string;
  continuationToken?: string;
  delimiter?: string;
  maxKeys?: number;
  startAfter?: string;
  encodingType?: "url";
  fetchOwner?: boolean;
}

export interface S3ListObjectsResponse {
  commonPrefixes?: { prefix: string }[];
  contents?: {
    eTag?: string;
    key: string;
    lastModified?: string;
    size?: number;
  }[];
  continuationToken?: string;
  delimiter?: string;
  encodingType?: "url";
  isTruncated?: boolean;
  keyCount?: number;
  maxKeys?: number;
  name?: string;
  nextContinuationToken?: string;
  prefix?: string;
  startAfter?: string;
}

export const enum WalOp {
  PUT = 1,
  DELETE = 2,
  TXN_BEGIN = 3,
  TXN_COMMIT = 4,
}

export const MAGIC = new Uint8Array([0x53, 0x33, 0x4c, 0x54]); // "S3LT"
export const FORMAT_VERSION = 1;

export type S3EventType = "put" | "delete" | "copy";
export type S3EventCallback = (bucket: string, key: string) => void;
