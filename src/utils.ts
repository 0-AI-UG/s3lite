const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

export function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filename.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function computeETag(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(data);
  return `"${hasher.digest("hex")}"`;
}

export async function normalizeToBytes(
  data:
    | string
    | ArrayBufferView
    | ArrayBuffer
    | SharedArrayBuffer
    | Blob
    | Response
    | Request,
): Promise<Uint8Array> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Response || data instanceof Request) {
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf);
  }
  if (data instanceof Blob) {
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(`Unsupported data type: ${typeof data}`);
}

export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}

// CRC32 implementation
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
