export interface StoredObject {
  data: Uint8Array;
  size: number;
  etag: string;
  contentType: string;
  lastModified: Date;
  contentDisposition?: string;
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
}

export const MAGIC = new Uint8Array([0x53, 0x33, 0x4c, 0x54]); // "S3LT"
export const FORMAT_VERSION = 1;
